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
