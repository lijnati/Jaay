# Spike notes

| Spike | Date | Result | Evidence |
| ----- | ---- | ------ | -------- |
| S1 NWC backend | 2026-11-13 | GO: Alby Hub on regtest LND, receive-only NWC, 22/22 checks green on two runs | `spikes/s1-nwc/probe.ts`, section below |
| S3 Offline PWA | 2026-11-13 | GO: 13/13 checks green on two runs, first load 13.2 KB gzipped, CryptoKey persists in IndexedDB | `spikes/s3-offline/check.ts`, section below |
| S4 FX source | 2026-11-13 | Research: Kraken primary, Coinbase Exchange fallback, peg 655.957 verified at BCEAO | section below |
| S5 Wallets (LUD-09) | 2026-11-13 | Research: url successAction shown behind a tap by Phoenix (Android), Zeus, Alby Go, Alby extension; build url plus text/plain fallback | section below |

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

## S3: offline PWA shell

Question: can a Vite PWA that is loaded once keep working with the network completely off, including creating a sale QR with the real protocol and keeping a ledger, and what does it cost in bytes?

Answer: yes. All 13 checks pass in Chromium on two consecutive runs (45 s and 32 s), and the whole first load is 13.2 KB gzipped.

### What ran

- Vite 8.3.8 builds a one-screen page: amount, Create, a 300 px canvas QR, the LNURL text, a ledger count and a SANDBOX banner. It imports the real `packages/protocol` source through a Vite alias (read only, not modified). Spike-only test key: the protocol vector secret (bytes 0..31) and base URL `https://pay.jaay.example.sn/v1`.
- Service worker: hand-written (about 35 lines, `sw-template.js`) plus a 20-line Vite plugin that injects the precache list and a content hash. Chosen over vite-plugin-pwa because it adds no Workbox runtime, the update behavior is explicit and readable, and the shell is only six files. The cost is that we own cache versioning, which the content hash covers.
- Cache strategy: cache first for same-origin GET, navigations fall back to the cached `index.html`, old caches are deleted on activate.
- Update strategy: prompt, not skipWaiting on install. A new worker installs in the background and waits; the page shows an update button; on tap the page posts `SKIP_WAITING`, the new worker claims the page and the page reloads once. Reason: never swap code under a merchant in the middle of a sale.
- `check.ts` builds twice (one per QR library), serves the build from a local static server that can be switched off (it destroys sockets, so it is a real outage, not a 404), and drives Chromium with Playwright, using persistent profiles so the service worker, Cache Storage and IndexedDB survive a full browser restart.

Versions: vite 8.3.8, qrcode-generator 2.0.4, qrcode 1.5.4, jsqr 1.4.0, pngjs 7.0.0, playwright 1.64.0 with chromium-1248 (cached locally), tsx 4.23.15, Node 24.18.0, Windows 10.

### Results

| # | Check | Result | Evidence |
|---|---|---|---|
| 1a | Visit online, close page, server down and `setOffline(true)`, reload: renders and creates a sale | PASS | |
| 1b | Browser context closed and reopened on the same profile, offline from the first request: works, earlier ledger entry still there | PASS | ledger 1 before the new sale |
| 2 | Canvas screenshot decoded with jsQR equals the QR string and `LIGHTNING:` + uppercase LNURL; the decoded LNURL leads to a token that decrypts to 1000 XOF | PASS (both libraries) | decoded mode alphanumeric, version 8 |
| 3 | Non-extractable HKDF-derived keys (`DeviceKeys`: AES-GCM and two HMAC) stored as CryptoKey objects in IndexedDB survive reload and full restart; they open a token sealed before the reload, give the same confirm code, round trip a new sale, and `exportKey` rejects | PASS | `extractable: false`, `exportRejected: true` |
| 4a | 3 sales written offline persist across an offline reload | PASS | count 3 |
| 4b | Going online fires the `online` handler, which runs the reconcile stub | PASS | 1 run, 3 sales marked checked |
| 5a | `crypto.subtle` works offline on `http://localhost` (secure context) | PASS | `isSecureContext: true` |
| 5b | On `http://<lan-ip>:4173` the page is NOT a secure context: no `crypto.subtle`, no service worker (expected failure, shown) | PASS | `isSecureContext: false`, `subtle: undefined`, `sw: false` |
| 6 | First load under 150 KB gzipped | PASS | 13.2 KB with qrcode-generator, 14.8 KB with qrcode |
| 7a | v2 deployed while the user is offline: user keeps a working v1 | PASS | |
| 7b | Back online: v2 installs and waits, update button shown, page still v1 and still creates sales | PASS | |
| 7c | After tapping update: v2 runs, and v2 works offline | PASS | |

5b means real deployments need HTTPS. A merchant opening the app over plain http on a LAN address gets no Web Crypto and no service worker, so the app cannot work there.

### QR numbers

The QR string is 211 characters (`LIGHTNING:` plus the 201-char LNURL from the 30-char test base URL), all in the QR alphanumeric set. Rendered at 300 px with a 4-module quiet zone and whole pixels per module:

| ECC | Version | Modules | px per module at 300 px |
|---|---|---|---|
| L (7%) | 7 | 45 x 45 | 5 |
| **M (15%)** | **8** | **49 x 49** | **5** |
| Q (25%) | 10 | 57 x 57 | 4 |
| H (30%) | 12 | 65 x 65 | 4 |

Choice: level M. It keeps the same 5 px modules as L while doubling the recovery margin for glare and smudges; Q and H drop to 4 px. Both libraries produced identical versions and module counts. qrcode-generator is given the alphanumeric mode explicitly; qrcode picks it by itself. A shorter production base URL (`https://jaay.sn`, LNURL 177 chars) would shrink the symbol further [INFERRED]. Decoding was from a clean screenshot, not a camera; a phone camera test is still to do (the S5 manual test covers it).

### Byte budget

Measured as gzip -9 of every file the browser fetched on a first visit with a fresh profile (page load plus service worker install), HTTP headers excluded.

| Library | Requests | Unique files | First load gz | First load raw | Precache gz | JS raw |
|---|---|---|---|---|---|---|
| **qrcode-generator 2.0.4** | 8 | 6 | **13.2 KB** | 33.1 KB | 12.6 KB | 28.6 KB |
| qrcode 1.5.4 | 8 | 6 | 14.8 KB | 36.5 KB | 14.2 KB | 32.0 KB |

Chosen QR library: qrcode-generator (1.6 KB gz smaller, no dependencies, meets check 2). Neither the QR library nor the protocol code comes close to the 150 KB target: the whole JS bundle including protocol, QR and IndexedDB code is 11.0 KB gz.

### Answer for M3: how to store the device key

Store the derived `DeviceKeys` (three non-extractable CryptoKey objects) directly in IndexedDB. Do not store the raw 32-byte secret: derive once at enrollment, then drop it. This held across reload and full browser restart in Chromium [VERIFIED: run].

Threat model consequences for Hard rule 3: script running in the app's origin (an XSS), or someone holding the unlocked phone, can still use the keys to compute codes or seal tokens, but cannot copy them off the device. So XSS prevention (strict CSP, no third-party scripts) stays essential, and the 3-attempt limit per sale stays the guard against guessing. If a browser ever fails to persist CryptoKeys, the fallback is wrapping the secret with a key from a user PIN (PBKDF2), which adds a PIN prompt at app start. That is not needed on current evidence.

### Platform caveats (not verified here)

- iOS Safari may evict script-writable storage (IndexedDB, Cache Storage) for sites not used for 7 days, and home-screen installed web apps are reported to be exempt [INFERRED]. M3 should call `navigator.storage.persist()` and ask merchants to install to the home screen.
- Android Chrome installability may require PNG icons (192 and 512) in addition to the SVG used here [INFERRED]. Not tested.
- Opening the installed app from its icon in airplane mode on a real phone: NOT RUN. Playwright offline emulation in desktop Chromium is not the same as airplane mode on Android or iOS. This is the main thing to test by hand in M3.
- Persistence of CryptoKey in IndexedDB on Safari and Firefox: NOT RUN (Chromium only).

### Reproduce

```bash
cd spikes/s3-offline
npm install
npx playwright install chromium   # skip if chromium-1248 is already cached
npx tsx check.ts                  # builds both variants, prints PASS/FAIL per check, about 45 s
```

Gotchas: `context.storageState` does not carry service workers or Cache Storage, so the restart test uses `launchPersistentContext` with the same profile directory. On Windows, build paths must go through `fileURLToPath`, because a URL pathname keeps `%20`.

Time: 17:05 to 17:20 UTC for the build and two green runs, plus write-up.

## S4: FX source (research only)

Peg: 1 EUR = 655.957 XOF, fixed since 1 January 1999. BCEAO's own history page lists "Pegging of the CFA F to the euro, January 1st, 1999, CFA F 655.957 = 1euro" [VERIFIED: https://www.bceao.int/en/content/history-cfa-franc, fetched with curl, HTTP 200]. Banque de France also lists 1 euro = 655,957 FCFA [search result excerpt, not fetched: https://www.banque-france.fr/system/files/2025-04/Fiche_CMAF_23.04.2025.pdf]. So `XOF per BTC = EUR per BTC x 655.957`, and only EUR/BTC needs a market source.

| Source | Endpoint | Key | Answered | Rate limit | Terms |
|---|---|---|---|---|---|
| Kraken | `https://api.kraken.com/0/public/Ticker?pair=XBTEUR`, last trade `result.XXBTZEUR.c[0]` | none | 200 [VERIFIED: called twice] | public endpoints limited by IP; about 1 call per second stays within limits [search excerpt of https://support.kraken.com/articles/206548367, not fetched] | [UNKNOWN] |
| Coinbase Exchange | `https://api.exchange.coinbase.com/products/BTC-EUR/ticker`, field `price` | none | 200 [VERIFIED: called twice] | "Public endpoints are throttled by IP", number not found [reported by subagent from https://docs.cdp.coinbase.com/exchange/rest-api/rate-limits] | [UNKNOWN] |
| CoinGecko keyless | `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=eur` | none | 200 [VERIFIED: called twice] | about 5 calls per minute, dynamic, shared per IP [search excerpt of https://docs.coingecko.com/docs/keyless-public-api, not fetched] | [UNKNOWN] |

Also answered 200 with no key (subagent calls, not repeated by me): Coinbase v2 spot `https://api.coinbase.com/v2/prices/BTC-EUR/spot`, Bitstamp `https://www.bitstamp.net/api/v2/ticker/btceur/`, Binance `https://api.binance.com/api/v3/ticker/price?symbol=BTCEUR`. mempool.space `/api/v1/prices` timed out from this network. At 17:09 UTC the exchanges agreed within about 0.1%.

Pick: primary Kraken (native EUR market, keyless, documented IP limit), fallback Coinbase Exchange (different company, keyless). CoinGecko is a third option only, because its keyless limit is low and shared.

Design for M2:
- The server polls the primary every 60 s (far below any limit above), and the fallback only when the primary fails. Clients never call an exchange.
- If both answer and differ by more than 2%, refuse new quotes and log it [design choice].
- If both fail, use the last good rate for up to 10 minutes, then refuse with a clear message (ROADMAP M2 edge case).
- Quote lock 120 s: the sats amount is fixed when the wallet first requests `/lnurlp`, and the callback must come within 120 s.
- Stored per sale: `eurPerBtc`, `source` (kraken or coinbase), `fetchedAt` (server time), `quotedAt`, `sats`.
- Terms of use for Kraken and Coinbase public data were not read. Read them before the public demo.

## S5: LUD-09 url successAction (research only)

LUD-09: the wallet keeps the successAction and shows it once the payment succeeds. For `url` it "should give the user a popup which displays `description`, `url`, and a 'open' button", and the url domain must match the callback domain [subagent quote from https://raw.githubusercontent.com/lnurl/luds/luds/09.md].

| Wallet | Shows `url`? | How | Evidence |
|---|---|---|---|
| Phoenix (Android) | YES | link button, only when the url passes the domain check, otherwise plain text | [VERIFIED: https://github.com/ACINQ/phoenix/blob/cadfa5f6/phoenix-android/src/main/kotlin/fr/acinq/phoenix/android/payments/details/splash/SplashOutgoingLightning.kt#L177-L184, read by me] |
| Phoenix (iOS) | [UNKNOWN] | file names match, source not read | |
| Zeus | YES | tap opens it via `Linking.openURL` | [VERIFIED: https://github.com/ZeusLN/zeus/blob/17cc896a/views/LnurlPay/Success.tsx#L27-L34 and L72, read by me] |
| Alby Go | YES, only if `description` is non-empty | "Open Link" button | [VERIFIED: https://github.com/getAlby/go/blob/4e1ff455/components/SuccessMessage.tsx#L29-L49, read by me] |
| Alby browser extension | YES | url plus open button | [subagent: https://github.com/getAlby/lightning-browser-extension/blob/91dba0a2/src/app/screens/LNURLPay/index.tsx#L199-L203, not re-read by me] |
| Breez (Spark SDK) | PARTIAL | SDK returns the action and validates the domain; display depends on the app | [subagent: https://github.com/breez/spark-sdk/blob/main/docs/breez-sdk/src/guide/lnurl_pay.md#L41, not re-read by me] |
| Wallet of Satoshi, Muun, Blink, Bitkit, Aqua | [UNKNOWN] | closed source or no code found | |
| Machankura, Bitnob, Tando | [UNKNOWN] | closed source, no docs found | |

No wallet found opens the url automatically; every one that supports it shows it behind a tap. Whether wallets show the metadata `text/plain` before paying is [UNKNOWN] for every wallet (not read).

Recommended receipt design (build both in M2; they cost little):
1. Primary: `successAction = { tag: "url", description: "Recu Jaay / Jaay receipt", url: "https://<same host as callback>/r/<receiptToken>" }`. Use the same host as the callback (Phoenix and Breez check it), and always a non-empty `description` (Alby Go hides the action otherwise).
2. Fallback for wallets that ignore it: the metadata `text/plain` ends with the receipt URL, for example `jaay: 1000 XOF, recu: https://jaay.sn/r/<receiptToken>`. It is visible before payment, which is acceptable because the receipt page shows the confirm code only after settlement (Hard rule 4).
3. The receipt page stays settlement-gated either way, and customer-sim implements the url action so the demo does not depend on any third-party wallet.

Build first: the url successAction plus the text/plain line, in the same M2 change, since the fallback is one string.

Manual test (5 minutes, with a phone wallet that can pay the demo backend, against the deployed demo):
1. On the merchant PWA, enter 100 XOF and press Create.
2. Scan the QR with the wallet. Note whether the wallet shows the description text and the receipt link before paying.
3. Pay. Note whether a success screen shows the description and an open button or link.
4. Tap it. The receipt page must open on the demo host and show the 6-digit code and the amount.
5. If no link was shown, open the receipt link from the description by hand and check the same page.
6. Create a second sale and, before paying it, open its receipt link from the description: it must say not paid yet and show no code.
7. Type the first sale's code on the merchant PWA: it must be accepted, and a wrong code must be rejected.
8. Record wallet name, version, platform, and the results of steps 2 to 7 in a table here.

Research was delegated to two Sonnet subagents (quick-ops) per CLAUDE.md, then spot-checked: the peg page, three FX endpoints and three wallet code citations were re-fetched by the main session.
