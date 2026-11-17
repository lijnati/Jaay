// Checks docs/THREAT_MODEL.md: every row of the threat matrix names tests that exist, as `path` "test name".
// A row may say "none (...)" instead, for documented limits. Exit code 1 on any missing file or test name.
// With --run, it then runs exactly the unit tests the matrix names (vitest -t), package by package: `pnpm test:security`.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const doc = readFileSync(join(ROOT, "docs/THREAT_MODEL.md"), "utf8");
const section = doc.split(/^## Threat matrix$/m)[1]?.split(/^## /m)[0] ?? "";
const rows = section.split("\n").filter((l) => /^\| T\d+ \|/.test(l));
const REF = /`([^`]+\.(?:test|e2e)\.ts|[^`]+e2e\.ts)` "([^"]+)"/g;

const problems = [];
const refs = [];
for (const row of rows) {
  const id = row.split("|")[1].trim();
  const testCell = row.split(/(?<!\\)\|/)[5] ?? "";
  const found = [...testCell.matchAll(REF)];
  if (found.length === 0 && !/\bnone\b/.test(testCell)) problems.push(`${id}: no test reference and no "none (reason)"`);
  for (const [, file, name] of found) {
    const path = join(ROOT, file);
    if (!existsSync(path)) {
      problems.push(`${id}: missing file ${file}`);
      continue;
    }
    // Table cells escape "|" as "\|"; the source has the plain character.
    const plain = name.replace(/\\\|/g, "|");
    if (!readFileSync(path, "utf8").includes(plain)) problems.push(`${id}: no test named "${plain}" in ${file}`);
    else refs.push({ id, file, name: plain });
  }
}

if (rows.length === 0) problems.push("no matrix rows found");
console.log(`threat matrix: ${rows.length} rows, ${refs.length} test references`);
for (const p of problems) console.log(`MISSING  ${p}`);
if (problems.length) process.exit(1);
console.log("every referenced test exists");

if (process.argv.includes("--run")) {
  const pkgs = ["packages/protocol", "apps/server", "apps/pos", "apps/customer-sim"];
  const vitest = join(ROOT, "node_modules/vitest/vitest.mjs");
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%[sjdi]/g, ".*");
  let failed = false;
  for (const pkg of pkgs) {
    const mine = refs.filter((r) => r.file.startsWith(`${pkg}/src/`));
    if (mine.length === 0) continue;
    const files = [...new Set(mine.map((r) => relative(join(ROOT, pkg), join(ROOT, r.file)).split(sep).join("/")))];
    const pattern = mine.map((r) => esc(r.name)).join("|");
    console.log(`\n== ${pkg}: ${mine.length} security tests in ${files.length} files`);
    const r = spawnSync(process.execPath, [vitest, "run", ...files, "-t", pattern], { cwd: join(ROOT, pkg), stdio: "inherit" });
    if (r.status !== 0) failed = true;
  }
  const e2e = refs.filter((r) => r.file.endsWith("e2e/e2e.ts")).length;
  if (e2e) console.log(`\n${e2e} matrix references are Playwright e2e checks: run them with \`pnpm --filter @jaay/pos test:e2e\`.`);
  process.exit(failed ? 1 : 0);
}
