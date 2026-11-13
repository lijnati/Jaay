# Spike notes

| Spike | Date | Result | Evidence |
| ----- | ---- | ------ | -------- |
| S1 NWC backend | 2026-11-13 | GO: Alby Hub on regtest LND, receive-only NWC, 22/22 checks green on two runs | `spikes/s1-nwc/probe.ts`, section below |

## S1: receive-only NWC backend

Question: can the Jaay server, holding only a receive-only NWC connection, (a) create invoices, (b) see when they are paid, and (c) is it unable to spend, against a local regtest backend, with a LNURL-pay-compatible invoice?

Answer: yes to all three, through Alby Hub v1.24.6 on LND v0.21.8-beta, on regtest, with a local relay. Path (a) from the plan worked on the first attempt, so path (b) LNbits and the fallback were not tried.

Tags: [VERIFIED: run] means the probe or a command in this spike showed it. [VERIFIED: source] cites a document. [INFERRED] is reasoning that no run showed.

### What ran

Everything runs natively in WSL2 Ubuntu (no Docker on this machine, no sudo needed). The probe runs on Windows Node 24 and reaches WSL services on 127.0.0.1 through WSL localhost forwarding.

| Piece | Version | Role |
|---|---|---|
| btcd | v0.27.0 | regtest chain for both LND nodes |
| lnd1 | v0.21.8-beta | Alby Hub backend (the merchant side) |
| lnd2 | v0.21.8-beta | payer, plays the customer wallet |
| Alby Hub (server build) | v1.24.6 | NWC wallet service on lnd1 |
| nak serve | v0.22.3 | in-memory Nostr relay on ws://127.0.0.1:10547 |
| @getalby/sdk | 9.0.0 | NWC client A |
| nostr-tools | 2.26.0 | NWC client B (hand-rolled, about 90 lines in probe.ts) |
| light-bolt11-decoder | 3.2.0 | independent BOLT11 decoding |

btcd replaced bitcoind because bitcoincore.org downloaded at about 1 KB/s here. LND supports btcd as a chain backend [VERIFIED: `lnd --help` lists `--bitcoin.node=[btcd|bitcoind|neutrino|nochainbackend]`].

Topology: lnd2 opens a 2,000,000 sat channel to lnd1, so the hub has inbound liquidity. Alby Hub is set up headless over its HTTP API: `POST /api/setup` (backendType LND), `POST /api/start` (returns a JWT), `POST /api/apps` with scopes `get_info, make_invoice, lookup_invoice`. The returned pairing URI goes into `.env` and is never printed.

### Results

| # | Check | @getalby/sdk | nostr-tools |
|---|---|---|---|
| 1 | get_info lists make_invoice and lookup_invoice | PASS | PASS |
| 1 | get_info lists no spend method (pay_invoice, multi_pay_invoice, pay_keysend, multi_pay_keysend) | PASS | PASS |
| 2 | make_invoice with description_hash and expiry 600 | PASS | PASS |
| 3 | BOLT11 `h` tag == sha256(LUD-06 metadata) | PASS | PASS |
| 3 | BOLT11 has no plain `d` tag | PASS | PASS |
| 3 | BOLT11 amount == 1,000,000 msat | PASS | PASS |
| 3 | BOLT11 expiry == 600 s | PASS | PASS |
| 3 | BOLT11 prefix lnbcrt (regtest) | PASS | PASS |
| 4, 5 | lnd2 pays, lookup_invoice shows settled | PASS | PASS |
| 6 | pay_invoice on the same connection rejected | PASS, code RESTRICTED | PASS, code RESTRICTED |
| 6 | the invoice it tried to pay is still OPEN on lnd2 | PASS | PASS |

[VERIFIED: run] Two full runs, 22/22 checks each, exit code 0. The hub's own message for the spend attempt was "This app does not have the pay_invoice scope".

Latency, in ms, local relay, regtest:

| Measure | Run | @getalby/sdk | nostr-tools |
|---|---|---|---|
| make_invoice x10 min / median / max | 1 | 119 / 310.5 / 2959 | 127 / 144 / 1029 |
| make_invoice x10 min / median / max | 2 | 98 / 144 / 891 | 110 / 151 / 213 |
| pay start to settled seen by lookup_invoice (250 ms polling) | 1 | 1085 | 894 |
| pay start to settled seen by lookup_invoice | 2 | 860 | 757 |
| first get_info (includes relay connect) | 1 | 693 | 593 |

The occasional 1 to 3 s outlier shows up for both clients, so it is on the hub or LND side, not in the client [INFERRED].

Relay down (connection pointed at ws://127.0.0.1:1):

| Client | Behavior |
|---|---|
| @getalby/sdk | throws `Nip47NetworkError`, code `OTHER`, after 10 ms. Also writes its own `console.error` with a stack trace. |
| nostr-tools | `Relay.connect` rejects with the bare string `connection failed` after 3 ms. My wrapper has no reconnect logic. |

Not tested: a relay that drops in the middle of a long-lived session, and reconnect after it comes back. M2 must test this, because the server keeps one client open for days.

Bundle cost (esbuild, minified, node platform, gzip): `NWCClient` alone 38.6 KB (109 KB raw). The nostr-tools pieces used by the hand-rolled client are 27.0 KB (73.6 KB raw), plus about 90 lines that we would own.

### Client choice for M2: @getalby/sdk

- It is the reference client of the wallet service we tested, released 2026-10-27 (9.0.0), after 8.1.0 and 8.1.1 earlier the same month [VERIFIED: npm time]. It depends on nostr-tools itself, so the size gap (11.6 KB gz) is the only extra cost.
- It handles encryption negotiation (nip44_v2 or nip04), typed errors with NIP-47 codes (`Nip47WalletError.code === "RESTRICTED"`), and a reconnecting relay pool. The hand-rolled client would have to grow all three, and reconnect is exactly the part that is easy to get wrong.
- It ran unchanged on Node 24 with the global WebSocket and needed no polyfill [VERIFIED: run].
- Failure behavior is fast and typed when the relay is down. The hand-rolled one rejected with a plain string.
- Caveat for Hard rule 8: the SDK logs errors to the console by itself. It accepts a `logger` option in `NewNWCClientOptions` [VERIFIED: source, dist/types/nwc.d.ts]. M2 must pass a scrubbed logger and cover it in the log-scrubber test. The logged text seen here held no secret, only the error message and stack.

### Findings that change M2

1. Alby Hub adds methods beyond the granted scopes. With scopes `get_info, make_invoice, lookup_invoice`, get_info listed `make_hold_invoice, settle_hold_invoice, cancel_hold_invoice, get_budget` too [VERIFIED: run]. None of them spends, but an allowlist check that demands an exact method set would reject a valid connection. The enrollment check should be: must contain make_invoice and lookup_invoice, and must contain none of pay_invoice, multi_pay_invoice, pay_keysend, multi_pay_keysend. Any unknown method should be refused unless it is on a short known-safe list.
2. description_hash is honored end to end [VERIFIED: run]. The invoice carries only `h`, no `d`, which is what LUD-06 wallets check [INFERRED: LUD-06 not re-read in this spike; S5 tests a real wallet].
3. The guarantee is enforced by the wallet service, not the protocol. The NWC secret only signs requests, and Alby Hub decides per app scope [VERIFIED: run, RESTRICTED reply]. Anyone with the hub's unlock password or JWT can still create a spending app. So the claim is "the Jaay server cannot spend", not "the merchant node cannot be drained" [INFERRED]. The threat model (M6) should say so.
4. `lookup_invoice` by payment_hash works and polling is enough. Notifications were not tested and are not needed for M2.
5. The NIP-47 spec defines `RESTRICTED` as "This public key is not allowed to do this operation" [VERIFIED: source, NIP-47]. M2 can map it to a fail-closed enrollment error.

### Reproduce from scratch

Downloads are about 155 MB. At normal speeds this is under 10 minutes. Here GitHub throttled each connection to about 20 KB/s, so `install.sh` fetches big files as 16 parallel ranges and verifies every archive against the release checksum list.

```bash
# 1. In WSL (any Ubuntu with curl and python3, no sudo):
bash spikes/s1-nwc/scripts/install.sh      # into ~/jaay-s1, about 2 to 5 min
bash spikes/s1-nwc/scripts/stack.sh        # fresh regtest stack, prints READY in about 90 s, writes .env

# 2. In another terminal (Windows or WSL with Node 20+):
cd spikes/s1-nwc
npm install
npx tsx probe.ts                            # prints PASS/FAIL per check, exits 0 when all pass
```

`stack.sh` wipes `~/jaay-s1/run` on each start, so every run gets a new chain, nodes, hub and app. Ctrl+C stops every process.

Gotchas:
- Alby Hub's `manifest.txt` lists files as `./name`. Plain `sha256sum -c` lines for the other projects do not have the prefix.
- Python's tarfile `data` filter drops the execute bit on the `albyhub` binary, so the script runs chmod.
- btcd only mines to an address passed at start, so the script starts btcd, gets an address from lnd2, then restarts btcd with `--miningaddr`.
- `btcctl` prints "Error creating a default config file" when `~/.btcd` is missing. It is harmless.
- WSL forwards 127.0.0.1 listeners to Windows, so the hub's relay URL `ws://127.0.0.1:10547` works from both sides.
- npm 11 warns that the esbuild postinstall was not approved. tsx still worked, using the platform binary package.

### Sources

- Alby Hub README v1.24.6, LND env config, RELAY, NETWORK, supported NIP-47 methods: https://github.com/getAlby/hub/blob/v1.24.6/README.md
- Alby Hub HTTP routes: https://github.com/getAlby/hub/blob/v1.24.6/http/http_service.go
- Alby Hub API request models (SetupRequest, CreateAppRequest, CreateAppResponse): https://github.com/getAlby/hub/blob/v1.24.6/api/models.go
- Alby Hub release and checksums: https://github.com/getAlby/hub/releases/tag/v1.24.6
- LND release and manifest: https://github.com/lightningnetwork/lnd/releases/tag/v0.21.8-beta
- btcd release and manifest: https://github.com/btcsuite/btcd/releases/tag/v0.27.0
- nak release (no published checksum, sha256 2eb9a16f86c865275983459b2c705d22d5dfbcf527026a279449cbf204d164fe recorded): https://github.com/fiatjaf/nak/releases/tag/v0.22.3
- NIP-47 (kinds 13194/23194/23195, encryption tag, error codes, make_invoice params): https://github.com/nostr-protocol/nips/blob/master/47.md
- LUD-06 (description_hash of metadata), cited from prior knowledge, not re-read here: https://github.com/lnurl/luds/blob/luds/06.md
- @getalby/sdk 9.0.0 types (NWCClient, Nip47WalletError, logger option): https://www.npmjs.com/package/@getalby/sdk

Time spent: 15:52 to 16:30 UTC (38 minutes) to the second green run, plus write-up. About 30 minutes of it was environment work (Docker check, slow downloads, btcd swap). The NWC path passed on its first run, within a minute of the stack printing READY.
