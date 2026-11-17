# Dependencies, licenses and audit

Recorded 2026-11-17 (M6). Versions are the exact ones in `pnpm-lock.yaml`. Release dates are from `npm view <pkg> time` for that exact version. Sizes: the server is one esbuild bundle (`apps/server/dist/server.mjs`, 420 KB, not minified), measured per dependency with an esbuild metafile; the PWA size is the gzipped first load measured by the e2e suite.

## Production dependencies (shipped or run in production)

| Package | Used by | Version | License | Released | Why it is needed | Size cost |
|---|---|---|---|---|---|---|
| hono | server | 4.13.17 | MIT | 2026-11-07 | HTTP routing, body limits, CORS | 57.5 KB of the server bundle |
| @hono/node-server | server | 2.1.8 | MIT | 2026-11-12 | Runs Hono on Node's HTTP server (header size limit, 431) | 48.0 KB |
| @getalby/sdk | server | 9.0.0 | MIT | 2026-10-27 | Nostr Wallet Connect (NIP-47) client for make_invoice and lookup_invoice | 208.7 KB (includes its own bundled crypto) |
| light-bolt11-decoder | server, simulator | 3.2.0 | MIT | 2024-09-20 | Decodes every invoice before it reaches a wallet (network, amount, payment hash, description hash, expiry) | 10.7 KB server; part of the simulator's 10.7 KB gz |
| qrcode-generator | PWA | 2.0.4 | MIT | 2025-08-07 | Draws the sale QR offline, level M | Part of the PWA's 20.6 KB gz JavaScript |
| Jaay's own code (protocol, server) | server | | MIT | | | 72.4 KB of the server bundle |

The protocol package has no runtime dependency (Web Crypto only). The server also uses Node built-ins only (`node:sqlite`, `node:crypto`).

Transitive production packages (through @getalby/sdk): @getalby/lightning-tools 9.0.2 (MIT), nostr-tools 2.26.0 (Unlicense), @noble/ciphers 2.1.1, @noble/curves 2.0.1, @noble/hashes 2.0.1, @scure/base 1.1.1 and 2.0.0, @scure/bip32 2.0.1, @scure/bip39 2.0.1, @webbtc/webln-types 3.0.0 (all MIT). typescript 6.0.3 (Apache-2.0) is listed only as a peer of nostr-tools; it is not in the bundle.

## License check

Command: `pnpm licenses list --prod --json` and `pnpm licenses list --json` (all packages, dev included).

| License | Production packages | All packages | Assessment |
|---|---|---|---|
| MIT | 13 | 116 | OK |
| Apache-2.0 | 1 (typescript, peer only) | 18 | OK |
| BSD-2-Clause, BSD-3-Clause, ISC | 0 | 14 | OK |
| Unlicense | 1 (nostr-tools) | 1 | Flagged by the rule (not MIT, Apache-2.0, BSD or ISC). It is a public-domain dedication with no conditions, compatible with MIT distribution. Accepted |
| MPL-2.0 | 0 | 4 (@resvg/resvg-js and its Windows binary, lightningcss and its Windows binary) | Flagged. Dev and build tools only (icon rendering script, Vite's CSS step); none of their code ships in the app. File-level copyleft would apply only if we modified and distributed those files. Accepted |
| BlueOak-1.0.0 | 0 | 1 (minimatch, under eslint) | Flagged. Permissive license, dev tool only. Accepted |

Jaay itself is MIT (see LICENSE).

## pnpm audit

Command: `pnpm audit` (full tree) and `pnpm audit --prod`.

- Production: **No known vulnerabilities found.**
- Full tree: **1 moderate**, GHSA-g3hv-75wg-m249, minimatch 7.0.0 to 11.0.0 (potential denial of service through brace-pattern amplification), reached through eslint and typescript-eslint. Assessment: dev tooling only, it runs on our own glob patterns, never on user input, and nothing of it ships. Not upgraded (the milestone forbids automatic upgrades); it goes away when eslint updates its minimatch range.

## Development dependencies

eslint, typescript-eslint, prettier, typescript, tsx, vitest (root); esbuild, fast-check (server); vite, playwright, fake-indexeddb, jsqr, pngjs, @resvg/resvg-js (PWA); vite (simulator); bech32 (protocol, test oracle only). None of them ships to a phone or runs in the production server.

## Supply-chain controls

- `pnpm install --frozen-lockfile` everywhere (CI and the Dockerfile). pnpm 11 checks the lockfile against its supply-chain policy on install ("Lockfile passes supply-chain policies" in the install log).
- Build scripts are allowed only for esbuild (`allowBuilds` in pnpm-workspace.yaml).
- No CDN, no web fonts, no analytics, no third-party request from any page; the CSP enforces `'self'`.
- Exact versions for every production dependency (no caret ranges in `dependencies`).

## Secret scan

No gitleaks or trufflehog is installed on this machine, so the scan is grep-based: `bash scripts/secret-scan.sh`. It looks for real NWC strings (`nostr+walletconnect://` with a 64-hex secret), private key blocks, AWS and GitHub tokens, `sk_live_`, `xprv`, `nsec1`, filled-in `JAAY_MASTER_KEY=` and `JAAY_ENROLL_TOKEN=`, macaroon hex and LNbits `X-Api-Key` values, in the working tree (tracked and untracked, not ignored) and in every commit of `git log -p --all`. It also lists any `.env`, `.macaroon`, `.pem`, `.key`, SQLite or master key file ever committed.

Result on 2026-11-17 (41 commits): working tree no hits, history no hits, secret-bearing files none. Exit 0. The scanner was checked by planting a random, real-shaped NWC string in an untracked file: it was reported, then the file was deleted.

`.gitignore` covers `.env` and `.env.*` (except `.env.example`) in every directory including `spikes/**`, `*.macaroon`, `*.pem`, `*.key`, SQLite files (`*.sqlite`, `*.sqlite3`, `*.db` and its WAL files) and `.demo/` (the demo master key). `git ls-files -ci --exclude-standard` shows no tracked file is ignored.

## Static analysis

NOT RUN. Semgrep could not be installed (Windows has no supported build; WSL Python has no pip or ensurepip), and the CodeQL CLI is not installed. eslint with typescript-eslint runs in every check.
