# WINNING STRATEGY: Jaay @ Dakar Bitcoin Hack by BTrust

Name: Jaay (Wolof, "to sell"; spelling and tone still to be confirmed by a Wolof speaker). Tagline: "Sell without signal." French: "Vendez sans réseau." Wordmark: lowercase `jaay`, black and white, signal-bars glyph with an airplane cut through it.

Evidence tags: [VERIFIED: source], [INFERRED], [UNKNOWN: how to resolve]. Written 2026-11-13. Assumes solo, strong full-stack, about 45 focus hours, building with Claude Code.

## 0. Clock and constraints
- Deadline: 2026-11-20 20:00 UTC (23:00 EAT). Internal submit-by: 2026-11-20 14:00 UTC (17:00 EAT). [VERIFIED: devpost overview and rules]
- Online, no start date shown, submission window Oct 26 to Nov 20. [VERIFIED: rules page]
- Submission needs: presentation (text or video), public GitHub repo, working MVP online or demo video, and "a Bitcoin/Lightning wallet implementation". [VERIFIED: overview + rules]
- Results must be open source. [VERIFIED: overview]
- Prizes: 500k / 250k / 100k sats (rules page) vs $500 / $250 / $150 of BTC (overview). Small. The real prize is visibility with Btrust, which funds African Bitcoin developers through grants. [VERIFIED: overview, rules; grant programs via btrust.tech]
- Eligibility: participants should reside in Africa; overview also says "students only" and lists companies as excluded. [VERIFIED] Team size and payout mechanics: [UNKNOWN: ask organizers in Discord]
- Legal flag: Ethiopia's central bank prohibits use, transfer and facilitation of virtual assets absent authorization (July 2026 notice). [VERIFIED: binance square summary of NBE notice, lexafrica] Develop and demo on regtest or signet only. No mainnet sats from Ethiopia. Not legal advice.

## 1. Track and rationale
- No formal tracks. One pool, three prizes. Categories listed: Blockchain, Fintech, ML/AI. [VERIFIED]
- Field right now: 24 submissions, 237 registered. [VERIFIED: gallery, participants count as of 2026-11-12] Last year: 15 submissions from about 199 registrants. [VERIFIED: 2025 gallery, devpost page] So expect roughly 25 to 45 final entries. [INFERRED]
- Base rate to place: about 3 in 35, near 8%. A compliant, differentiated entry with a visible demo moment: roughly 25 to 30%. [INFERRED, not a promise]
- Crowded this year (avoid): savings circles and tontines (4+), generic merchant payment apps (about 4), scam-guard wallets (3), AI agent payment consoles (3). [VERIFIED: gallery list] Empty: offline-first merchant tools, developer tooling, education. [VERIFIED: gallery list]

## 2. Judging criteria and scoring plan
Published criteria, no weights. [VERIFIED] Rules page adds originality and technicality, and says judges mainly focus on an MVP that can be tested. [VERIFIED]

| Criterion | Full marks looks like | Our evidence | Where judges see it |
|---|---|---|---|
| Usefulness and local impact: real, well-scoped local problem, estimate reach | One merchant, one pain, a number for reach | Market sellers with patchy or expensive data. Reach estimate built from sourced numbers (Wave, which started in Senegal, reports millions of users; Machankura reports 39,000 connected phones across ten markets as a demand proxy). Only a few merchants accepted Bitcoin in Dakar as of 2023, so we state this honestly as a bootstrap-stage market. | README "Problem and reach", video 0:00 to 0:20 |
| Security by design: minimal attack surface, threat model, safe secrets, no PII in logs | A written threat model with tests that prove each claim | THREAT_MODEL.md, receive-only NWC scope, AES-GCM payloads, receipt gated on settlement, log-scrubber test, abuse-case tests | README "Security", /docs/THREAT_MODEL.md, `pnpm test:security` output in video 2:00 |
| UX/UI on low bandwidth and mid-range phones: fast flows, clear labels, simple copy | Works with no data, loads fast, French first | Merchant PWA fully offline after first load, receipt page under 20 KB, FR/EN copy, big keypad. Lighthouse run on throttled profile saved in repo | Video 0:20 airplane-mode shot, README budget table |
| Working MVP: end-to-end demo, one-command setup, seed data | `docker compose up` and a tested golden path | Compose stack with seeded merchant, hosted sandbox link, Playwright test that runs the golden path with the browser set offline | README quickstart, hosted URL, CI log |
| Clear pitch and docs: 3-minute demo, README with setup, architecture, constraints, metrics, next steps | Everything above in one screen each | 2:50 video, README structured to those exact headings | Devpost page, repo root |
| Originality / technicality (rules page) | Non-trivial mechanism, visible in repo | Offline AEAD payload protocol, FX-denominated offline pricing, settlement-gated receipt proof, offline ledger reconciliation | /packages/protocol, ARCHITECTURE.md |

## 3. Positioning
- Category judges will file it under: "merchant payments", the most crowded bucket. We must stand out inside it by being the only one that works with no merchant data connection and no extra hardware.
- One line: For market sellers whose data drops or runs out mid-sale, Jaay is a PWA point of sale that takes Lightning payments with the merchant phone in airplane mode. Unlike hardware LNURLPoS devices and online POS apps (Blink Terminal, Wallet of Satoshi POS, LNbits TPoS), it needs no hardware, prices in XOF offline, keeps the merchant's wallet receive-only, and reconciles every sale when the merchant reconnects.
- Why now: NWC is a listed resource and now the common wallet-connect standard; Btrust-backed events in Dakar this year keep rewarding merchant Lightning tools (RAK TAK CASH took first at Bitnob's Code & Chain Dakar). [VERIFIED: technext24 article, resources page]
- Honest prior art (name it in the README, it earns trust): LNURLPoS already does offline Lightning PoS with a hardware device, and an offline Android version exists. [VERIFIED: github arcbtc/LNURLPoS, darthcoin substack] The LNURLPoS author lists fiat denomination as an open problem because offline sats pricing is volatile. [VERIFIED: LNURLPoS README] We solve that.
- Competitor archetypes and how we beat them:
  - Generic "Lightning merchant app": we win on the offline demo moment and the security evidence.
  - Tontines and wallets: different problem, many near-duplicates, judges will be tired of them.
  - Education bots: no demo moment, repeat of last year's winner.
  - Another offline POS entry: would be rare; we win on completeness (reconciliation, threat model, tests).

## 4. Unique technical innovation
The hard part is four things working together, not any single trick:
1. Offline sale protocol: merchant device creates an AES-256-GCM encrypted payload (amount in XOF, random sale id, device id; the 6-digit confirm code is derived from the sale id with a device-key HMAC and is never sent) packed into an LNURL-pay QR. Tamper fails closed.
2. FX at scan time: because the payload carries XOF, the server converts to sats when the customer scans, with a short quote lock. Fixes the stale-rate problem of offline sats pricing.
3. Settlement-gated receipt: after the customer pays, the wallet shows a link (LUD-09 `url` success action). The receipt page reveals the confirm code only once the invoice is settled. A customer who scans but never pays cannot extract the code. [INFERRED design, wallet support for the url action: UNKNOWN, spike S5]
4. Reconciliation: every offline sale is logged locally with its sale id; when the merchant is online the device asks the server for the true status and flags any sale accepted on the code alone that was never paid.

How a judge verifies: `pnpm test` shows tamper, replay, pre-payment-leak and reconcile tests passing; the video shows the same attacks live.

## 5. Integration plan (Btrust-listed tech)
| Tech | Chosen use | Central because | Riskiest call | Evidence |
|---|---|---|---|---|
| Lightning + LNURL-pay | Customer wallet payment flow | The sale QR is an LNURL | Wallet compatibility with url success action | Screen recording with a real wallet on signet, if S5 passes |
| Nostr Wallet Connect (NIP-47) | Server creates and checks invoices on the merchant's own wallet via a receive-only connection | Merchant never gives the server spend rights | Finding an NWC wallet or service testable on regtest or signet (S1) | NWC permission list shown in setup screen, code path in repo |
| LNURLPoS lineage | Credited prior art for offline PoS | Positions us as a software evolution, not a copy | None | README prior-art section |
| Mobile money (Wave, Orange Money) | Stretch only: show XOF price and a "customer pays with MoMo via exchange" note | Not core | Do not touch real APIs | None needed |
| AI | Not forced. Theme lists it, rubric does not score it. | Not central | A bolted-on AI feature hurts the security story | If time remains after freeze: none. Do not add. |

Ask one specific question in Discord early: "Does a PoS plus receive-only NWC wallet view count as the required wallet implementation?" Judge Kelvin Isievwore is Btrust Head of Engineering. [VERIFIED: overview]

## 6. Golden-path demo (target 2:50, limit 3:00)
- Start state (seeded, deterministic): merchant "Awa's Fruit Stall" enrolled, XOF prices, sandbox or regtest backend funded.
- Steps:
  1. Merchant phone to airplane mode, status bar visible. Keypad: 2,500 XOF. QR appears.
  2. Customer wallet scans, shows ~sats amount, pays.
  3. Wallet shows receipt link; customer opens it; big 6-digit code.
  4. Merchant types the code. Device shows PAID, offline.
  5. Merchant reconnects; ledger reconciles; one sale accepted on a wrong flow is flagged unpaid.
- The moment: the airplane-mode status icon next to a green PAID.
- Attack beat (the security evidence, 20 seconds): edit one QR character -> rejected; open receipt before paying -> "not paid yet", no code; replay QR -> same invoice, no double sale.
- Proof on screen: regtest or signet payment hash in the merchant ledger, test output.
- Stretch (only after feature freeze and everything green): signed receipt as a Nostr event, Wolof copy. Cut otherwise.

## 7. Risks and mitigations
| Risk | Likelihood | Impact | Mitigation | Fallback trigger |
|---|---|---|---|---|
| Judge says "just LNURLPoS again" | High | High | Name prior art, lead with the four additions, show reconcile and gated receipt | None; this is a framing job |
| No testable NWC backend on regtest or signet | Medium | High | Backend adapter interface: NWC, LNbits invoice key (also receive-only), Sandbox (labeled fake) | S1 fails by 2026-11-14 22:00 EAT: ship LNbits adapter as primary, NWC as secondary |
| Real wallets ignore the url success action | Medium | Medium | Customer simulator page as guaranteed path; document supported wallets | S5 fails: show code on customer simulator and README states limit |
| Required "wallet implementation" read narrowly | Medium | High | Add a receive-only wallet screen (balance, recent receives) to the PWA | Organizer answer says no: nothing lost, we built it anyway |
| Hosted demo can't use real Lightning | Certain | Medium | Hosted URL runs Sandbox backend with a permanent SANDBOX banner and README note; video shows the real regtest or signet path | None |
| Scope creep | High | High | Stretch list above is the only home for extras; freeze 2026-11-18 18:00 EAT | Any M-milestone more than 6h late: cut reconcile UI polish first |
| Payout or eligibility problem (Ethiopia) | Medium | Medium | Ask organizers now; never use mainnet | Reply says ineligible: stop and report |
| Video over 3:00 | Low | Medium | Script timed to 2:50, record last, check duration | None |

## 8. Win conditions (must be true at submission)
- [ ] Golden path passes 5 times in a row on a fresh clone with `docker compose up`, and on the hosted sandbox.
- [ ] Playwright golden-path test runs with the browser context offline and is green.
- [ ] Security tests green: tamper, replay, pre-payment leak, rate limit, log scrubber.
- [ ] THREAT_MODEL.md, ARCHITECTURE.md and README with these headings: problem and reach, quickstart, architecture, security, constraints, metrics, next steps.
- [ ] Receipt page under 20 KB; POS shell works offline after first load; Lighthouse throttled result saved.
- [ ] Video 2:30 to 2:55 showing airplane mode, a real pay on regtest or signet, and the attack beat.
- [ ] Public repo with license, open source, no secrets, commits inside the event window or pre-existing code disclosed.
- [ ] Submission fields complete and checked logged out.
- [ ] Every mock labeled in UI, README and video.

## 9. Assumptions to test first
| Assumption | Cheapest test | When |
|---|---|---|
| A receive-only NWC connection can make_invoice and lookup_invoice against a backend I can run locally | Spike S1 with a tiny client script | 2026-11-13 |
| Web Crypto AES-GCM plus bech32 LNURL fits a readable QR and decodes server-side | Spike S2 | 2026-11-13 |
| A PWA shell and sale logic run fully offline | Spike S3 with Playwright `setOffline(true)` | 2026-11-14 |
| A usable FX source exists, or a labeled fixed rate is acceptable | Spike S4 | 2026-11-14 |
| At least one common wallet renders the url success action | Spike S5 | 2026-11-14 |

## 10. Plan attack
- "How would I beat this as a competitor?" Ship a hardware-free offline POS with a better demo. Mitigation: depth (tests, threat model, reconcile) is the part that takes the most hours to copy.
- "What would a Btrust engineer call shallow?" The crypto itself (it is a known pattern). So the README says that, and the weight goes on the product and the security posture around it.
- "What would a market judge say?" Small market today. Answer with the honest reach estimate and the next step: pilot with one Bitcoin-accepting merchant in Dakar.
- "Which assumption kills it?" S1 (backend for invoices). Tested first.

**Verdict: GO WITH CHANGES.** Frame as software evolution of LNURLPoS with named additions, add the receive-only wallet view, and run spikes S1 to S5 before building.
