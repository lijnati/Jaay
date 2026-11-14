// One-command local SANDBOX demo: `pnpm demo`. Simulated payments, no real bitcoin, a fixed demo rate.
// Builds what is missing (or everything with --rebuild), keeps a generated master key and the SQLite file in
// .demo/ (gitignored), starts the bundled server and prints the URLs. Opens nothing by itself. Ctrl+C stops it.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 8787);
const BASE = `http://localhost:${PORT}`;
// Demo value, roughly 61,000 EUR per BTC at the fixed 655.957 peg. Not a market rate, labeled as such everywhere.
const FIXED_RATE = "40000000";
const rebuild = process.argv.includes("--rebuild");

const node = (args, cwd) => execFileSync(process.execPath, args, { cwd, stdio: "inherit" });
const vite = (app) => node([join(ROOT, "apps", app, "node_modules/vite/bin/vite.js"), "build", "--logLevel", "warn"], join(ROOT, "apps", app));

if (rebuild || !existsSync(join(ROOT, "apps/server/dist/server.mjs"))) node([join(ROOT, "apps/server/build.mjs")], join(ROOT, "apps/server"));
if (rebuild || !existsSync(join(ROOT, "apps/pos/dist/index.html"))) vite("pos");
if (rebuild || !existsSync(join(ROOT, "apps/customer-sim/dist/index.html"))) vite("customer-sim");

const state = join(ROOT, ".demo");
mkdirSync(state, { recursive: true });
const keyFile = join(state, "master.key");
if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString("base64"), { mode: 0o600 });

const log = createWriteStream(join(state, "server.log"), { flags: "a" });
const server = spawn(process.execPath, [join(ROOT, "apps/server/dist/server.mjs")], {
  env: {
    ...process.env,
    NODE_ENV: "development",
    PORT: String(PORT),
    JAAY_BASE_URL: BASE,
    SANDBOX: "1",
    JAAY_FX_FIXED_XOF_PER_BTC: FIXED_RATE,
    JAAY_POS_DIR: join(ROOT, "apps/pos/dist"),
    JAAY_SIM_DIR: join(ROOT, "apps/customer-sim/dist"),
    JAAY_MASTER_KEY: readFileSync(keyFile, "utf8").trim(),
    DB_PATH: join(state, "jaay.sqlite"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.pipe(log);
server.stderr.pipe(process.stderr);
server.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.kill());

for (let i = 0; i < 100; i++) {
  if (await fetch(`${BASE}/healthz`).then((r) => r.ok, () => false)) break;
  await new Promise((r) => setTimeout(r, 100));
}
console.log(`
  jaay SANDBOX demo: simulated payments, no real bitcoin.
  Fixed demo rate: ${Number(FIXED_RATE).toLocaleString("en")} XOF per BTC (not a market rate).

  Merchant app        ${BASE}/app/
  Customer simulator  ${BASE}/sim/
  Health              ${BASE}/healthz

  Server log: .demo/server.log   Stop: Ctrl+C
`);
