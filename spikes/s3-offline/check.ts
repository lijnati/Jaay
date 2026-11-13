// Spike S3 checks. Builds the PWA, serves it from a local static server, and drives Chromium with Playwright.
// Prints PASS / FAIL / NOT RUN per check. Spike-only test key; nothing here touches real funds.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import http from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { extname, join } from "node:path";
import { gzipSync } from "node:zlib";
import jsQR from "jsqr";
import { chromium, type BrowserContext, type Page } from "playwright";
import { PNG } from "pngjs";
import { decodeSale, deriveKeys, lnurlDecode, secretFromString } from "../../packages/protocol/src/index.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PORT = 4173;
const ORIGIN = `http://localhost:${PORT}`;
const TEST_SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

type Row = { id: string; check: string; result: "PASS" | "FAIL" | "NOT RUN"; detail: string };
const rows: Row[] = [];
function rec(id: string, check: string, ok: boolean | null, detail = "") {
  const result = ok === null ? "NOT RUN" : ok ? "PASS" : "FAIL";
  rows.push({ id, check, result, detail });
  console.log(`${result.padEnd(7)} ${id} ${check}${detail ? `  (${detail})` : ""}`);
}

// ---------- build ----------
function build(lib: string, id: string) {
  execFileSync(process.execPath, [join(HERE, "node_modules/vite/bin/vite.js"), "build", "--logLevel", "error"], {
    cwd: HERE,
    env: { ...process.env, QR_LIB: lib, BUILD_ID: id },
    stdio: "inherit",
  });
  return join(HERE, `dist-${lib}-${id}`);
}

// ---------- static server with a switchable root and an on/off switch ----------
const TYPES: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json",
};
let root = "";
let up = false;
const served: string[] = [];
const server = http.createServer((req, res) => {
  if (!up) return req.socket.destroy(); // simulates the network being gone, not just a 404
  const path = new URL(req.url ?? "/", "http://x").pathname;
  const file = join(root, path === "/" ? "index.html" : path);
  try {
    const body = readFileSync(file);
    served.push(path);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>((r) => server.listen(PORT, "0.0.0.0", r));

// ---------- helpers ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const s3 = <T>(page: Page, expr: string) => page.evaluate(`window.__s3.${expr}`) as Promise<T>;
async function controlled(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }));
  });
}
async function works(page: Page, amount = 1000) {
  await page.waitForSelector("#create", { timeout: 5000 });
  const last = await s3<{ qrString: string } | null>(page, `createSale(${amount})`);
  return !!last?.qrString?.startsWith("LIGHTNING:LNURL1");
}
const launch = (dir: string, offline = false) => chromium.launchPersistentContext(dir, { offline, viewport: { width: 400, height: 900 } });
const profile = (name: string) => mkdtempSync(join(tmpdir(), `jaay-s3-${name}-`));

async function decodeCanvas(page: Page) {
  const png = PNG.sync.read(await page.locator("#qr").screenshot());
  return jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
}

// =====================================================================
const t0 = Date.now();
const distGen = build("gen", "v1");
const distNode = build("node", "v1");

// ---------- 6. size budget (fresh profile, first load online) ----------
function sizes(dist: string, paths: string[]) {
  let raw = 0;
  let gz = 0;
  for (const p of new Set(paths)) {
    const b = readFileSync(join(dist, p === "/" ? "index.html" : p));
    raw += b.length;
    gz += gzipSync(b, { level: 9 }).length;
  }
  return { raw, gz };
}
const budget: Record<string, unknown>[] = [];
for (const [lib, dist] of [["qrcode-generator", distGen], ["qrcode", distNode]] as const) {
  root = dist;
  up = true;
  served.length = 0;
  const ctx = await launch(profile("size"));
  const page = await ctx.newPage();
  await page.goto(ORIGIN);
  await controlled(page);
  await sleep(300);
  const firstLoad = sizes(dist, served); // everything the browser asked the server for, page plus SW install
  const precache: string[] = JSON.parse(/PRECACHE = (\[.*?\]);/.exec(readFileSync(join(dist, "sw.js"), "utf8"))![1]!);
  const pre = sizes(dist, precache);
  const all = readdirSync(join(dist, "assets")).map((f) => statSync(join(dist, "assets", f)).size);
  budget.push({ lib, requests: served.length, uniqueFiles: new Set(served).size, firstLoadGzKB: +(firstLoad.gz / 1024).toFixed(1), firstLoadRawKB: +(firstLoad.raw / 1024).toFixed(1), precacheGzKB: +(pre.gz / 1024).toFixed(1), precacheRawKB: +(pre.raw / 1024).toFixed(1), jsRawKB: +(all.reduce((a, b) => a + b, 0) / 1024).toFixed(1) });
  await ctx.close();
}
console.table(budget);
const chosen = budget.reduce((a, b) => ((a.firstLoadGzKB as number) <= (b.firstLoadGzKB as number) ? a : b));
rec("6", "first load under 150 KB gzipped (both libs)", budget.every((b) => (b.firstLoadGzKB as number) < 150), budget.map((b) => `${b.lib} ${b.firstLoadGzKB} KB`).join(", "));

// ---------- 2. QR round trip, both libs ----------
const keys = await deriveKeys(secretFromString(TEST_SECRET));
const qrRows: Record<string, unknown>[] = [];
for (const [lib, dist] of [["qrcode-generator", distGen], ["qrcode", distNode]] as const) {
  root = dist;
  up = true;
  const ctx = await launch(profile("qr"));
  const page = await ctx.newPage();
  await page.goto(ORIGIN);
  await page.fill("#amount", "1000");
  await page.click("#create");
  await page.waitForFunction(() => (window as unknown as { __s3: { last(): unknown } }).__s3.last() !== null);
  const last = await s3<{ qrString: string; lnurl: string; info: Record<string, unknown> }>(page, "last()");
  const d = await decodeCanvas(page);
  const modes = d ? [...new Set(d.chunks.map((c) => c.type))].join("+") : "none";
  // Full round trip: QR pixels -> LNURL -> URL -> token -> decrypted sale.
  let amount = -1;
  if (d) {
    const url = new URL(lnurlDecode(d.data.replace(/^LIGHTNING:/, "")));
    amount = (await decodeSale(url.searchParams.get("p")!, keys, {})).amountXof;
  }
  const ok = !!d && d.data === last.qrString && d.data === `LIGHTNING:${last.lnurl.toUpperCase()}` && amount === 1000;
  const levels = Object.fromEntries(
    await Promise.all((["L", "M", "Q", "H"] as const).map(async (e) => {
      const i = await s3<{ version: number; modules: number; pxPerModule: number }>(page, `qrStats(${JSON.stringify(last.qrString)}, "${e}")`);
      return [e, `v${i.version} ${i.modules}x${i.modules} ${i.pxPerModule}px`];
    })),
  );
  qrRows.push({ lib, chars: last.qrString.length, ...last.info, decodedVersion: d?.version, decodedModes: modes, ...levels });
  rec("2", `QR round trip via jsQR (${lib})`, ok, `decoded===LNURL string, token decrypts to ${amount} XOF, mode ${modes}`);
  await ctx.close();
}
console.table(qrRows);

// From here on, the chosen (smaller) library build is used.
const distChosen = chosen.lib === "qrcode" ? distNode : distGen;

// ---------- 1. cold start offline, and closed-and-reopened app ----------
{
  root = distChosen;
  up = true;
  const dir = profile("cold");
  let ctx: BrowserContext = await launch(dir);
  let page = await ctx.newPage();
  await page.goto(ORIGIN);
  await controlled(page);
  await page.close();
  await ctx.setOffline(true);
  up = false;
  page = await ctx.newPage();
  await page.goto(ORIGIN);
  await page.reload();
  rec("1a", "offline reload renders and creates a sale (server down + setOffline)", await works(page));
  await ctx.close(); // the "app" is fully closed

  ctx = await launch(dir, true); // reopened with the same profile, offline from the first request
  page = await ctx.newPage();
  await page.goto(ORIGIN);
  const ledger = await s3<number>(page, "ledgerCount()");
  rec("1b", "closed and reopened browser context, offline from start, works", (await works(page)) && ledger >= 1, `ledger before new sale: ${ledger}`);

  // ---------- 5. crypto availability offline on localhost ----------
  const sec = await s3<{ isSecureContext: boolean; subtle: boolean }>(page, "secure()");
  rec("5a", "crypto.subtle available offline on http://localhost", sec.isSecureContext && sec.subtle, JSON.stringify(sec));
  await ctx.close();
}

// ---------- 5b. LAN http origin is not a secure context ----------
{
  const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
  if (!lan) rec("5b", "http LAN address is NOT a secure context (expected)", null, "no LAN IPv4 interface");
  else {
    root = distChosen;
    up = true;
    const ctx = await launch(profile("lan"));
    const page = await ctx.newPage();
    await page.goto(`http://${lan.address}:${PORT}/`);
    const r = await page.evaluate(() => ({ isSecureContext, subtle: typeof globalThis.crypto?.subtle, sw: "serviceWorker" in navigator }));
    rec("5b", "http LAN address is NOT a secure context (expected)", !r.isSecureContext && r.subtle === "undefined" && !r.sw, `${JSON.stringify(r)} at http://<lan-ip>:${PORT}`);
    await ctx.close();
  }
}

// ---------- 3. non-extractable CryptoKey persisted in IndexedDB ----------
{
  root = distChosen;
  up = true;
  const dir = profile("key");
  let ctx = await launch(dir);
  let page = await ctx.newPage();
  await page.goto(ORIGIN);
  await controlled(page);
  const stored = await s3<{ extractable: boolean[] }>(page, "storeKey()");
  await ctx.setOffline(true);
  up = false;
  await page.reload();
  const r1 = await s3<Record<string, unknown>>(page, "useStoredKey()");
  await ctx.close();
  ctx = await launch(dir, true); // and after a full app restart
  page = await ctx.newPage();
  await page.goto(ORIGIN);
  const r2 = await s3<Record<string, unknown>>(page, "useStoredKey()");
  await ctx.close();
  const good = (r: Record<string, unknown>) =>
    r.persisted === true && r.isCryptoKey === true && r.extractable === false && r.decodesTokenFromBeforeReload === true && r.sameConfirmCode === true && r.roundtrip === true && r.exportRejected === true;
  rec("3", "non-extractable CryptoKey survives IndexedDB, reload and restart, and still works", stored.extractable.every((e) => e === false) && good(r1) && good(r2), JSON.stringify(r2));
}

// ---------- 4. IndexedDB ledger offline, then online reconcile ----------
{
  root = distChosen;
  up = true;
  const dir = profile("ledger");
  const ctx = await launch(dir);
  const page = await ctx.newPage();
  await page.goto(ORIGIN);
  await controlled(page);
  await ctx.setOffline(true);
  up = false;
  await page.reload();
  for (const a of [500, 1500, 2500]) await s3(page, `createSale(${a})`);
  await page.reload();
  const count = await s3<number>(page, "ledgerCount()");
  rec("4a", "3 sales written offline persist across an offline reload", count === 3, `count ${count}`);
  up = true;
  await ctx.setOffline(false);
  await page.waitForFunction(() => (window as unknown as { __s3: { reconciles(): number } }).__s3.reconciles() > 0, null, { timeout: 5000 }).catch(() => {});
  const n = await s3<number>(page, "reconciles()");
  rec("4b", "'online' event runs the reconcile stub", n > 0, `reconcile runs ${n}, status: ${await page.textContent("#net")}`);
  await ctx.close();
}

// ---------- 7. update flow (prompt), offline user not broken ----------
{
  root = distChosen;
  up = true;
  const dir = profile("update");
  const ctx = await launch(dir);
  const page = await ctx.newPage();
  await page.goto(ORIGIN);
  await controlled(page);
  const v1 = await s3<string>(page, "build");

  // Ship v2 while the user is offline.
  const libKey = chosen.lib === "qrcode" ? "node" : "gen";
  const distV2 = build(libKey, "v2");
  root = distV2;
  await ctx.setOffline(true);
  up = false;
  await page.reload();
  const offlineStillV1 = (await s3<string>(page, "build")) === v1 && (await works(page));
  rec("7a", "v2 shipped while offline: user keeps a working v1", offlineStillV1, `build ${await s3<string>(page, "build")}`);

  // Back online: v2 installs in the background, waits, page shows the update button and keeps working.
  up = true;
  await ctx.setOffline(false);
  await page.reload();
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update());
  await page.waitForFunction(() => (window as unknown as { __s3: { updateReady(): boolean } }).__s3.updateReady(), null, { timeout: 10_000 }).catch(() => {});
  const prompt = await s3<boolean>(page, "updateReady()");
  const stillV1 = (await s3<string>(page, "build")) === v1 && (await works(page));
  rec("7b", "online: new SW waits, update button shown, current page still v1 and working", prompt && stillV1);

  // User taps update: new SW takes over and the page reloads into v2.
  await Promise.all([page.waitForEvent("load"), page.click("#apply")]);
  await page.waitForFunction(() => (window as unknown as { __s3?: { build: string } }).__s3?.build === "v2", null, { timeout: 10_000 }).catch(() => {});
  const nowV2 = (await s3<string>(page, "build")) === "v2";
  await ctx.setOffline(true);
  up = false;
  await page.reload();
  const offlineV2 = (await s3<string>(page, "build")) === "v2" && (await works(page));
  rec("7c", "after tapping update: v2 runs, and v2 works offline", nowV2 && offlineV2);
  await ctx.close();
}

server.close();
console.log(`\nchosen QR library: ${chosen.lib}`);
console.table(rows);
console.log(`elapsed ${Math.round((Date.now() - t0) / 1000)} s`);
const failed = rows.filter((r) => r.result !== "PASS" && !(r.id === "5b" && r.result === "NOT RUN"));
console.log(failed.length ? `NOT ALL PASSED: ${failed.map((r) => r.id).join(", ")}` : `ALL ${rows.length} CHECKS PASSED`);
process.exit(failed.length ? 1 : 0);
