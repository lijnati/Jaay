#!/usr/bin/env bash
# Spike S1: starts a throwaway regtest stack in WSL, sets up Alby Hub headless, creates a
# receive-only NWC app and writes spikes/s1-nwc/.env. Stays in the foreground; Ctrl+C stops all.
# Never prints secrets. Regtest only.
set -euo pipefail

S1_HOME="${S1_HOME:-$HOME/jaay-s1}"
SPIKE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
B="$S1_HOME/bin"
R="$S1_HOME/run" # wiped on every start: fresh chain, fresh nodes, fresh hub
RELAY_PORT=10547
HUB_PORT=8090
export PATH="$B:$PATH"

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; wait 2>/dev/null || true; }
trap cleanup EXIT INT TERM
log() { echo "[$(date -u +%H:%M:%S)] $*"; }
wait_for() { # wait_for <seconds> <cmd...>
  local n=$1; shift
  for _ in $(seq "$n"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "timeout waiting for: $*"; exit 1
}

rm -rf "$R" && mkdir -p "$R"/{btcd,lnd1,lnd2,hub,logs}
RPCPASS=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
HUB_PASS=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')

# Relay (in-memory)
nak serve --hostname 127.0.0.1 --port "$RELAY_PORT" >"$R/logs/relay.log" 2>&1 &
pids+=($!)

btcd_start() { # btcd_start [miningaddr]
  btcd --regtest --datadir="$R/btcd/data" --logdir="$R/btcd/logs" --rpccert="$R/btcd/rpc.cert" --rpckey="$R/btcd/rpc.key" \
    --rpcuser=s1 --rpcpass="$RPCPASS" --rpclisten=127.0.0.1:18334 --listen=127.0.0.1:18444 --txindex \
    ${1:+--miningaddr=$1} >"$R/logs/btcd.log" 2>&1 &
  BTCD_PID=$!
}
ctl() { btcctl --regtest --rpccert="$R/btcd/rpc.cert" --rpcuser=s1 --rpcpass="$RPCPASS" --rpcserver=127.0.0.1:18334 "$@"; }
btcd_start
wait_for 30 ctl getblockcount

lnd_start() { # lnd_start <n> <rpc> <rest> <p2p>
  lnd --lnddir="$R/lnd$1" --bitcoin.regtest --bitcoin.node=btcd --btcd.rpchost=127.0.0.1:18334 \
    --btcd.rpcuser=s1 --btcd.rpcpass="$RPCPASS" --btcd.rpccert="$R/btcd/rpc.cert" \
    --rpclisten=127.0.0.1:"$2" --restlisten=127.0.0.1:"$3" --listen=127.0.0.1:"$4" \
    --noseedbackup --alias="s1-lnd$1" --debuglevel=info >"$R/logs/lnd$1.log" 2>&1 &
  pids+=($!)
}
cli1() { lncli -n regtest --lnddir="$R/lnd1" --rpcserver=127.0.0.1:10009 "$@"; }
cli2() { lncli -n regtest --lnddir="$R/lnd2" --rpcserver=127.0.0.1:10010 "$@"; }
lnd_start 1 10009 8081 9735
lnd_start 2 10010 8082 9736
wait_for 90 cli1 getinfo
wait_for 90 cli2 getinfo
log "btcd, lnd1 (hub backend), lnd2 (payer) up"

# Fund lnd2: restart btcd with lnd2 as mining address, mine past coinbase maturity.
ADDR=$(cli2 newaddress p2wkh | python3 -c 'import json,sys;print(json.load(sys.stdin)["address"])')
kill "$BTCD_PID"; wait "$BTCD_PID" 2>/dev/null || true
btcd_start "$ADDR"
pids+=("$BTCD_PID")
wait_for 30 ctl getblockcount
ctl generate 110 >/dev/null
wait_for 60 sh -c "lncli -n regtest --lnddir='$R/lnd2' --rpcserver=127.0.0.1:10010 walletbalance | grep -q '\"confirmed_balance\": \"[1-9]'"
wait_for 60 sh -c "lncli -n regtest --lnddir='$R/lnd2' --rpcserver=127.0.0.1:10010 getinfo | grep -q '\"synced_to_chain\": true'"

# Channel lnd2 -> lnd1 so the hub node has inbound liquidity.
PK1=$(cli1 getinfo | python3 -c 'import json,sys;print(json.load(sys.stdin)["identity_pubkey"])')
cli2 connect "$PK1@127.0.0.1:9735" >/dev/null
cli2 openchannel --node_key="$PK1" --local_amt=2000000 >/dev/null
ctl generate 6 >/dev/null
wait_for 60 sh -c "lncli -n regtest --lnddir='$R/lnd2' --rpcserver=127.0.0.1:10010 listchannels | grep -q '\"active\": true'"
log "channel lnd2 -> lnd1 active (2,000,000 sat)"

# Alby Hub on lnd1.
HUB_DIR=$(dirname "$(find "$S1_HOME/albyhub" -type f -name albyhub | head -1)")
(
  cd "$R/hub"
  export WORK_DIR="$R/hub" PORT="$HUB_PORT" RELAY="ws://127.0.0.1:$RELAY_PORT" NETWORK=regtest LOG_LEVEL=4 \
    LN_BACKEND_TYPE=LND LND_ADDRESS=127.0.0.1:10009 LND_CERT_FILE="$R/lnd1/tls.cert" \
    LND_MACAROON_FILE="$R/lnd1/data/chain/bitcoin/regtest/admin.macaroon" ENABLE_ADVANCED_SETUP=false \
    LD_LIBRARY_PATH="$HUB_DIR/../lib:${LD_LIBRARY_PATH:-}"
  exec "$HUB_DIR/albyhub"
) >"$R/logs/hub.log" 2>&1 &
pids+=($!)
H="http://127.0.0.1:$HUB_PORT"
wait_for 60 curl -fs "$H/api/info"

hub() { curl -fsS -H 'Content-Type: application/json' "$@"; }
hub -X POST "$H/api/setup" -d "{\"backendType\":\"LND\",\"unlockPassword\":\"$HUB_PASS\",\"lndAddress\":\"127.0.0.1:10009\",\"lndCertFile\":\"$R/lnd1/tls.cert\",\"lndMacaroonFile\":\"$R/lnd1/data/chain/bitcoin/regtest/admin.macaroon\"}"
TOKEN=$(hub -X POST "$H/api/start" -d "{\"unlockPassword\":\"$HUB_PASS\"}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
wait_for 90 sh -c "curl -fs '$H/api/info' | grep -q '\"running\":true'"
log "alby hub running on lnd1"

# Receive-only app: no pay_* scopes.
APP=$(hub -X POST "$H/api/apps" -H "Authorization: Bearer $TOKEN" \
  -d "{\"name\":\"jaay-s1\",\"scopes\":[\"get_info\",\"make_invoice\",\"lookup_invoice\"],\"unlockPassword\":\"$HUB_PASS\"}")
NWC_URL=$(echo "$APP" | python3 -c 'import json,sys;print(json.load(sys.stdin)["pairingUri"])')

# .env and the payer TLS cert for the probe (both gitignored).
mkdir -p "$SPIKE_DIR/.secrets"
cp "$R/lnd2/tls.cert" "$SPIKE_DIR/.secrets/lnd2-tls.cert"
MAC2=$(od -An -tx1 "$R/lnd2/data/chain/bitcoin/regtest/admin.macaroon" | tr -d ' \n')
umask 077
cat >"$SPIKE_DIR/.env" <<EOF
NWC_URL=$NWC_URL
LND2_REST=127.0.0.1:8082
LND2_MACAROON_HEX=$MAC2
LND2_TLS_CERT=.secrets/lnd2-tls.cert
EOF
log "wrote .env (NWC_URL=${NWC_URL:0:28}...<masked>, LND2_MACAROON_HEX=<masked>)"
log "READY"
wait
