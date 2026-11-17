# ROADMAP: Jaay @ Dakar Bitcoin Hack

Deadline: 2026-11-20 20:00 UTC (23:00 EAT). Submit-by: 2026-11-20 14:00 UTC (17:00 EAT). Hard feature freeze: 2026-11-18 18:00 EAT.
Budget (from time_budget.py, 45 focus hours from 2026-11-13 04:55 UTC): P0 3.6h, P1 spikes 4.5h, P2 MVP 16.6h, P3 UI 6.8h, P4 test and deploy 5.4h, P5 demo and submit 8.1h.

How we work: one milestone at a time. A milestone is done only when its acceptance criteria pass with real command output. Then ask for the next one. Never mark done on "should work".

## Calendar (EAT)
| Day | Plan |
|---|---|
| Fri Nov 13 | M0 (questions, repo), spikes S1 and S2 |
| Sat Nov 14 | Spikes S3 to S5, GATE at 22:00, start M1 |
| Sun Nov 15 | M1 done, M2 server |
| Mon Nov 16 | M2 done, M3 POS PWA |
| Tue Nov 17 | M3 done, M4 simulator and compose, golden path green |
| Wed Nov 18 | M5 polish, FREEZE 18:00 |
| Thu Nov 19 | M6 security and docs, M7 deploy and video |
| Fri Nov 20 | Buffer, submit by 17:00, logged-out check |

## Architecture (target)
```
jaay/
  packages/protocol/   pure TS: payload crypto, LNURL encode/decode, sale ids, confirm code, tests
  apps/server/         Hono (Node): LNURL-pay endpoints, backend adapters, receipt page, reconcile API, admin enroll
  apps/pos/            Vite PWA: offline keypad, QR, sale ledger (IndexedDB), reconcile, FR/EN
  apps/customer-sim/   tiny page that acts as an LNURL-pay wallet for demo and tests
  infra/               docker-compose (regtest stack or sandbox profile), seed script
  docs/                THREAT_MODEL.md, ARCHITECTURE.md
```
Backend adapter interface `InvoiceBackend { makeInvoice(amountSats, memo), lookupInvoice(paymentHash) }` with three implementations: `nwc` (NIP-47, receive-only), `lnbits` (invoice key, also receive-only), `sandbox` (simulated, always labeled).

Rules that never change: no mainnet; secrets only in `.env` (gitignored) with `.env.example`; every mock labeled in UI, README and video; no PII in logs; receipt never shows the confirm code before settlement.

---

## M0: Ground rules (Fri, about 1.5h)  [ ]
Deliverables
- [ ] Post in Discord (discord.gg/tyS2Mt7C): (a) solo allowed? (b) does a PoS plus receive-only NWC wallet view satisfy "a Bitcoin/Lightning wallet implementation"? (c) how are prizes paid and is residency in Ethiopia a problem? (d) is hosted demo with a labeled sandbox backend acceptable?
- [ ] Repo skeleton, pnpm workspace, license (MIT), `.env.example`, CI-less scripts `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`.
- [ ] Copy WINNING_STRATEGY.md and this file into repo root.
Acceptance: `pnpm install && pnpm test` runs (zero tests is fine); questions posted with timestamps logged below.
Edge: if organizers say teams only, find a teammate or confirm solo in writing before M1.

## Spikes S1 to S5 (Fri to Sat, about 4.5h)  [ ]
Each spike ends with real output saved in `spikes/NOTES.md`.
- [ ] S1 Backend: run a Lightning backend locally (regtest or signet) and call `make_invoice` and `lookup_invoice` through a NWC connection scoped to receive only. Use Context7 to read the current `@getalby/sdk` NWC client docs before coding. Fallback: LNbits with invoice key.
- [ ] S2 Protocol: in a browser, encrypt `{amountXof, sid, code, deviceId}` with Web Crypto AES-GCM, encode as `lightning:LNURL1...`, render a QR, decode and verify on a Node endpoint. Record QR version and character length.
- [ ] S3 Offline: PWA shell plus keypad plus QR generation work with Playwright `context.setOffline(true)` after first load.
- [ ] S4 FX: find a free XOF to BTC rate source with sane rate limits, or decide on a fixed labeled rate with a source note. Record decision.
- [ ] S5 Wallets: confirm what a real LNURL-pay wallet does with a `url` successAction (LUD-09). Test at least one wallet that works on signet or a testnet profile. If none usable, customer-sim is the guaranteed path.
Gate (Sat 22:00): S1, S2, S3 must pass. If S1 fails, switch primary backend to LNbits and move NWC to stretch. If S2 or S3 fails, stop and re-plan before writing more code (fallback idea: chat-native Bitcoin tutor).

## M1: Protocol package (Sat night to Sun, about 5h)  [ ]
Deliverables
- `packages/protocol`: `deriveKeys()` (HKDF from one 32-byte device secret into enc, code and auth keys), `encodeSale()`, `decodeSale()`, `peekDeviceId()`, `lnurlEncode/Decode`, `buildSaleLnurl()`, `toQrString()`, `deriveConfirmCode()` and `verifyConfirmCode()`. The confirm code is derived as HMAC-SHA256(codeKey, sid) mod 10^6, 6 digits; it is never stored or transmitted, and both sides recompute it from the sid (constant-time compare).
- Payload (58 bytes, 78 base64url chars): version byte, deviceId, random 96-bit IV, AES-256-GCM ciphertext+tag over `{amountXof u32, sid 8 bytes, currency}`; the version and deviceId are authenticated as AAD. No timestamp. Full spec in `docs/ARCHITECTURE.md` "Protocol v1".
Security requirements
- Never reuse an IV with a key (random 96-bit IV, never a stored counter, since storage can be cleared).
- Fail closed on any parse or tag error; error messages must not reveal which check failed.
- Amount bounds enforced both sides (min 50 XOF, max configurable).
Tests (vitest, written first)
- Round trip; flipped bit in each field rejected; wrong device key rejected; truncated and oversized payload rejected; version downgrade rejected; confirm code distribution check; constant-time compare used.
Acceptance: `pnpm --filter @jaay/protocol test` green with at least 30 cases; token exactly 78 chars and LNURL under 220 chars with a base URL of 30 chars or fewer.
Edge cases: amount 0, negative, non-integer, giant; deviceId unknown; unicode junk in query string.

## M2: Server (Sun to Mon, about 7h)  [ ]
Endpoints
- [x] `GET /lnurlp?p=...`: the deviceId lives inside the token; `peekDeviceId` picks the device keys, then verify and decrypt, create the sale record, return LNURL-pay metadata with `minSendable = maxSendable = sats(amountXof)` using the quote lock.
- [x] `GET /lnurlp/cb?p=...&amount=...`: create invoice via backend adapter, return `pr` and a `url` successAction pointing to `/r/:token`.
- [~] `GET /r/:token` (done except the merchant name, not shown yet): static, under 20 KB; shows "not paid yet" until `lookupInvoice` says settled, then the confirm code (recomputed from the sid with the device code key) in large type, amount, merchant name.
- [x] `POST /v1/sales/reconcile` (built in M3 Block A) (device-authenticated with an HMAC under the device auth key over body and a timestamp window): returns paid, unpaid, expired for a list of sale ids.
- [~] `POST /v1/admin/enroll` and a minimal admin page (built as `POST /api/enroll`, no admin page or QR yet): create device (device id and 32-byte device secret), show enrollment QR once, store the device secret and the receive-only NWC string encrypted at rest with an env key.
Security requirements
- [x] NWC permission check at enroll: refuse a connection that allows `pay_invoice`.
- [x] Idempotency: same `sid` always returns the same invoice and receipt token; second scan never creates a second sale.
- [~] Receipt token 128-bit random; per-IP (done) and per-device (NOT done) rate limits on all public endpoints; quote lock 120s; invoice expiry 10 min.
- [x] Logging: structured, no phone numbers, no NWC string, no full payload; device id hashed. Add a log-scrubber test that greps captured logs.
- [x] CORS locked down; security headers on receipt page.
- [x] Sale statuses include `paid_late`: a payment that arrives after the sale window is accepted and flagged, never rejected.
- [x] Device limits (min and max XOF) come from the enrollment config.
- [x] The server runs via tsx in dev and is bundled for production, because the `packages/protocol` dist is not loadable by plain Node.
Tests
- [x] Integration with the sandbox backend (reconcile auth failure covered in Block A of M3): golden flow; replay; tamper; unknown device; pay-underpay-overpay attempts rejected by exact amount; pre-payment receipt returns no code; rate limit triggers; reconcile auth failure; expired invoice.
Acceptance: `pnpm --filter server test` green; manual curl script in `scripts/demo-curl.sh` reproduces the golden flow against sandbox; receipt page measured under 20 KB.
Edge cases: FX source down (use last good rate up to 10 min, then refuse with clear message); backend timeout; duplicate callbacks; clock skew between merchant and server (server time is authoritative).

## M3: Merchant PWA (Mon to Tue, about 7h)  [ ]
Deliverables
- [x] Offline-first PWA: keypad, XOF amount, QR screen, confirm-code entry (3 attempts then lock the sale to "needs reconcile"), sale ledger in IndexedDB, reconnect banner, reconcile action, FR default with EN toggle, large touch targets.
- [~] (paste or #enroll= link done; camera QR scan and admin page not built; passcode not built, documented as a known limit in docs/SECURITY_PWA.md) Enrollment by scanning the admin QR; device secret stored encrypted under a merchant passcode (PBKDF2) if time allows, otherwise non-extractable key note in THREAT_MODEL as a known limit.
- [x] Receive-only wallet view (balance and recent receives via backend/NWC) so the app plainly includes a wallet implementation.
Security requirements
- [x] Confirm code is never rendered on the merchant screen, only entered and compared against its HMAC.
- [x] No analytics, no third-party scripts, service worker caches only own assets.
Tests
- [x] Playwright: full golden path with the browser context offline after warm-up; code mismatch three times; reload mid-sale keeps ledger; reconcile marks an unpaid sale.
Acceptance: shell works offline; Lighthouse throttled (slow 4G, mid-range CPU) saved to `docs/lighthouse/`; PWA bundle gzipped size recorded in README.
Edge cases: low storage, two sales in flight, app killed mid-sale, passcode forgotten, clock changes, QR in bright sun (high contrast mode).

## M4: Customer simulator, compose, seed data (Tue, about 4h)  [ ]
Deliverables
- [x] `apps/customer-sim` (link shown, opened only on tap; labeled "SANDBOX customer wallet (simulator, not a real wallet)"): paste or scan an LNURL, shows sats amount, pays through the demo backend, opens the receipt link. Labeled "simulated wallet".
- [~] (compose.yaml and Dockerfile updated, NOT RUN: no Docker here; no regtest profile; `pnpm demo` is the tested one-command path; seed is in-app "Load demo data") `docker compose up` brings server, sandbox profile and, if S1 allows, a regtest profile; `pnpm seed` creates "Awa's Fruit Stall".
- [ ] (not built; Wipe device then the demo shop and Load demo data does it by hand) `pnpm demo:reset` returns to the seeded state in under 10 seconds.
Acceptance: fresh clone to running golden path in under 5 minutes with two commands; five consecutive clean golden-path runs logged.
Edge cases: port conflicts, missing `.env`, regtest node not synced (healthcheck and clear error).

## M5: UI polish then FREEZE (Wed, until 18:00)  [ ]
- Copy pass in French and English, empty and error states, loading states, accessibility basics (contrast, focus, labels).
- Visible SANDBOX banner on the hosted build.
- Nothing from the stretch list unless every box above is checked.
**FREEZE at 18:00 EAT.** After that: bug fixes only.

## M6: Security proof and docs (Thu morning, about 4h)  [ ]
- `docs/THREAT_MODEL.md`: assets, trust boundaries, and a table of threats with the test that covers each. Threats to cover: amount tamper, QR replay, pre-payment code leak, receipt token guessing, stolen merchant phone (cannot move funds; revoke device), curious server operator (amounts visible; self-host option), NWC leak (receive-only), DoS and rate limits, FX manipulation, log leakage. State known limits plainly (offline confirm relies on the code, so reconcile is the backstop; merchant secret on a stolen unlocked phone can only create invoices to the merchant's own wallet).
- `pnpm test:security` script that runs only the abuse-case tests, for the video.
- `docs/ARCHITECTURE.md`, README with headings: problem and reach, quickstart, architecture, security, constraints, metrics, next steps, prior art (LNURLPoS, Blink, Wallet of Satoshi POS, LNbits TPoS), limitations.
- Run the submission audit: `python scripts/submission_audit.py` from the hackathon-winner skill.
Acceptance: every threat row names an existing test; README quickstart verified by a clean-clone dry run.

## M7: Deploy, video, submit (Thu to Fri, about 6h)  [ ]
- Deploy server and PWA (sandbox profile) to a public URL; check it logged out and on a mid-range phone over throttled network.
- Record last: real regtest or signet pay for the main take, sandbox for the hosted link. Script (2:50): 0:00 problem, 0:20 airplane mode and QR, 0:50 customer pays, 1:30 receipt code and PAID, 1:50 attack beat, 2:15 reconnect and reconcile, 2:35 architecture, one-command setup, next steps.
- Check video length under 3:00, captions in English (French captions if time).
- Fill the Devpost form, attach repo and video, save confirmation, open every link logged out.
Acceptance: submitted by 2026-11-20 14:00 UTC; confirmation saved.

## Stretch (only after M6 passes)
Signed Nostr receipt event; Wolof strings; second backend adapter demo; USSD-style "receipt by SMS" mock (clearly labeled). Everything else is cut.

## Open items
- Team size, payout and residency answers [UNKNOWN: Discord]
- Supported NWC backend for local testing [UNKNOWN: S1]
- Wallet support for url success action [UNKNOWN: S5]
- FX source [UNKNOWN: S4]

## Log
| Time | Phase | What happened / evidence |
|---|---|---|
| 2026-11-13 | P0 | Strategy and roadmap written |
| 2026-11-13 17:30 EAT | P0 M0 | Repo skeleton done: pnpm workspace (protocol, server, pos, customer-sim), MIT license, .env.example, quick-ops and scout agents. `pnpm lint`, `pnpm typecheck`, `pnpm test` (4 files, 4 tests passed) and `pnpm build` all exit 0. Discord questions not yet posted. |
| 2026-11-13 17:55 EAT | P2 M1 | Protocol package done per D1 to D6 (see docs/ARCHITECTURE.md). `pnpm --filter @jaay/protocol test`: 6 files, 127 tests passed, including Python known-answer vectors, 116 bit flips, 10,000-encode IV and sid uniqueness, bech32 oracle over 300 URLs and the LUD-01 vector. Token 78 chars, LNURL 201 chars with a 30-char base URL. Root lint, typecheck, test and build exit 0. Forbidden-import lint rule shown failing then passing. |
| 2026-11-13 19:30 EAT | P1 S1 | NWC GO. Alby Hub v1.24.6 on regtest LND v0.21.8 (btcd, native WSL, no Docker) with a local nak relay. `spikes/s1-nwc/probe.ts` 22/22 checks on two runs with @getalby/sdk and a nostr-tools client: get_info has no spend method, description_hash honored, settle seen by lookup_invoice in under 1.1 s, pay_invoice rejected with RESTRICTED and target invoice stayed OPEN. make_invoice median 144 to 310 ms. Chosen client: @getalby/sdk. Details in spikes/NOTES.md. Docs: hard rule 3, strategy section 4 and M2 requirements updated as authorized. Root lint, typecheck and build exit 0. Root test exits 1: the M1 test "digits are uniform over 20,000 samples" now takes about 10 s against vitest's 5 s default (passes with `--testTimeout=60000`, 127/127) on a loaded machine; packages/ is unchanged since M1, fix not made because S1 forbids touching packages/. |
| 2026-11-13 19:45 EAT | P1 test fix | Uniformity test given an explicit 30 s timeout (b58f74b, pushed). A second heavy M1 test, "10,000 encodes never repeat an IV or a sid", then hit the 5 s default in 2 of 3 runs on this loaded machine (CPU 63 to 73 percent from other apps); not changed, because Part 0 allowed only the one test. |
| 2026-11-13 20:20 EAT | P1 S3 | Offline PWA GO. `spikes/s3-offline/check.ts` 13/13 PASS on two runs in Chromium (Playwright 1.64.0): offline reload and full restart work, QR v8-M 49x49 at 5 px per module decodes to the exact LNURL string (alphanumeric), non-extractable DeviceKeys persist in IndexedDB and still work, offline ledger plus online reconcile stub, http LAN origin shown NOT secure, prompt-style SW update safe for offline users. First load 13.2 KB gzipped with qrcode-generator (chosen) vs 14.8 KB with qrcode. Real-phone airplane mode NOT RUN. |
| 2026-11-13 20:25 EAT | P1 S4 S5 | Research only, via two Sonnet subagents, spot-checked by Opus. S4: peg 655.957 verified at BCEAO; Kraken XBTEUR primary, Coinbase Exchange BTC-EUR fallback, 60 s server poll, 120 s quote lock. S5: url successAction shown behind a tap by Phoenix Android, Zeus, Alby Go (verified in source) and Alby extension; others UNKNOWN. Design: url action plus receipt URL in text/plain, receipt settlement-gated. Details in spikes/NOTES.md. |
| 2026-11-13 21:30 EAT | P2 M2 | Server built (apps/server, Hono, node:sqlite, esbuild bundle). 111 server tests green, covering security items 1 to 11 (uniform LNURL error, exact amount, replay and idempotency, receipt gating over every status, receipt token and rate limits, log scrubber with sentinels, size and header limits, CORS and CSP, NWC spend-method rejection, relay drop and reconnect with a fake transport, sealed secrets and a db byte scan). Bundle runs with plain node: golden path 10/10 PASS over HTTP. Regtest against real Alby Hub: golden path PASS, relay down fails closed in 218 ms, but Alby Hub did not re-subscribe after the local relay restarted (recovery FAIL, hub side). docker compose NOT RUN (no Docker). Reconcile endpoint not built (not in today's endpoint list). Added anti-SSRF allowlists after a security review. |
| 2026-11-14 09:55 EAT | P2 M3 A | Server additions, each test first: device-signed requests (A1), POST /v1/sales/reconcile (A2), POST /v1/wallet/summary (A3), JAAY_ENROLL_TOKEN for non-sandbox enrollment (A4), BOLT11 decode check on every invoice with light-bolt11-decoder (A5), PWA served at /app/ with a self-only CSP (A6). Server tests 141 green. |
| 2026-11-14 10:20 EAT | P2 M3 B | Merchant PWA (apps/pos, vanilla TS). Unit tests 140 green (ledger table all 99 pairs, attempt cap with crash, enrollment secret scan, reconcile merge, signing interop, i18n, money, no-console). Playwright e2e 9/9 on three runs: golden path, offline golden path with reconcile (paid, paid, mismatch), cold start offline, 3-code lock across reload, host and QR decode, update flow, first load 21.8 KB gzipped. Lighthouse NOT RUN; real phone airplane mode NOT RUN. |
| 2026-11-14 11:15 EAT | P3 M4 | Judge path. Server: fixed demo rate (SANDBOX only, labeled), /sandbox/seed and unseed, pay by payment hash, receipt label (escaped) and sats, /sim/ serving; 155 tests. Customer simulator at /sim/ (33 tests, 10.6 KB gz). PWA demo shop, sandbox helpers, demo data, PNG icons and manifest (148 tests counting demo). pnpm demo plus pnpm smoke: SMOKE OK (15 steps). e2e 13/13 on three consecutive runs, offline-safe (judge flow, manifest and icons, a to g, PWA 31.7 KB and simulator 10.6 KB gz). Docker and every hosting path NOT RUN. |
| 2026-11-17 12:00 EAT | P4 M5 (part) | Design review pass. Already fine: no horizontal scroll anywhere at 320/360/412 (EN, FR), simulator FR accents. Changed: sell order and Demo tools, check-code screen (attempts text from the persisted counter, sale identity, Back to sales, 6-digit gate), Wallet layout and demo tags, receipt pending (amount, waiting text, server last-checked) and paid (grouped code, keep-page note), simulator digit grouping, Reçu in LNURL metadata. Skipped item 8 (accent colour conflicts with CLAUDE.md). Server 157, pos 145, sim 33, protocol 127; e2e 14/14 at 320, 360 and 412 with the new layout step (84 checks). Screens refreshed (EN 360, FR set in docs/screens/fr). Real phones, Safari, Firefox NOT RUN. |
