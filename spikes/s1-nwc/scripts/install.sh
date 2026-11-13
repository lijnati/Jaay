#!/usr/bin/env bash
# Spike S1: downloads pinned regtest tooling into $S1_HOME/bin (no sudo, no docker).
# Every archive is checked against the checksum list published with its release.
# btcd is used instead of bitcoind: bitcoincore.org downloads were too slow here (about 1 KB/s).
set -euo pipefail

S1_HOME="${S1_HOME:-$HOME/jaay-s1}"
BTCD_V=v0.27.0
LND_V=v0.21.8-beta
HUB_V=v1.24.6
NAK_V=v0.22.3
GH=https://github.com

mkdir -p "$S1_HOME/dl" "$S1_HOME/bin"
cd "$S1_HOME/dl"

# shortcut: GitHub throttles each connection (about 20 KB/s here), so large files are fetched as 16 parallel ranges.
fetch() { # fetch <url> <file>
  [ -f "$2" ] && return
  local real size n=16 i
  real=$(curl -fsSL -o /dev/null -w '%{url_effective}' -r 0-0 "$1")
  size=$(curl -fsSI "$real" | tr -d '\r' | awk 'tolower($1)=="content-length:"{print $2}' | tail -1)
  if [ -z "$size" ] || [ "$size" -lt 2000000 ]; then
    curl -fsSL --retry 5 --retry-all-errors -o "$2.part" "$1"
  else
    local chunk=$(( (size + n - 1) / n ))
    for i in $(seq 0 $((n - 1))); do
      curl -fsS --retry 10 --retry-all-errors -r $((i * chunk))-$(((i + 1) * chunk - 1)) -o "$2.r$i" "$real" &
    done
    wait
    for i in $(seq 0 $((n - 1))); do cat "$2.r$i"; done > "$2.part"
    rm -f "$2".r*
  fi
  mv "$2.part" "$2"
}
check() { # check <sums file> <archive>
  # Alby Hub lists files as ./name, the others as name.
  grep -E "[ *](\./)?$2\$" "$1" | head -1 | sed 's#\./##' | sha256sum -c - || { echo "CHECKSUM FAIL: $2"; rm -f "$2"; exit 1; }
}

# btcd (chain backend for both LND nodes)
fetch "$GH/btcsuite/btcd/releases/download/$BTCD_V/manifest-$BTCD_V.txt" btcd.sums
fetch "$GH/btcsuite/btcd/releases/download/$BTCD_V/btcd-linux-amd64-$BTCD_V.tar.gz" "btcd-linux-amd64-$BTCD_V.tar.gz"
check btcd.sums "btcd-linux-amd64-$BTCD_V.tar.gz"
tar -xzf "btcd-linux-amd64-$BTCD_V.tar.gz"
cp "btcd-linux-amd64-$BTCD_V/btcd" "btcd-linux-amd64-$BTCD_V/btcctl" "$S1_HOME/bin/"

# LND
fetch "$GH/lightningnetwork/lnd/releases/download/$LND_V/manifest-$LND_V.txt" lnd.sums
fetch "$GH/lightningnetwork/lnd/releases/download/$LND_V/lnd-linux-amd64-$LND_V.tar.gz" "lnd-linux-amd64-$LND_V.tar.gz"
check lnd.sums "lnd-linux-amd64-$LND_V.tar.gz"
tar -xzf "lnd-linux-amd64-$LND_V.tar.gz"
cp "lnd-linux-amd64-$LND_V/lnd" "lnd-linux-amd64-$LND_V/lncli" "$S1_HOME/bin/"

# Alby Hub (server build). bzip2 may be missing, so python extracts it.
fetch "$GH/getAlby/hub/releases/download/$HUB_V/manifest.txt" hub.sums
fetch "$GH/getAlby/hub/releases/download/$HUB_V/albyhub-Server-Linux-x86_64.tar.bz2" albyhub-Server-Linux-x86_64.tar.bz2
check hub.sums albyhub-Server-Linux-x86_64.tar.bz2
rm -rf "$S1_HOME/albyhub" && mkdir -p "$S1_HOME/albyhub"
python3 -c "import tarfile,sys; tarfile.open(sys.argv[1]).extractall(sys.argv[2], filter='data')" albyhub-Server-Linux-x86_64.tar.bz2 "$S1_HOME/albyhub"
chmod +x "$S1_HOME/albyhub/bin/albyhub" # python's tarfile 'data' filter leaves it non-executable

# nak (provides `nak serve`, an in-memory local relay). No checksum list is published; print ours.
fetch "$GH/fiatjaf/nak/releases/download/$NAK_V/nak-$NAK_V-linux-amd64" "nak-$NAK_V-linux-amd64"
sha256sum "nak-$NAK_V-linux-amd64"
install -m 755 "nak-$NAK_V-linux-amd64" "$S1_HOME/bin/nak"

"$S1_HOME/bin/btcd" --version
"$S1_HOME/bin/lnd" --version
"$S1_HOME/bin/nak" --version
ls -R "$S1_HOME/albyhub" | head -20
