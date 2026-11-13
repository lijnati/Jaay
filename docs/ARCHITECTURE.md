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
- The server trusts the wallet to honor the requested amount and description hash; it checks the network prefix and payment hash shape of the returned invoice but does not decode the BOLT11.
- Enrollment has no operator authentication: anyone can enroll a device that pays into their own wallet. Abuse is bounded by the enroll rate limit and the allowlists.
- With a real relay, recovery after a relay restart also depends on the wallet service re-subscribing. In the regtest run, Alby Hub v1.24.6 did not re-subscribe within about 4 minutes after the local in-memory relay restarted (see the M2 Log row).
- `POST /v1/sales/reconcile` from the roadmap is not built yet (it was not in the M2 endpoint list given for this session).
