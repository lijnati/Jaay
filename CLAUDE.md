# CLAUDE.md: Jaay

Jaay (Wolof, "to sell") is an open-source PWA point of sale that takes Lightning payments with the merchant phone in airplane mode. Built for the Dakar Bitcoin Hack by BTrust. Deadline 2026-11-20 20:00 UTC, internal submit-by 14:00 UTC, hard feature freeze 2026-11-18 18:00 EAT.

Read `docs/WINNING_STRATEGY.md` and `docs/ROADMAP.md` at the start of every session. They are the spec. If a request conflicts with them, say so before acting.

## How we work
- One milestone at a time, in the order of ROADMAP.md. Do only the milestone the user names. When its acceptance criteria pass, stop and report. Never start the next milestone on your own.
- Test first for protocol, crypto, server auth, replay, rate limit and reconcile logic. Write the failing test, then the code.
- A milestone is done only when `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` all pass and you have pasted the real command output. Never write "should work".
- Small commits with clear messages. Never commit `.env`, keys, NWC strings or node macaroons.
- Ask before: deleting files or branches, force pushing, adding a dependency not already in the plan, changing a public interface that a finished milestone depends on, anything involving real funds.
- Keep a running log in `docs/ROADMAP.md` (the Log table): time, phase, evidence.

## Model routing (cost control)
The main session runs on Opus 5.5. Use cheaper models for easy work through subagents (`.claude/agents/quick-ops.md` on Sonnet, `.claude/agents/scout.md` on Haiku), or the Agent tool's model override if available.
- Opus 5.5 (main session) does: all code in `packages/protocol` and `apps/server`, crypto, auth, replay, rate limiting, reconcile, the NWC adapter, tests for any of those, the threat model, architecture decisions, debugging anything non-obvious, and the final review of whatever a subagent produced.
- Sonnet 5.5 (`quick-ops`) does: scaffolding from an exact spec, config and boilerplate files, docker compose boilerplate, seed scripts, FR/EN string files, repetitive edits, simple lint or type fixes, README and docs tables, roadmap Log rows, running the test suite and summarizing failures, git housekeeping.
- Haiku (`scout`, read-only) does: repo search, summarizing long logs or command output, checking that every file has an expected header, listing what changed.
- Never hand a task that touches a Hard rule to a cheaper model without an Opus review before commit. Review the subagent's diff yourself; do not trust its summary.
- If a cheaper model fails the same task twice, take it over on Opus.
- Do tiny tasks directly. Delegate only batches of mechanical work, since delegation costs context.
- The user may switch the whole session with `/model` for a simple phase. Each prompt starts with a "Model:" line saying which model it is meant for.

## Hard rules (never break)
1. No mainnet. Regtest or signet only. Never touch real funds.
2. Every mock or simulation is labeled in the UI, README and video. The hosted demo shows a permanent SANDBOX banner.
3. The 6-digit confirm code is never rendered on the merchant screen and never sent in the payload. It is derived from the sale id with a device-key HMAC. The merchant only types a code, and the device recomputes and compares it in constant time (best effort in JS), with at most 3 attempts per sale.
4. The receipt page never reveals the confirm code before the invoice is settled.
5. The server's NWC connection must be receive-only. Refuse any connection that permits `pay_invoice`.
6. AES-GCM IVs are random 96-bit values, never a stored counter. Never reuse an IV with a key.
7. Fail closed on every parse, tag, auth or rate-limit error, and never reveal which check failed.
8. No PII, phone numbers, NWC strings, full payloads or raw device ids in logs. A log-scrubber test enforces this.
9. Server time is authoritative. Never trust the merchant device clock for security decisions.

## Stack and layout
- TypeScript strict, pnpm workspaces, Node 22.13+ (node:sqlite), vitest, eslint (flat config) and prettier. Playwright is added at M3.
- `packages/protocol`: pure TS (Web Crypto only), no Node-only APIs so it runs in the browser and on the server.
- `apps/server`: Hono on Node. Backend adapters behind one interface: `nwc`, `lnbits`, `sandbox`.
- `apps/pos`: Vite PWA, offline-first, IndexedDB for the sale ledger.
- `apps/customer-sim`: tiny page that acts as an LNURL-pay wallet for demo and tests.
- `infra/`: docker compose and seed scripts. `docs/`: strategy, roadmap, threat model, architecture.
- Prefer few dependencies. No analytics, no third-party scripts, no CDN assets.

## Product and UI
- French first, English toggle. Prices in XOF. Large touch targets, high contrast, works on mid-range Android over slow networks.
- Visual style (changed 2026-11-20 on the owner's instruction, for the hosted demo's first impression; replaces the earlier black and white, square-cornered style): calm, warm fintech per `docs/DESIGN.md`. Sand background, white cards, deep green primary actions, amber only as a small decoration (logo dot, active tab), status colours with icon plus word, 16 px card and 12 px control radius, soft shadows, system fonts, inline SVG icons. Every token lives in `apps/pos/src/tokens.css`; the receipt repeats them and a test keeps them in sync. Lowercase `jaay` wordmark. Contrast is WCAG AA for every text and control pair (table in DESIGN.md).
- Budgets: receipt page under 20 KB, POS shell fully usable offline after first load.

## Writing
- README, docs, UI copy and commit messages: plain prose, no em dashes.
- README headings: problem and reach, quickstart, architecture, security, constraints, metrics, next steps, prior art, limitations. Name prior art honestly (LNURLPoS, Blink Terminal, Wallet of Satoshi POS, LNbits TPoS).

## Out of scope
Tontines, savings circles, generic wallets, AI features, real mobile money API calls, USSD. These live in the stretch list only, after M6 passes.
