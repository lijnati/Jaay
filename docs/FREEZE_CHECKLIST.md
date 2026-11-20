# Freeze checklist

Feature freeze: 2026-11-18 18:00 EAT. After it, bug fixes only. Updated 2026-11-17 at the end of M6. This file did not exist before M6; it starts here.

## Green now (evidence in docs/VERIFY.md and docs/ROADMAP.md)

- [x] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` green three times in a row with all CPU cores busy.
- [x] Unit and property tests: protocol 127, server 169, PWA 146, simulator 33. Fuzz and property tests with a fixed seed: no bug found.
- [x] Playwright e2e 14/14 at 320, 360 and 412 px, including offline golden path, cold start offline, attempt cap, reconcile flags, update flow, no horizontal scroll in EN and FR.
- [x] Threat model: 27 threats, every row names existing tests (`pnpm security:matrix`, also inside `pnpm test`); `pnpm test:security` runs them.
- [x] Clean clone to green e2e in about 4 min 40 s with no manual step.
- [x] Size budgets: PWA first load 32.4 KB gzipped (150 KB budget), simulator 10.7 KB (40 KB), receipt page 1,360 bytes (15 KB).
- [x] `pnpm audit --prod`: no known vulnerabilities. Full tree: 1 moderate in dev tooling only (minimatch under eslint), assessed in DEPENDENCIES.md.
- [x] Secret scan (grep based) over the working tree and all 41 commits: clean. `.gitignore` covers .env files, macaroons, keys, SQLite files and the demo master key.
- [x] Licenses: production MIT plus one Unlicense (nostr-tools), accepted; MPL-2.0 and BlueOak only in dev tools.
- [x] SANDBOX labeled in the PWA banner, the simulator, the receipt page, `/healthz`, the LNURL metadata text and every doc.
- [x] Every user-visible string exists in EN and FR (PWA, simulator, receipt), enforced by tests.
- [x] README, PITCH, DEMO_SCRIPT, French one-pager, SECURITY, CONTRIBUTING, LICENSE (MIT), CI workflow file.

## Not done or NOT RUN (owner action before or at submission, M7)

- [x] GitHub repository public; CI green on GitHub Actions (Node 24 from `engines`, same test counts as local).
- [x] SANDBOX build deployed on Render (free plan): https://jaay-demo-qzku.onrender.com, smoke test green against it (2026-11-17).
- [ ] Real phones (mid-range Android, iOS), Safari, Firefox: NOT RUN.
- [ ] Lighthouse and throttled-network measurements: NOT RUN (no PERFORMANCE.md exists; README says so).
- [ ] Docker compose: NOT RUN (no Docker here).
- [ ] Static analysis (semgrep, CodeQL): NOT RUN, not installable here.
- [ ] Submission audit (`scripts/submission_audit.py` from the hackathon-winner skill): NOT RUN.
- [x] Interview-evidence tags removed (2026-11-19); the docs make no claim about merchants or users.
- [ ] French texts (README.fr, PITCH elevator pitch, UI strings) reviewed by a French speaker; Wolof name checked by a Wolof speaker.
- [ ] Discord questions from the roadmap (solo entry, wallet eligibility, payouts, hosted sandbox) still unanswered.
- [x] Video: 30 s launch film (media/film.html, rendered 1080p60), on YouTube and embedded in the Devpost project.
- [x] Devpost project submitted to Dakar Bitcoin Hack by BTrust (2026-11-20): https://devpost.com/software/jaay-sell-without-signal

## Go or no-go for the freeze

GO. No open bug, all automated checks green, nothing left that needs a feature. The remaining items are deployment, evidence and submission work for M7, none of which changes product code.
