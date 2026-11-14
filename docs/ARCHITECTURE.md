# Architecture

## Protocol v1

The merchant device sells while offline. It turns a price into a short encrypted token, wraps the token in an LNURL-pay QR code, and later checks a 6-digit code the customer reads from their receipt. The server opens the token, prices it in sats, issues the invoice, and shows the code only after the invoice settles. All of this lives in `packages/protocol`, a pure TypeScript library that uses Web Crypto only, so the same code runs in the browser and in Node 20.

### Flow

1. Enrollment (M2) gives the device a 32-byte device secret and a 16-byte device id. The server keeps the same secret.
2. Sale: the device calls `encodeSale` to get a token and a random sale id (`sid`), then `buildSaleLnurl` and `toQrString` to get the QR content.
3. The customer's wallet requests `GET {baseUrl}/lnurlp?p={token}`. The server calls `peekDeviceId` to find the device keys, then `decodeSale`.
4. After the invoice settles, the receipt page shows `deriveConfirmCode(keys, sid)`.
5. The customer reads the code aloud. The merchant types it and the device calls `verifyConfirmCode(keys, sid, entered)`. The merchant screen never shows the code.

### Wire format

The token is 58 bytes, written as base64url without padding: always 78 characters.

| Offset | Bytes | Field | Notes |
|---|---|---|---|
| 0 | 1 | version | `0x01`. Any other value is rejected. |
| 1 | 16 | deviceId | Random. Clear text so the server can find the key. Authenticated as AAD. |
| 17 | 12 | iv | Random 96-bit AES-GCM nonce, fresh for every token. |
| 29 | 13 | ciphertext | AES-256-GCM encryption of the plaintext below. |
| 42 | 16 | tag | GCM authentication tag. |

AAD is `version || deviceId` (17 bytes).

| Plaintext offset | Bytes | Field | Notes |
|---|---|---|---|
| 0 | 4 | amountXof | Unsigned 32-bit, big-endian, whole XOF. |
| 4 | 8 | sid | Random sale id. |
| 12 | 1 | currency | `0x01` means XOF. Any other value is rejected. |

In the API, the device id (22 chars) and the sid (11 chars) appear as base64url strings.

### Key schedule

One 32-byte device secret per device. HKDF-SHA256 with salt `"jaay/v1/salt"` (UTF-8) derives three non-extractable keys:

| HKDF info | Key | Used for |
|---|---|---|
| `jaay/v1/enc` | AES-256-GCM | Sealing and opening sale tokens. |
| `jaay/v1/code` | HMAC-SHA256 (sign only) | Deriving the confirm code. |
| `jaay/v1/auth` | HMAC-SHA256 | Reserved for M2 request signing. Derived now, not used yet. |

### Confirm code

`code = uint64be(first 8 bytes of HMAC-SHA256(codeKey, sid)) mod 1,000,000`, zero-padded to 6 digits. The modulo bias is below 1e-13. Verification recomputes the code and compares without an early exit.

### LNURL and QR

The target URL is `{baseUrl}/lnurlp?p={token}`. It is bech32-encoded with hrp `lnurl` (LUD-01, no 90-character limit), and the QR string is `"LIGHTNING:" + LNURL in uppercase`, so the QR can use alphanumeric mode. `baseUrl` must be https, or http for `localhost`, `127.0.0.1` and `.onion` hosts, and must not have a query or fragment.

Measured sizes: with the 30-character base URL `https://pay.jaay.example.sn/v1`, the token is 78 characters, the LNURL 201 and the QR string 211. With `https://jaay.sn` the LNURL is 177.

### Limits

| Constant | Value |
|---|---|
| `MIN_AMOUNT_XOF` | 50 (default, configurable) |
| `MAX_AMOUNT_XOF` | 5,000,000 (default, configurable up to 2^32 - 1) |
| `MAX_TOKEN_CHARS` | 256. Longer strings are rejected before decoding. |
| `TOKEN_CHARS` | 78 |

Limits are enforced on encode and on decode, so a validly encrypted token with an out-of-range amount is still rejected.

### Failure behavior

`decodeSale` throws one error type, `DecodeError`, with the constant message `invalid sale token` and no own properties, whether the token is too long, badly encoded, the wrong length or version, has a bad tag or the wrong key, carries an unknown currency, or holds an amount outside the limits. `verifyConfirmCode` never throws; any bad input returns `false`. No error message contains key material or token contents.

### Decision log

| Id | Decision | Reason |
|---|---|---|
| D1 | The confirm code is derived from `HMAC(codeKey, sid)`, never stored or carried in the payload. | Nothing to leak from the token or device storage. Both sides recompute it from the sid, and the payload stays 13 bytes. Without the code key, the only way to get the code is a settled receipt. |
| D2 | One 32-byte secret per device, split by HKDF into enc, code and auth keys, all non-extractable. | One value to enroll, back up and revoke. Separate keys mean a flaw in one use does not spill into the others, and non-extractable keys cannot be read back out of Web Crypto. |
| D3 | 58-byte v1 wire format, AAD `version \|\| deviceId`, no timestamp. | Fixed size keeps the QR small (78-char token). AAD stops version downgrades and device id swaps. A timestamp from the merchant clock cannot be trusted (Hard rule 9), so freshness is the server's job. |
| D4 | Target `GET {baseUrl}/lnurlp?p={token}`, bech32 with hrp `lnurl`, QR `LIGHTNING:` plus uppercase. | The device id is already inside the token, so the path doesn't need it and stays short. Uppercase lets the QR use alphanumeric mode, which gives a lower QR version. |
| D5 | Amount 50 to 5,000,000 XOF by default, configurable, checked on encode and decode. Tokens over 256 chars rejected before decoding. | Rejects absurd sales on both sides even if one side is buggy. The length cap bounds the work an attacker can force before the cheap checks run. |
| D6 | Known limits, documented: `baseUrl` is not authenticated, and the constant-time compare is best effort. | Anyone who can replace the printed or displayed QR can point the customer to another server (QR swap). Mitigation: M3 shows the destination host on the merchant screen. JavaScript gives no hard timing guarantee, so the compare avoids early exits but cannot promise constant time. |

Implementation choices not fixed by D1 to D6:

- The device id and sid are base64url strings in the API, so they can be used directly as map keys and in JSON. Bytes stay inside the token.
- `deriveKeys`, `encodeSale`, `decodeSale`, `deriveConfirmCode` and `verifyConfirmCode` return Promises, because Web Crypto is asynchronous.
- `peekDeviceId` checks length and version before returning a device id, but it authenticates nothing. Callers use it only to choose which keys to try.
- Known-answer vectors come from an independent Python reference (`packages/protocol/vectors/gen_vectors.py`, using pyca/cryptography). The TypeScript tests must reproduce the HKDF output, the full token and five confirm codes.
- An ESLint rule in `packages/protocol/src` blocks `node:*`, `crypto` and `buffer` imports and the `Buffer` and `process` globals.

### Known limits

- QR swap (D6): the token does not cover `baseUrl`.
- Timing (D6): the compare is best effort. Decode also fails faster on a malformed string than on a bad tag. The error is identical, but timing shows which stage failed. The format is public, so this reveals little.
- No freshness inside the token: a QR made today can be redeemed later. The server must make `sid` single use per device and expire sales (M2).
- The server holds every device secret, so it can mint tokens and codes for any device. That is inherent to server-side decoding. The self-host option and encryption at rest (M2) are the mitigations.

## Server (M2)

`apps/server` turns a sale token into a payable Lightning invoice on the merchant's own wallet, watches for settlement, and serves a receipt that shows the confirm code only after payment. It is a Hono app on Node (22.13 or later), run with tsx in dev and as one esbuild bundle (`dist/server.mjs`) in production, because the protocol package's `dist` uses extensionless imports that plain Node cannot load. The endpoint reference is in [API.md](API.md).

### Modules

| File | Role |
|---|---|
| `config.ts` | Environment parsing. Production refuses to start without a valid 32-byte `JAAY_MASTER_KEY` and an https `BASE_URL`. |
| `log.ts` | JSON logger. Field values are scrubbed, event names must be snake_case literals, device ids and sids appear only as 8-hex hashes. `installConsoleGuard` routes third-party `console.*` output through the scrubber. |
| `seal.ts` | Secrets at rest (below). |
| `repo.ts` | `Repo` interface and `SqliteRepo` on `node:sqlite`. Status updates are compare-and-set on the previous status. |
| `fx.ts` | Rates and bigint money math (below). |
| `backends/` | `InvoiceBackend { makeInvoice, lookupInvoice }` with `nwc`, `lnbits` and `sandbox` adapters, plus the enrollment rules. |
| `state.ts` | The sale state machine as a pure transition table. |
| `sales.ts` | LNURL-pay request and callback, settlement checks, receipt views, sandbox payment. |
| `poller.ts` | Background settlement poller. |
| `receipt.ts` | The receipt HTML and its CSP. |
| `ratelimit.ts` | In-memory fixed-window limiter per route bucket and client IP. |
| `app.ts` | Routes, headers, CORS, body and URL limits. |

### Golden path

```
merchant PWA (offline)          wallet                    server                         merchant wallet (NWC)
encodeSale -> QR  ------------> scan
                                GET /lnurlp?p=T --------> peekDeviceId, decodeSale with device limits
                                                          create sale (created), quote, lock 120 s (quoted)
                                <------------------------ payRequest: min = max = msat, metadata (text/plain
                                                          with receipt URL), callback
                                GET /lnurlp/cb?p=T&amount=msat
                                                          amount == locked quote, exactly
                                                          make_invoice(msat, sha256(metadata), 600 s) ----->
                                                          <------------------------------------ bolt11
                                <------------------------ {pr, successAction url /r/RT} (invoiced)
                                pay pr ---------------------------------------------------------------------->
                                                          poller: lookup_invoice ------------------------->
                                                          <------------------------------------ settled (paid)
                                open /r/RT -------------> code = deriveConfirmCode(keys, sid)
customer reads the code aloud; merchant types it; device runs verifyConfirmCode (M3)
```

### Sale state machine

```
created --quote--> quoted --quote--> quoted        re-quote when the 120 s lock lapses, inside the 15 min sale window
quoted  --invoice--> invoiced --settle--> paid
created | quoted --expire--> expired               sale window passed with no invoice
invoiced --expire--> expired                       invoice expiry plus 30 s grace passed, unpaid
expired --settle--> paid_late                      payment seen after expiry: accepted and flagged, never rejected
paid, paid_late: terminal
```

A sid is single use per device: a repeated scan within the quote or invoice window returns the same quote and the same invoice, concurrent requests for one sale are serialized in process, and a paid sid never gets another invoice. Expired invoices are still checked every 5 minutes for 24 hours, so a late payment becomes `paid_late`. All times are server time.

### FX

The server polls Kraken `XBTEUR` and Coinbase `BTC-EUR` every 60 s. Kraken is primary; Coinbase is used when Kraken fails. If both answer and differ by more than 2 percent, quotes are refused until they agree. If both fail, the last good rate is used for up to 10 minutes, then quotes are refused. XOF per EUR is the fixed peg 655.957 (BCEAO). Rates are parsed from decimal strings into micro-EUR bigints, and

```
sats = ceil(amountXof * 10^17 / (eurPerBtcMicro * 655957)),  msat = sats * 1000
```

so the amount is always a whole sat, rounded up, with no floating point anywhere in the money path. Each quote is stored with the rate, its source, the fetch time, the quote time and the 120 s lock expiry. Fetch and the clock are injected, so tests are deterministic.

### Secrets at rest

Device secrets, wallet connection strings and receipt tokens are sealed with AES-256-GCM under `JAAY_MASTER_KEY`, with a random 96-bit IV per value, in the text format `v1.` + base64url(iv, ciphertext, tag). The AAD names the field and the row (for example `device-secret:<deviceId>`), so a sealed value cannot be moved to another row. A wrong key or any tampering fails closed with one error. Receipts are looked up by sha256 of the token. The confirm code and the sale token are never stored. A test scans the SQLite file bytes for sentinel secrets.

### Backends and enrollment

- `nwc`: `@getalby/sdk` 9.0.0, wrapped so every call has an 8 s timeout and any network or timeout failure drops the client; the next call builds a fresh one (reconnect). Enrollment requires `make_invoice` and `lookup_invoice`, refuses any method containing "pay", requires a test network, and every relay must be in `NWC_ALLOWED_RELAYS`.
- `lnbits`: invoice key only, host must be in `LNBITS_ALLOWED_HOSTS`, redirects refused.
- `sandbox`: fake invoices, paid with `POST /sandbox/pay/:sid`, labeled SANDBOX in every JSON body, header, page and LNURL description. A sandbox server enrolls only sandbox devices unless `JAAY_ALLOW_MIXED=1`; a real server never enrolls sandbox devices.
- Every backend refuses a mainnet invoice (Hard rule 1): only `lnbcrt`, `lntbs` and `lntb` prefixes pass.

### Failure behavior

Every LNURL verification failure (bad or tampered token, unknown device, amount outside the device limits, no quote, lock lapsed, wrong amount, expired, replay after payment, backend down) returns HTTP 400 with `{"status":"ERROR","reason":"Invalid or expired sale"}`. An unknown device still runs a full decrypt with decoy keys, so that path costs about the same. Unknown, malformed and expired-unpaid receipt tokens get one identical 404. Logs record only that a request was rejected, never why.

### Decisions

| Decision | Reason |
|---|---|
| `node:sqlite` over better-sqlite3 | Built into Node 22.13 and later (here Node 24.18). No native compile step, which better-sqlite3 needs on Windows and in slim Docker images. Wrapped in the `Repo` interface, so swapping later is contained. |
| esbuild bundle | One file, no `node_modules` at runtime, loads the protocol source directly. The runtime image copies only `server.mjs`. |
| Operator allowlists for LNbits hosts and NWC relays | Enrollment is open, so without them the server could be pointed at internal hosts (SSRF). |
| Reconnect in Jaay's wrapper, not only in the SDK | Deterministic to test with a fake transport, and a hung client is cut off by Jaay's own timeout. |
| Receipt token stored sealed and hashed | A database leak does not hand out working receipt links. |

### Known limits (server)

- The server holds every device secret (sealed at rest), so whoever controls the server and the master key can mint tokens and codes for any device.
- Receive-only is enforced by the wallet service, not by Jaay. The claim is "the Jaay server cannot spend", not "the merchant's node cannot be drained": anyone with the wallet's own admin access can still spend.
- FX source terms of use and exact rate limits were not verified (S4).
- The rate limiter and the per-sale lock are in memory: they reset on restart and assume a single server instance.
- Invoice signatures are not verified (decode only); the amount, network, payment hash, description hash and expiry are (A5).
- Sandbox enrollment is open (rate limited); real backends need the operator token (A4).
- With a real relay, recovery after a relay restart also depends on the wallet service re-subscribing. In the regtest run, Alby Hub v1.24.6 did not re-subscribe within about 4 minutes after the local in-memory relay restarted (see the M2 Log row).
- Device authentication relies on the device auth key; whoever holds the unlocked phone (or injects script into the PWA origin) can sign requests as that device. The nonce table lives in SQLite; the rate limiter is per process.

### Device API (M3 Block A)

The PWA signs calls with the device auth key: HMAC-SHA256 over `jaay-auth-v1`, method, path, device id, a millisecond timestamp (within 120 s of server time), a 128-bit nonce and sha256 of the body (full format in [API.md](API.md#device-authentication)). Unknown devices run the same HMAC with decoy keys, comparison uses `timingSafeEqual`, and a nonce is stored (SQLite, expiring with the window) only after the MAC passes, so nobody can burn a device's nonces. Two endpoints use it:

- `POST /v1/sales/reconcile`: up to 200 sids, each answered from the signing device's rows only (`unknown` otherwise), with server amount, server settlement time and a mismatch flag. A due settlement check runs first.
- `POST /v1/wallet/summary`: server-computed paid totals, the last 50 paid sales, and the backend's granted methods checked for spend capability on every call (if one appears after enrollment, `receiveOnly` turns false and an error is logged). The balance appears only when NWC grants `get_balance`.

Other Block A changes: non-sandbox enrollment needs `JAAY_ENROLL_TOKEN` as a Bearer token; every returned invoice is decoded and checked (network `JAAY_NETWORK`, amount, payment hash, description hash, not expired) before it reaches a wallet; and the PWA build is served at `/app/` with a self-only CSP when `JAAY_POS_DIR` is set.

## Merchant PWA (M3)

`apps/pos` is a Vite build of plain TypeScript and DOM (no UI framework), served by the server at `/app/` on the same origin as the device API. First load is 21.8 KB gzipped (HTML, JS, CSS, service worker, manifest, icons), measured by the e2e run against a 150 KB budget. Security specifics are in [SECURITY_PWA.md](SECURITY_PWA.md).

### Modules

| File | Role |
|---|---|
| `ledger.ts` | The sale state machine: one pure transition table, the only place statuses change. |
| `confirm.ts` | Confirm-code check through the protocol, 3 attempts, counter persisted before evaluation. |
| `enroll.ts` | Strict payload parsing, fragment handling, origin check, key derivation and storage. |
| `reconcile.ts` | Which sales to send, signed batches of 200, all-or-nothing merge. |
| `auth.ts` | Device request signing (same canonical string as the server). |
| `db.ts` | IndexedDB: `kv` (config, CryptoKeys, cached wallet summary, active sale) and `sales` (ledger). |
| `i18n.ts`, `money.ts`, `qr.ts` | One FR/EN catalog, XOF formatting ("5 000 F"), QR at level M from spike S3. |
| `main.ts` | Screens: enroll, sell, confirm, ledger, wallet, settings. |
| `sw-template.js` | Service worker, scope `/app/`, cache-first shell, update on tap. |

### Ledger state machine

Device events: `confirm` (right code), `fail` (wrong code, attempts left), `lock` (third wrong code), `cancel`, `expire` (local sale window over, display only). Server events come from reconcile: `srv_paid`, `srv_paid_late`, `srv_pending`, `srv_expired`, `srv_unknown`, and `srv_mismatch` (the server's amount differs from the device's, which overrides the status). Any pair not in the table is refused; the tests cover all 99 pairs.

| From | Device events | Server events |
|---|---|---|
| open | confirm: confirmed; fail: open; lock: locked; cancel: cancelled; expire: expired | paid: paid; paid_late: paid_late; pending: open; expired: unpaid; unknown: open; mismatch: mismatch |
| confirmed | none | paid: paid; paid_late: paid_late; pending: confirmed; expired: **mismatch**; unknown: **mismatch**; mismatch: mismatch |
| locked | cancel: cancelled | paid: paid; paid_late: paid_late; pending: locked; expired: unpaid; unknown: unpaid; mismatch: mismatch |
| cancelled | none | paid or paid_late: **mismatch** (refund needed); pending, expired, unknown: cancelled; mismatch: mismatch |
| expired | confirm: confirmed; fail: expired; lock: locked; cancel: cancelled | as open, except unknown: unpaid |
| paid | none | paid: paid |
| paid_late | none | paid_late: paid_late |
| unpaid | none | paid: paid; paid_late: paid_late; others: unpaid; mismatch: mismatch |
| mismatch | none | mismatch: mismatch |

`paid`, `paid_late`, `unpaid` and `mismatch` are reachable only from server events. A locked, cancelled, unpaid or mismatched sale can never become confirmed. "Confirmed but the server shows no payment" is the case of a leaked or guessed code, and becomes `mismatch`.

### Reconcile flow

1. Triggers: app start when online, the browser `online` event, and the manual "Check with server" button.
2. Sales sent: every non-final sale (not paid, paid_late or mismatch) from the last 7 days, in batches of 200, each a signed `POST /v1/sales/reconcile` with `{sid, amountXof, claimedAt, confirmed}`.
3. A batch response must match the batch exactly (same length, same order, same sids, known statuses) or nothing is applied.
4. Each result becomes one server event and goes through the transition table; the server's view (status, amount, settlement time, mismatch flag) is stored on the sale.
5. On failure the ledger is untouched and the call is retried with backoff (5 s doubling to 5 minutes). Selling is never blocked.

### Key storage

The enrollment secret is turned into three non-extractable CryptoKeys (`deriveKeys`) and only those objects are stored, in IndexedDB; the secret bytes are zeroed and the secret is never persisted (tested by scanning IndexedDB and localStorage). Keys cannot be exported but can be used by any script in the origin, so the strict CSP at `/app/` is part of the security model (see [SECURITY_PWA.md](SECURITY_PWA.md)).

### Offline and updates

The service worker precaches the shell and serves it cache-first; requests outside `/app/` (device API, `/lnurlp`, `/r/`) always go to the network. A new version installs in the background and waits; Settings offers "Update now" only when no sale is open on screen, then the page reloads once into the new version. Verified in Chromium by the e2e run: offline reload, cold start with the browser closed and reopened offline, and the update flow with an open sale.

## Demo path (M4)

Everything in this section exists only on a SANDBOX server (`SANDBOX=1`) and is labeled SANDBOX wherever it shows.

### Fixed demo rate

`JAAY_FX_FIXED_XOF_PER_BTC` replaces the exchange feeds with one integer rate. The server refuses to start if it is set without `SANDBOX=1`. No exchange is called. The quote math is the same bigint round up to a whole sat (`sats = ceil(amountXof * 1e8 / rate)`), the 120 s lock is unchanged, and the quote is stored with source `fixed-demo`. It is labeled "fixed demo rate" in `/healthz`, in the LNURL metadata text the wallet shows, and on the receipt next to the sats. `pnpm demo`, `compose.yaml` and the e2e suite use 40 000 000 XOF per BTC, so none of them needs the internet.

### Customer simulator (`apps/customer-sim`, served at `/sim/`)

A page that plays an LNURL-pay wallet, always labeled "SANDBOX customer wallet (simulator, not a real wallet)". It decodes the LNURL with the protocol's LUD-01 function (https, or http on localhost only), fetches the payRequest and checks it (min equals max, non-empty text/plain), calls the callback with that exact amount, decodes the invoice and checks its description hash against the metadata, then calls `POST /sandbox/pay/<payment hash>`. It holds no secret: paying by payment hash means it never needs the sale id. The success action is shown the way Phoenix does: a link only if it is on the callback's host, otherwise text only, plus the receipt URL printed in the description. Nothing opens automatically. A "what a wallet sees" panel shows the raw responses. LNURL errors show their reason and nothing else. 10.6 KB gzipped, same CSP as the PWA.

### Sandbox helpers in the merchant PWA

- **Try the sandbox demo shop** (Enroll screen, only when `/healthz` says sandbox): calls the open sandbox enrollment and feeds the answer into the normal enrollment path: the same strict parser, the same host confirmation, the same non-extractable key derivation. The secret is never put in the visible text box.
- **Copy payment string** and **Open customer simulator** under the QR: decided by `sandboxHelpers(config, qr)`, which returns null unless the device config says sandbox (unit tested).
- **Load demo data / Remove demo data** (Settings, sandbox only): 12 deterministic sales over the last 3 days (500 to 25 000 F, three sample merchant types), flagged `demo`. The server is seeded first through `POST /sandbox/seed` (device-signed, sandbox only, at most 50 sales, paid within the last 30 days, idempotent per sid, marked demo), then the local ledger. `POST /sandbox/unseed` and the local delete remove only demo rows. Wallet totals and reconcile therefore agree with the ledger (checked by the e2e judge flow).

### Receipt page

Shows the merchant label (HTML-escaped; tested with script tags and quotes), the amount in XOF and sats, the settlement time, the fixed demo rate note when used, and the SANDBOX banner. Still under 15 KB, no JavaScript, and the code appears only after settlement.

### One command and smoke test

`pnpm demo` (scripts/demo.mjs) builds what is missing, generates `.demo/master.key` once, starts `apps/server/dist/server.mjs` with SANDBOX, the fixed rate, `JAAY_POS_DIR` and `JAAY_SIM_DIR`, and prints the three URLs. `pnpm smoke [baseUrl]` (scripts/smoke.mjs) checks `/app/`, `/sim/` and `/healthz`, then runs the existing golden path script (`apps/server/scripts/golden.ts`) over HTTP, for local, Docker or a deployed sandbox URL. Deployment: [DEPLOY.md](DEPLOY.md).
