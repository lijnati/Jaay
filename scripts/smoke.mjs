// Smoke test against a running SANDBOX server: `pnpm smoke [baseUrl]` (default http://localhost:8787).
// Checks the shell pages, then runs the existing golden path (apps/server/scripts/golden.ts) over HTTP.
// Works for local, docker and a deployed sandbox URL. Prints PASS/FAIL per step; exit 1 on any failure.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = (process.argv[2] ?? "http://localhost:8787").replace(/\/+$/, "");
let failed = false;
const step = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed = true;
};

for (const [path, marker] of [["/app/", "<title>jaay</title>"], ["/sim/", "SANDBOX"]]) {
  const r = await fetch(`${base}${path}`).catch(() => null);
  const text = r ? await r.text() : "";
  step(`GET ${path}`, !!r && r.status === 200 && text.includes(marker) && (r.headers.get("content-security-policy") ?? "").startsWith("default-src 'self'"), r ? `${r.status}, CSP self` : "unreachable");
}
const health = await fetch(`${base}/healthz`).then((r) => r.json()).catch(() => ({}));
step("server is SANDBOX", health.sandbox === true, JSON.stringify(health));

const tsx = join(ROOT, "node_modules/tsx/dist/cli.mjs");
// cwd apps/server so tsx picks up its tsconfig path alias for @jaay/protocol
const r = spawnSync(process.execPath, [tsx, "scripts/golden.ts", base], { cwd: join(ROOT, "apps/server"), encoding: "utf8" });
process.stdout.write(r.stdout);
if (r.status !== 0) {
  process.stdout.write(r.stderr.split("\n").slice(0, 5).join("\n"));
  failed = true;
}
console.log(failed ? "SMOKE FAILED" : "SMOKE OK");
process.exit(failed ? 1 : 0);
