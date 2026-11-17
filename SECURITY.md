# Security policy

## Reporting a vulnerability

Open a private GitHub security advisory on this repository (the Security tab, then "Report a vulnerability"). Do not open a public issue for a vulnerability. Include steps to reproduce and the version or commit.

## Scope

- `packages/protocol`
- `apps/server`
- `apps/pos` (the merchant PWA)
- `apps/customer-sim`

## Out of scope

- The sandbox demo being fake. Simulated payments, no real bitcoin and the fixed demo rate are by design.
- Third-party wallets and wallet services.

## SANDBOX note

Jaay is a hackathon project. The demo is SANDBOX only: no mainnet, no real funds. Real Lightning was only exercised on regtest.

## More

Design, assumptions and known limits: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
