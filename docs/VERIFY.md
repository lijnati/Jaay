# Clean-clone verification

Run 2026-11-17 (M6) on Windows 10 with Git Bash. Script: clone the committed HEAD into a new empty temp directory and run every documented step, timing each one. Log kept outside the repo; the key output lines are copied below.

## Environment

| Item | Value |
|---|---|
| Node | v24.18.0 (`engines.node` is `>=22.13`, needed for the built-in `node:sqlite`) |
| pnpm | 11.13.1 (pinned by `packageManager`, enabled with `corepack enable`) |
| git | 2.43.0.windows.1 |
| Commit | `401964a` (cloned from the local repository; later M6 commits change docs only) |

## Steps

| # | Command | Result | Duration |
|---|---|---|---|
| 1 | `git clone <repo> jaay` | OK | 3 s |
| 2 | `pnpm install --frozen-lockfile` | OK, 158 packages, "Done in 41.8s" | 44 s |
| 3 | `pnpm lint` | OK | 45 s |
| 4 | `pnpm typecheck` | OK | 18 s |
| 5 | `pnpm test` | OK: protocol 127, server 169, PWA 146, simulator 33; "threat matrix: 27 rows, 70 test references, every referenced test exists" | 29 s |
| 6 | `pnpm build` | OK | 7 s |
| 7 | `pnpm demo` (background) | Ready (healthz answered) after 2 s; printed the three URLs | 2 s |
| 8 | `pnpm smoke` | `SMOKE OK`, 13 PASS lines, receipt page 1,360 bytes, "replay after paid is refused generically" | 7 s |
| 9 | `pnpm --filter @jaay/pos exec playwright install chromium` | OK | 4 s (see caveat) |
| 10 | `pnpm --filter @jaay/pos test:e2e` | `ALL 14 E2E CHECKS PASSED`, elapsed 72 s | 78 s |

From an empty directory to a green e2e run: about 4 minutes 40 seconds of command time, without any manual step or extra file. Nothing had to be fixed for the clean clone.

## Smoke output (step 8)

```
PASS  GET /app/  (200, CSP self)
PASS  GET /sim/  (200, CSP self)
PASS  server is SANDBOX  ({"status":"ok","fx":"fixed demo rate","sandbox":true})
PASS  GET /healthz  ({"status":"ok","fx":"fixed demo rate","sandbox":true})
PASS  POST /api/enroll (sandbox)  (device secret returned once, not printed)
PASS  device encodes sale offline  (1000 XOF)
PASS  GET /lnurlp  (2500000 msat)
PASS  GET /lnurlp/cb  (sandbox invoice (zero signature, unpayable by wallets))
PASS  receipt before payment has no code
PASS  POST /sandbox/pay/:sid  ({"sandbox":true,"status":"paid"})
PASS  receipt after payment shows the protocol-derived code
PASS  receipt page  (1360 bytes)
PASS  replay after paid is refused generically
SMOKE OK
```

## Caveats (honest limits of this check)

- Same machine, not a fresh one: pnpm reused 64 of 158 packages from the machine's content store, and Playwright's Chromium was already in the machine-wide cache, so the install and browser download times above are lower than on a new computer. On a new machine `playwright install chromium` downloads the browser (on the order of 100 MB).
- No global tool was assumed beyond Node, Corepack and git: `tsx`, `vitest`, `eslint`, `vite`, `esbuild` and `playwright` all come from the lockfile.
- Docker (`docker compose up`): NOT RUN (Docker is not installed here).
- Linux and macOS: NOT RUN locally. The CI workflow (`.github/workflows/ci.yml`, Ubuntu) runs install, lint, typecheck, test, build and the threat matrix, but it has NOT RUN yet (it needs the repository on GitHub with Actions enabled).

## Test determinism under load (M6 item 1)

`pnpm test` was run three times in a row while a background script kept all 8 CPU cores busy (one busy-looping worker thread per core). All three runs passed:

| Run | protocol | server | PWA | simulator | Exit | Wall time |
|---|---|---|---|---|---|---|
| 1 | 127 | 157 | 145 | 33 | 0 | 60 s |
| 2 | 127 | 157 | 145 | 33 | 0 | 41 s |
| 3 | 127 | 157 | 145 | 33 | 0 | 41 s |

These runs were before the fuzz tests and i18n tests were added; the final repeat with the full suite is in the table below.

A first attempt under the same load failed in three places, which is what this item was for:
- NWC relay-timeout test measured wall time: now uses fake timers (the timeout fires at exactly 150 ms of virtual time; "fails fast" is proven by never advancing the clock).
- IV and sid uniqueness test ran 10,000 sequential encodes under a 30 s cap: now 2,000 encodes (collision odds about 2^-75) with a 120 s safety timeout.
- Confirm-code uniformity test (20,000 HMACs, needed for the statistics) now runs in parallel batches of 500 with a 180 s safety timeout; LNbits tests over real loopback HTTP use a 30 s backend timeout instead of 2 s.
- Package test timeouts raised from 30 s to 120 s as a safety net only.

Remaining timing-sensitive tests, and why they are safe:
- `apps/server/src/app.test.ts` "unknown devices still run a full decrypt (same timing path)" checks that a decrypt happens (decoy keys), not how long it takes.
- NWC backend tests with a 200 ms or 100 ms timeout use an in-process fake wallet whose promise resolves before any timer can fire (microtasks run before timers), so load cannot reorder them.
- The Playwright e2e waits on page state with explicit timeouts (15 to 30 s); it never asserts a duration.

## Final gate, full suite under load (M6 checks)

`pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build`, three times in a row, all 8 cores busy with the burner script, on the final M6 code (fuzz and i18n tests included):

| Run | lint | typecheck | test (protocol, server, PWA, simulator) | threat matrix | build | Wall time |
|---|---|---|---|---|---|---|
| 1 | 0 | 0 | 0 (127, 169, 146, 33) | 27 rows, 70 references, all exist | 0 | 168 s |
| 2 | 0 | 0 | 0 (127, 169, 146, 33) | same | 0 | 174 s |
| 3 | 0 | 0 | 0 (127, 169, 146, 33) | same | 0 | 194 s |
