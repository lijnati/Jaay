# Merchant PWA security notes

Scope: `apps/pos`, served by the server at `/app/` (same origin as the device API). This complements the server notes in [ARCHITECTURE.md](ARCHITECTURE.md).

## Device keys

- Enrollment hands the device its 32-byte secret once, as a pasted code or a `#enroll=` link. The fragment is read once and removed from the address bar and history with `history.replaceState` before anything else runs, so it does not stay in history or reach a server.
- The app derives the three protocol keys (`enc` AES-256-GCM, `code` HMAC, `auth` HMAC) with `deriveKeys` as **non-extractable** CryptoKeys, stores those objects in IndexedDB, and zeroes the secret bytes. The secret is never written to IndexedDB, localStorage or any log. The base64url string cannot be wiped from JS memory; every reference to it is dropped.
- Verified twice: a unit test dumps every IndexedDB record and searches for the secret in five encodings (base64url, base64, hex, raw bytes, byte list), and the Playwright run repeats that scan in a real Chromium on IndexedDB and localStorage. Both also check every stored key reports `extractable: false` and that `exportKey` fails.
- Wipe device (two taps in Settings) clears keys, config, cached wallet data and the ledger.

## Why the CSP is load-bearing

Non-extractable keys cannot be copied out of the browser, but any script running in the `/app/` origin can still **use** them: seal sale tokens, compute confirm codes, and sign device API calls. An XSS would therefore let an attacker read confirm codes for any sale id and reconcile as the device. Defenses:

- The server sends `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; ...; frame-ancestors 'none'` for every `/app/` response. No inline scripts or styles exist in the build.
- All dynamic text is written with `textContent`; the code never uses `innerHTML`. The merchant label is validated at enrollment and in Settings.
- No third-party requests, no CDN, no analytics, no web fonts. The only network calls go to the same origin.
- Enrollment refuses a server whose origin differs from the app's own origin, and shows the destination host prominently with a one-time "this is my server" confirmation (QR-swap mitigation). The sell screen shows the host in bold under every QR.

## Confirm code (Hard rule 3)

- The code is never computed for display. The app only recomputes it inside `verifyConfirmCode` (protocol) to compare with what the merchant typed, in constant time (best effort in JS).
- At most 3 attempts per sale. The counter is written to IndexedDB and the transaction committed **before** the attempt is evaluated; a test kills the flow right after the write and shows the attempt still counts after restart. A sale whose counter is spent is locked even if the app died before the lock was written. Concurrent taps are serialized.
- After 3 wrong codes the sale is `locked` and can never become `confirmed` (state machine). Error text says only "Code not accepted", never how close the guess was.

## Device API calls

- Reconcile and wallet summary calls are signed with the `auth` key (HMAC over method, path, device id, timestamp, nonce and body hash; format in [API.md](API.md#device-authentication)). The server checks the timestamp against its own clock and rejects replayed nonces.
- A reconcile batch is applied to the ledger only after the whole response validates (length, order, sids, statuses); a failure leaves the ledger unchanged and retries with backoff (5 s doubling to 5 min). Reconcile and wallet loads never block selling.

## Logging

The PWA source contains no `console` call at all; a unit test fails the build if one appears. Tokens, codes, amounts and key material therefore cannot reach the browser console from app code.

## Known limits

- Anyone holding the unlocked phone can use the keys (create sales, confirm codes within the attempt cap, reconcile). A passcode-wrapped key (PBKDF2) was not built.
- Safari and Firefox persistence of CryptoKeys in IndexedDB, iOS storage eviction, and launching the installed app from its icon in airplane mode on a real phone were NOT RUN (Chromium only, see spike S3).
- The sale window countdown uses the device clock and is display only; the server's clock decides what was paid (Hard rule 9).
- Icons are SVG only; some Android versions may need PNG icons to offer installation (not tested).
