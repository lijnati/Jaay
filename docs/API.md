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
  "metadata": "[[\"text/plain\",\"Jaay: 1000 XOF. Recu / receipt: https://pay.example.org/r/<receiptToken>\"]]",
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
- Pending: the page says not paid yet and refreshes every 5 s.
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

## POST /sandbox/pay/:sid

SANDBOX only. Not registered unless `SANDBOX=1`. Marks the fake invoice of an invoiced sandbox sale as paid. No real bitcoin. No body.

`:sid` is the sale id returned by the device encoder.

Responses:

| Status | Body |
| --- | --- |
| 200 | `{"sandbox":true,"status":"paid"}` |
| 404 | `{"sandbox":true,"status":"ERROR"}` (no matching invoiced sandbox sale) |
| 429 | `{"sandbox":true,"status":"ERROR"}` |

## Sale statuses

| Status | Meaning |
| --- | --- |
| created | Token accepted and sale stored, no quote yet. |
| quoted | FX quote locked (120 s). It can be re-quoted after the lock lapses, inside the 15 minute sale window. |
| invoiced | Invoice created by the backend, waiting for payment. |
| paid | Payment seen before the invoice expired. Terminal. |
| expired | Sale window passed with no invoice, or the invoice expiry plus a 30 s grace passed unpaid. A payment can still arrive for an expired invoice. |
| paid_late | Payment seen after expiry: accepted and flagged, never rejected. Terminal. |
