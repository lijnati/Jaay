# Contributing

## Setup

Node 22.13 or newer and pnpm 11 via corepack.

```bash
corepack enable
pnpm install
pnpm demo
```

## Checks

All four must pass before a change is done:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

End-to-end tests:

```bash
pnpm --filter @jaay/pos exec playwright install chromium   # once
pnpm --filter @jaay/pos test:e2e
```

## Rules

- No mainnet. Regtest or signet only, never real funds.
- No secrets in the repo: no `.env`, keys, NWC strings or macaroons.
- Plain prose, no em dashes, in docs, UI copy and commit messages.
- Small commits with clear messages.
- Tests first for protocol, crypto and auth logic.
- Every mock or simulation is labeled SANDBOX.
