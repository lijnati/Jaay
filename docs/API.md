# HTTP API

Reference for `apps/server`, as implemented. Base URL is the server's `BASE_URL` (for example `https://pay.example.org`, or `http://localhost:8787` in development).

- Bodies are JSON unless noted. Server time is authoritative.
- A SANDBOX server (`SANDBOX=1`) adds `"sandbox": true` to every JSON body and sends the header `X-Jaay-Sandbox: 1` on every response. Examples below omit it.
- Every response carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, and `Cache-Control: no-store` unless the route set its own.
- A URL longer than 2048 characters gets `414` (`URI too long`, plain text). Request headers over 8 KB get `431` (Node server limit, before the app runs).
- Unknown routes return `404 {"error":"not found"}`. Unhandled errors return `500 {"error":"internal error"}`.

## Rate limits

Per client IP. Limits are in memory and reset on restart.

| Bucket | Routes | Requests | Window |
| --- | --- | --- | --- |
| lnurlp | GET /lnurlp | 60 | 1 minute |
| cb | GET /lnurlp/cb | 30 | 1 minute |
| enroll | POST /api/enroll | 10 | 1 hour |
| receipt | GET /r/:receiptToken, GET /api/receipt/:receiptToken/status | 60 | 1 minute |
| sandbox | POST /sandbox/pay/:sid | 30 | 1 minute |

Status `429` bodies:

| Route | Body |
| --- | --- |
| /lnurlp, /lnurlp/cb | `{"status":"ERROR","reason":"Too many requests"}` |
| /api/enroll | `{"error":"too many requests"}` (plus `"sandbox": true` on SANDBOX servers) |
| /r/:receiptToken | The generic receipt page (HTML) |
| /api/receipt/:receiptToken/status | `{"status":"ERROR","reason":"Too many requests"}` |
| /sandbox/pay/:sid | `{"sandbox":true,"status":"ERROR"}` |

## GET /healthz

Liveness and FX rate status.

Response `200`:

```json
{ "status": "ok", "fx": "ok" }
```

`fx` is `"ok"` or `"unavailable"`. When unavailable, new quotes are refused.

## POST /api/enroll

Registers a merchant device and returns its secret once.

Request: `Content-Type: application/json`, body at most 4096 bytes.

| Field | Type | Constraint |
| --- | --- | --- |
| label | string | 1..64 chars of letters, digits, space, `.`, `_`, `'`, `-` |
| backend | string | `nwc`, `lnbits` or `sandbox` |
| connection | string | up to 1024 chars (ignored and stored empty for `sandbox`) |
| minXof | integer | safe integer, `1 <= minXof <= maxXof` |
| maxXof | integer | safe integer, `<= 4294967295` |

Enrollment rules:

- `nwc`: the connection must report `make_invoice` and `lookup_invoice`, no method containing "pay", a test network (regtest, signet, testnet, mutinynet), and every relay must be in `NWC_ALLOWED_RELAYS`.
- `lnbits`: the host must be in `LNBITS_ALLOWED_HOSTS`. The connection is an invoice key URL: `https://host/?api-key=<32 hex>`.
- `sandbox`: accepted only on SANDBOX servers. Real backends on a SANDBOX server need `JAAY_ALLOW_MIXED=1`.
- Operator token: every `nwc` or `lnbits` enrollment must send `Authorization: Bearer <JAAY_ENROLL_TOKEN>` (compared in constant time). With no token configured, such enrollment is impossible. Sandbox enrollment needs no token and is rate limited.

Request example:

```json
{ "label": "Chez Awa", "backend": "sandbox", "connection": "", "minXof": 50, "maxXof": 5000000 }
```

Response `200`:

```json
{ "deviceId": "<22-char base64url>", "deviceSecretB64u": "<43-char base64url, shown once>", "baseUrl": "https://pay.example.org" }
```

`deviceSecretB64u` is shown once and never retrievable again.

Errors:

| Status | Body | When |
| --- | --- | --- |
| 400 | `{"error":"enrollment rejected"}` (plus `"sandbox": true` on SANDBOX servers) | Bad JSON, any field invalid, or any backend rule failed. No reason is given. |
| 413 | `{"error":"enrollment rejected"}` (plus `"sandbox": true` on SANDBOX servers) | Body over 4096 bytes. |
| 429 | `{"error":"too many requests"}` (plus `"sandbox": true` on SANDBOX servers) | Rate limit. |

## GET /lnurlp

LNURL-pay (LUD-06) first step. The wallet opens the URL from the sale QR.

CORS: `Access-Control-Allow-Origin: *`. `OPTIONS /lnurlp` returns `204`.

Query: `p` (string), the sale token from the device.

Response `200`:

```json
{
  "tag": "payRequest",
  "callback": "https://pay.example.org/lnurlp/cb?p=<token>",
  "minSendable": 1520000,
  "maxSendable": 1520000,
  "metadata": "[[\"text/plain\",\"Jaay: 1000 XOF. Reçu / receipt: https://pay.example.org/r/<receiptToken>\"]]",
  "commentAllowed": 0
}
```

- `minSendable` equals `maxSendable`: the locked quote in msat (whole sats).
- The metadata text/plain entry contains the receipt URL. On a sandbox-backend device it starts with `[SANDBOX] `.

Errors:

| Status | Body | When |
| --- | --- | --- |
| 400 | `{"status":"ERROR","reason":"Invalid or expired sale"}` | Every verification failure (bad or missing token, unknown device, replay, amount out of limits, expired, already paid, no FX rate). The reason never says which check failed. |
| 429 | `{"status":"ERROR","reason":"Too many requests"}` | Rate limit. |

## GET /lnurlp/cb

LNURL-pay second step. Creates the invoice.

CORS: `Access-Control-Allow-Origin: *`. `OPTIONS /lnurlp/cb` returns `204`.

Query:

| Param | Type | Constraint |
| --- | --- | --- |
| p | string | the sale token (same as step one) |
| amount | string | digits, msat, must equal `minSendable` exactly |

Response `200`:

```json
{
  "pr": "lnbcrt15200n1...",
  "routes": [],
  "successAction": {
    "tag": "url",
    "url": "https://pay.example.org/r/<receiptToken>",
    "description": "Recu Jaay / Jaay receipt"
  }
}
```

Repeating the callback for a sale that still has a pending invoice returns the same invoice. On a sandbox-backend device the description ends with ` [SANDBOX]`.

Errors: the same `400` and `429` bodies as `GET /lnurlp`. A wrong `amount` is also the generic `400`.

## GET /r/:receiptToken

Receipt page for the customer. Returns HTML (not JSON).

- No JavaScript. Strict CSP: `default-src 'none'` with the stylesheet pinned by hash.
- French by default, English when the first `Accept-Language` entry starts with `en`.
- Pending: the page says not paid yet, with a "Check again" link that reloads it. No timed refresh (WCAG 2.2.1), and still no JavaScript.
- Paid or paid late: shows amount, UTC time and the confirm code. The code appears only after settlement (`paid` or `paid_late`).
- SANDBOX servers show a SANDBOX bar at the top.

Responses:

| Status | Content |
| --- | --- |
| 200 | Pending page or paid page |
| 404 | The same "receipt not found or expired" page for unknown, malformed and expired-unpaid tokens |
| 429 | The same generic page, on rate limit |

## GET /api/receipt/:receiptToken/status

JSON twin of the receipt page, for polling.

Responses:

| Status | Body |
| --- | --- |
| 200 | `{"status":"pending"}` |
| 200 | `{"status":"paid","amountXof":1000,"paidAt":"2026-11-13T10:15:30.000Z","code":"482915","late":false}` |
| 404 | `{"status":"expired"}` (same for unknown, malformed and expired-unpaid tokens) |
| 429 | `{"status":"ERROR","reason":"Too many requests"}` |

`late` is `true` when the payment arrived after the invoice expired (`paid_late`). `code` is only present when paid.

## POST /sandbox/pay/:ref

SANDBOX only. Not registered unless `SANDBOX=1`. Marks the fake invoice of an invoiced sandbox sale as paid. No real bitcoin. No body.

`:ref` is either the sale id (11 base64url chars) or the invoice's payment hash (64 hex chars). The customer simulator uses the payment hash, which it reads from the invoice, so it never needs the sale id or any secret.

Responses:

| Status | Body |
| --- | --- |
| 200 | `{"sandbox":true,"status":"paid"}` |
| 404 | `{"sandbox":true,"status":"ERROR"}` (no matching invoiced sandbox sale) |
| 429 | `{"sandbox":true,"status":"ERROR"}` |

## Device authentication

The merchant PWA signs its API calls with the device `auth` key (HKDF info `jaay/v1/auth` from `packages/protocol`). Four headers:

| Header | Value |
| --- | --- |
| `X-Jaay-Device` | device id (22 base64url chars) |
| `X-Jaay-Ts` | Unix time in milliseconds; must be within 120 s of server time either way |
| `X-Jaay-Nonce` | 16 random bytes, base64url (22 chars); single use per device within the window |
| `X-Jaay-Sig` | base64url HMAC-SHA256 under the auth key of the canonical string below |

Canonical string, one element per line (joined with a newline):

```
jaay-auth-v1
POST
/v1/sales/reconcile
<device id>
<X-Jaay-Ts>
<X-Jaay-Nonce>
<hex sha256 of the exact request body bytes>
```

The server compares MACs in constant time, checks unknown device ids against decoy keys, and stores a nonce only after the MAC is valid. Every failure (missing or malformed header, stale or future timestamp, wrong key, unknown device, replayed nonce, body or path changed after signing) returns `401 {"error":"unauthorized"}`. Both endpoints below accept bodies up to 64 KB and share a per-IP limit of 120 requests per minute.

## POST /v1/sales/reconcile

Device authenticated. Tells the device what the server knows about its sales.

Request:

```json
{ "sales": [ { "sid": "<11-char base64url>", "amountXof": 1000, "claimedAt": 1794600000000, "confirmed": true } ] }
```

At most 200 entries. `amountXof` is an integer from 1 to 4294967295, `claimedAt` is the device clock in ms (advisory only, never used for decisions), `confirmed` means the merchant typed a correct code on the device. Any malformed entry fails the whole batch with `400 {"error":"bad request"}`.

Response `200`, one result per entry, in order:

```json
{ "results": [ { "sid": "<sid>", "status": "paid", "amountXof": 1000, "settledAt": "2026-11-14T09:00:02.000Z", "mismatch": false } ] }
```

- `status`: `paid`, `paid_late`, `pending` (created, quoted or invoiced), `expired`, or `unknown`.
- `amountXof` and `settledAt` are the server's values (`settledAt` is server time, null unless paid).
- `mismatch` is true when the device amount differs from the server amount, or when `confirmed` is true and the server has not settled the sale (including `unknown`).
- Only the signing device's own sales are visible; any other sid, including another device's, is `unknown`.
- Idempotent. Never returns confirm codes or receipt tokens.

## POST /v1/wallet/summary

Device authenticated, body `{}`. Feeds the receive-only Wallet screen.

```json
{
  "receiveOnly": true,
  "backend": { "kind": "nwc", "available": true, "spendMethods": [], "balanceMsat": null, "balanceNote": null },
  "totals": { "today": { "xof": 2500, "msat": "6115000", "count": 1 }, "allTime": { "xof": 3500, "msat": "8561000", "count": 2 } },
  "recent": [ { "sid": "AbCdEf", "amountXof": 2500, "paidAt": "2026-11-14T09:00:02.000Z", "status": "paid", "demo": false } ],
  "generatedAt": "2026-11-14T09:05:00.000Z"
}
```

- Totals cover `paid` and `paid_late` sales, computed by the server; "today" is the current UTC day (Dakar time).
- `recent` holds the last 50 paid sales with a 6-character sid prefix.
- `spendMethods` lists any spend-capable method the wallet now grants (expected empty). If one appears after enrollment, `receiveOnly` becomes false and the server logs an error.
- `balanceMsat` is present only when the NWC connection is granted `get_balance`, and `balanceNote` says it is the backend's own report.
- `kind` is a code (`sandbox`, `nwc` or `lnbits`); the app shows a translated name for it (EN and FR). No display text is sent.
- If the backend cannot be reached, `available` is false, `spendMethods` is null, and totals are still returned.

## Invoice checks

Every invoice a backend returns is decoded (light-bolt11-decoder) before it reaches a wallet. The callback fails closed with the generic LNURL error unless the invoice is on `JAAY_NETWORK` (regtest `lnbcrt`, signet `lntbs`, testnet `lntb`), pays exactly the quoted msat, carries the payment hash the backend reported and the description hash `sha256(metadata)`, and has not expired by server time. Sandbox invoices use the real BOLT11 layout with a zero signature, so wallets cannot pay them.

## /app/ (merchant PWA)

When `JAAY_POS_DIR` is set, the PWA build is served at `/app/` on the same origin as the API. `/app` redirects to `/app/`. Responses carry `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. `sw.js` and the shell are `Cache-Control: no-cache`; files under `/app/assets/` are immutable. Paths without an extension fall back to `index.html`. The service worker scope is `/app/`, so `/lnurlp`, `/lnurlp/cb` and `/r/` are never intercepted.

## POST /sandbox/seed and POST /sandbox/unseed

SANDBOX only, device authenticated (see Device authentication). Demo data for the signing device.

- `/sandbox/seed` body: `{"sales":[{"sid":"<11-char base64url>","amountXof":1500,"paidAt":1794600000000}]}`, at most 50 entries, `paidAt` in server time within the last 30 days and not in the future. Creates paid sales marked demo, quoted at the current (fixed demo) rate. Idempotent per sid. Response `200 {"sandbox":true,"created":12,"existing":0}`; a malformed batch gets `400 {"error":"bad request"}`.
- `/sandbox/unseed` body `{}`: removes this device's demo sales only. Response `200 {"sandbox":true,"removed":12}`.

## Fixed demo rate

With `SANDBOX=1` and `JAAY_FX_FIXED_XOF_PER_BTC` set, `/healthz` reports `"fx":"fixed demo rate"`, the LNURL metadata text includes "Taux de demo fixe / fixed demo rate", and the receipt prints the sats with "fixed demo rate, not a market rate". The server refuses to start with the fixed rate outside SANDBOX.

## /sim/ (customer simulator)

When `JAAY_SIM_DIR` is set, the SANDBOX customer simulator is served at `/sim/` with the same CSP and caching rules as `/app/`. `/sim/?lnurl=<payment string>` fills the input and reads the payment request; paying always needs a tap.

## Sale statuses

| Status | Meaning |
| --- | --- |
| created | Token accepted and sale stored, no quote yet. |
| quoted | FX quote locked (120 s). It can be re-quoted after the lock lapses, inside the 15 minute sale window. |
| invoiced | Invoice created by the backend, waiting for payment. |
| paid | Payment seen before the invoice expired. Terminal. |
| expired | Sale window passed with no invoice, or the invoice expiry plus a 30 s grace passed unpaid. A payment can still arrive for an expired invoice. |
| paid_late | Payment seen after expiry: accepted and flagged, never rejected. Terminal. |
