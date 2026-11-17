# deploy

Draft configs for the public SANDBOX demo. None has been deployed (NOT RUN). Full steps are in `docs/DEPLOY.md`. Run every command from the repo root.

`fly.toml` is for Fly.io. It builds `apps/server/Dockerfile` and mounts a volume at `/data`. Use: `fly deploy --config deploy/fly.toml --dockerfile apps/server/Dockerfile`. Set the secret with `fly secrets set JAAY_MASTER_KEY=...`.

`railway.json` is for Railway. It builds and starts without Docker. Set these in the dashboard: NODE_ENV=production, SANDBOX=1, JAAY_FX_FIXED_XOF_PER_BTC=40000000, JAAY_BASE_URL (your https origin), JAAY_MASTER_KEY (secret), DB_PATH=/data/jaay.sqlite, JAAY_POS_DIR=apps/pos/dist, JAAY_SIM_DIR=apps/customer-sim/dist. Add a volume with mount path `/data`. Railway injects PORT. Because the file is not at the repo root, point the service at it in the dashboard or copy it to the root as `railway.json`.

The Render Blueprint is `render.yaml` at the repository root (free plan, no disk, SANDBOX). Render prompts for JAAY_BASE_URL and generates JAAY_MASTER_KEY.
