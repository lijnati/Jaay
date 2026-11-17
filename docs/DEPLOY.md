# Deploying the public SANDBOX demo

## Status

None of these hosts has been deployed to yet (NOT RUN). The Docker image (`apps/server/Dockerfile`) has not been built (NOT RUN), because Docker was not available. The configs in `deploy/` are drafts to test. Facts below carry tags from a research pass on 2026-11-14: VERIFIED with a URL, INFERRED, or UNKNOWN.

## Overview

The public demo is SANDBOX only. Hard rule 1 forbids mainnet and real funds. The sandbox shows the whole flow with simulated payments, and the UI shows a permanent SANDBOX banner. A real regtest or signet backend needs `JAAY_ENROLL_TOKEN`, an allowlisted relay and an operator. See `apps/server/.env.example`.

The build produces `apps/server/dist/server.mjs` (one bundled file, no node_modules at runtime), `apps/pos/dist` (merchant PWA) and `apps/customer-sim/dist` (SANDBOX customer simulator). Pages: `/app/` merchant PWA, `/sim/` customer simulator, `/r/<token>` receipts, `/lnurlp` LNURL-pay.

## Requirements

- HTTPS. Web Crypto and service workers only work in a secure context. A phone on plain `http://<lan-ip>` gets no crypto and no offline app.
- Node 22.13 or later (uses `node:sqlite`). pnpm 11.13.1 via corepack (from `packageManager` in package.json).
- A persistent volume for the SQLite file.
- `--production=false` matters: hosts often set `NODE_ENV=production` for the build too, and pnpm then skips devDependencies (Vite, esbuild), so the build would fail. Checked locally with `NODE_ENV=production pnpm install --frozen-lockfile --production=false`.
- Build from the repo root: `corepack enable && pnpm install --frozen-lockfile --production=false && pnpm build`.
- Start from the repo root: `node apps/server/dist/server.mjs`. It listens on PORT (default 8787) on 0.0.0.0.
- Health check: `GET /healthz` returns `{"status":"ok","fx":"fixed demo rate","sandbox":true}`.

| Variable | Value | What it does |
| --- | --- | --- |
| NODE_ENV | production | Production mode. |
| SANDBOX | 1 | Enables the sandbox backend and the banner. |
| JAAY_FX_FIXED_XOF_PER_BTC | 40000000 | Fixed demo rate. Allowed only with SANDBOX=1. Labeled "fixed demo rate" everywhere. |
| JAAY_BASE_URL | https://your-host | Must be https and the exact public origin wallets and phones use. |
| JAAY_MASTER_KEY | secret | 32 random bytes, base64. Set only as a platform secret, never in a committed file. |
| DB_PATH | /data/jaay.sqlite | SQLite file, on a persistent volume. |
| JAAY_POS_DIR | apps/pos/dist | Merchant PWA files, relative to the start directory. The Docker image sets /app/pos already. |
| JAAY_SIM_DIR | apps/customer-sim/dist | Simulator files, relative to the start directory. The Docker image sets /app/sim already. |
| PORT | per platform | Port to listen on. |

`JAAY_ENROLL_TOKEN` is not needed for a sandbox-only server.

## Generate the master key

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Paste the output into the platform secret store. Do not commit it.

## What happens without a volume

The SQLite file is lost on every redeploy or restart. The server starts fine with an empty database, but every enrolled device stops working (its device id is unknown). Each device must be wiped and re-enrolled: Settings, Wipe device, then "Try the sandbox demo shop". Without a volume, set `DB_PATH=/tmp/jaay.sqlite` (or another writable path), because `/data` will not exist. Losing or changing `JAAY_MASTER_KEY` has the same effect.

## Fly.io

Config file: `deploy/fly.toml`. Uses our Dockerfile.

Risk to check first [UNKNOWN]: the image runs as the non-root `node` user, and a mounted volume may be owned by root. If the server cannot write `/data/jaay.sqlite`, it fails at startup (watch `fly logs`). Fixes to try: set `DB_PATH` to a path the `node` user owns, or change ownership of the mount at start. This has not been tested.

Steps, from the repo root:

1. Install flyctl and log in yourself. Change `app` in `deploy/fly.toml` and `JAAY_BASE_URL` to match.
2. `fly apps create <name>` (or let `fly launch` do it, without overwriting the config).
3. `fly volumes create jaay_data --size 1 --region cdg`
4. `fly secrets set JAAY_MASTER_KEY=<value>`
5. `fly deploy --config deploy/fly.toml --dockerfile apps/server/Dockerfile`

Facts:

- [VERIFIED: https://fly.io/docs/reference/builders.md] The Dockerfile builder is the default when a Dockerfile exists.
- [VERIFIED: https://fly.io/docs/reference/configuration.md] Buildpacks are possible via `[build]` builder/buildpacks.
- fly.toml keys [VERIFIED: https://fly.io/docs/reference/configuration.md]: app, primary_region, `[build]` dockerfile, `[env]`, `[http_service]` internal_port (default 8080), force_https, auto_stop_machines, auto_start_machines, min_machines_running, `[[http_service.checks]]` path/grace_period/interval/timeout, `[mounts]` source and destination.
- [VERIFIED: https://fly.io/docs/volumes/overview.md] Volumes are local persistent storage. One volume attaches to one Machine.
- [VERIFIED: https://fly.io/docs/reference/configuration.md] The root filesystem is ephemeral.
- [VERIFIED: https://fly.io/docs/apps/secrets.md] `fly secrets set KEY=value`. Changing secrets restarts Machines.
- [VERIFIED: https://fly.io/docs/reference/configuration.md] Default host is appname.fly.dev.
- [VERIFIED: https://fly.io/docs/about/pricing.md] No free tier for new orgs. shared-cpu-1x 256MB is about $2.19 per 30 days. Volumes are $0.15/GB/month.
- [VERIFIED: https://fly.io/docs/launch/autostop-autostart.md] Autostop is what `fly launch` writes by default. For a week-long demo we set `auto_stop_machines = "off"` and `min_machines_running = 1`.
- [INFERRED] `fly deploy` builds on Fly's remote builder, so no local Docker is needed.

Unknown:

- [UNKNOWN] Whether `fly launch` builds Node with no Dockerfile at all.
- [UNKNOWN] Automatic TLS wording (force_https exists).
- [UNKNOWN] Whether Fly injects PORT. We set PORT=8080 and internal_port=8080.
- [UNKNOWN] The exact resolution rule for `[build] dockerfile`. Test it.

## Railway

Config file: `deploy/railway.json` (build and start without Docker). Railway reads railway.toml or railway.json by default, so it may need to sit at the repo root or be selected in the service settings (not checked).

Steps:

1. Create a project from the GitHub repo in the Railway dashboard.
2. Use `deploy/railway.json` as the config (copy to the repo root if needed).
3. Set variables in the dashboard: NODE_ENV=production, SANDBOX=1, JAAY_FX_FIXED_XOF_PER_BTC=40000000, JAAY_BASE_URL, JAAY_MASTER_KEY, DB_PATH=/data/jaay.sqlite, JAAY_POS_DIR=apps/pos/dist, JAAY_SIM_DIR=apps/customer-sim/dist. Do not set PORT.
4. Add a volume in the dashboard with mount path `/data`.
5. Generate a public domain, put it into JAAY_BASE_URL, redeploy.

Facts:

- [VERIFIED: https://docs.railway.com/builds/build-and-start-commands.md] Railpack auto-detects build and start.
- [VERIFIED: https://docs.railway.com/reference/config-as-code] railway.toml or railway.json are read by default. Keys: startCommand, buildCommand, healthcheckPath, healthcheckTimeout, restartPolicyType.
- WARNING [VERIFIED: https://docs.railway.com/reference/config-as-code] That page says Config as Code is deprecated in favor of Infrastructure as Code, and legacy files keep working until 2026-12-01. Plan to revisit after that date.
- [VERIFIED: https://docs.railway.com/deployments/healthchecks.md] Railway injects PORT.
- [VERIFIED: https://docs.railway.com/volumes.md] Volumes are mounted at start, not during build. RAILWAY_VOLUME_MOUNT_PATH is exposed. Volumes are added in the dashboard.
- [VERIFIED: https://docs.railway.com/reference/pricing/plans.md] Free plan: $1 credit per month, 0.5 GB volume.
- [VERIFIED: https://docs.railway.com/networking/public-networking.md] Automatic SSL.
- [VERIFIED: https://docs.railway.com/deployments/serverless.md] Serverless sleeps 5 to 10 minutes after last outbound traffic. Keep it off for the demo.

Unknown:

- [UNKNOWN] Exact domain format.
- [UNKNOWN] Default state of serverless.

## Render

**Deployed 2026-11-17: https://jaay-demo-qzku.onrender.com** (service `jaay-demo-qzku`, workspace team, Frankfurt, free plan, auto-deploy on push to `master`). Created through the Render Blueprint API from `render.yaml`; Render named the service `jaay-demo-qzku` because the Blueprint adds a random suffix to new resources, and `JAAY_BASE_URL` was set to that exact origin. The service answered `/healthz` about 30 s after the sync was approved.

Verification against the live URL: `pnpm smoke https://jaay-demo-qzku.onrender.com` printed 13 PASS lines and `SMOKE OK` (app and simulator served with the strict CSP, SANDBOX and fixed demo rate reported, sandbox enrollment, LNURL request and callback, receipt without code before payment, simulated payment, receipt with the protocol-derived code, 1,360-byte receipt page, replay after payment refused). In a browser at 375 x 812, the demo shop enrolled against `jaay-demo-qzku.onrender.com` and a 2,500 F sale showed its QR, host and countdown. Real phones: NOT RUN.

Config file: `render.yaml` at the repository root (Blueprint, native Node runtime, free plan, SANDBOX).

Steps:

1. In the Render dashboard: New, Blueprint, connect the GitHub repository `lijnati/Jaay`, branch `master`.
2. When prompted, enter `JAAY_BASE_URL` as `https://jaay-demo.onrender.com` (the service name is `jaay-demo`). `JAAY_MASTER_KEY` is generated by Render (`generateValue`), so nobody types or sees it.
3. Apply. Render builds and starts the service. If the URL on the service page differs from the guess, update `JAAY_BASE_URL` in Environment and redeploy.
4. Run `pnpm smoke https://<host>` from your machine.

Free plan behaviour (chosen on purpose for the SANDBOX demo):

- The service sleeps after 15 minutes without traffic; the first request after that waits while it starts.
- There is no persistent disk, so the SANDBOX database (`/tmp/jaay.sqlite`) resets on every restart or deploy. A phone set up before a restart taps Settings, Wipe this device, then Try the sandbox demo shop again.
- `TRUST_PROXY=1` makes rate limits per visitor using the first `X-Forwarded-For` entry. A client can put its own value there, so this only spreads the limits; it is not an access control.

Facts:

- [VERIFIED: https://render.com/docs/web-services.md] Native Node runtime, Docker optional.
- [VERIFIED: https://render.com/docs/blueprint-spec.md] Blueprint keys: runtime: node, buildCommand, startCommand, healthCheckPath, region, plan, numInstances, envVars (sync: false prompts in the dashboard), disk with name, mountPath, sizeGB.
- [VERIFIED: https://render.com/docs/node-version.md] Node version via NODE_VERSION env, .nvmrc or engines. We set NODE_VERSION=24.
- [VERIFIED: https://render.com/docs/disks.md] Persistent disks only on paid web services. A service with a disk cannot scale to multiple instances. Without a disk, local files are lost on every redeploy or restart.
- [VERIFIED: https://render.com/docs/free.md] Free services spin down after 15 minutes idle and cannot have a disk.
- [VERIFIED: https://render.com/docs/tls.md] Free managed TLS on onrender.com. HTTP redirects to HTTPS.
- [VERIFIED: https://render.com/docs/web-services.md] Default expected port 10000. Bind 0.0.0.0 and use process.env.PORT.
- [VERIFIED: https://render.com/docs/health-checks.md] Health check restarts after 60 s of failures.

Unknown:

- [UNKNOWN] Plan and disk prices.
- [UNKNOWN] Whether PORT is injected. We set PORT=10000.

## After deploying

1. From your machine, run `pnpm smoke https://<host>`.
2. Open `https://<host>/healthz`. Expect `{"status":"ok","fx":"fixed demo rate","sandbox":true}`.

## Real phone test

Phone A is the merchant. Phone B is the customer.

1. On phone A, open `https://<host>/app/` in Chrome on Android or Safari on iOS.
2. Tap "Try the sandbox demo shop". Confirm the host.
3. Add to home screen (install). Open it once online.
4. Switch on airplane mode.
5. Open the installed app from its icon.
6. Create a 2 500 F sale and show the QR.
7. On phone B (online), open `https://<host>/sim/`.
8. Scan the QR with the camera button, or paste the payment string. Pay.
9. Tap the receipt link and read the 6-digit code.
10. Type the code on phone A (still in airplane mode). It should confirm.
11. Turn airplane mode off. Open Sales and check it reconciles to paid.
12. Record wallet and browser versions and the results.

Result: NOT RUN.
