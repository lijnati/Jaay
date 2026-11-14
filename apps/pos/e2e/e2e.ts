// M3 end to end: the built server (SANDBOX=1, JAAY_POS_DIR) plus Chromium (Playwright), at 360 px, English.
// A Node-side customer plays the wallet over plain HTTP: GET lnurlp, GET cb, POST /sandbox/pay, GET /r/<token>.
// SANDBOX only, no real bitcoin. Prints PASS/FAIL per check; exit code 1 if any check fails.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import jsQR from "jsqr";
import { chromium, type BrowserContext, type Page } from "playwright";
import { PNG } from "pngjs";
import { decodeSale, deriveConfirmCode, deriveKeys, lnurlDecode, secretFromString, type DeviceKeys } from "../../../packages/protocol/src/index.ts";

const POS = fileURLToPath(new URL("..", import.meta.url));
const SERVER = fileURLToPath(new URL("../../server", import.meta.url));
const SCREENS = fileURLToPath(new URL("../../../docs/screens", import.meta.url));
const DIST = join(POS, "dist");
const PORT = 8797;
const B = `http://localhost:${PORT}`;
const HOST = `localhost:${PORT}`;

const rows: { id: string; check: string; ok: boolean; detail: string }[] = [];
const rec = (id: string, check: string, ok: boolean, detail = "") => {
  rows.push({ id, check, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id} ${check}${detail ? `  (${detail})` : ""}`);
};
const step = async (id: string, check: string, fn: () => Promise<string | void>) => {
  try {
    rec(id, check, true, (await fn()) ?? "");
  } catch (e) {
    rec(id, check, false, (e as Error).message.split("\n")[0]!.slice(0, 160));
  }
};
const assert = (c: unknown, msg: string) => {
  if (!c) throw new Error(msg);
};
const vite = (buildId: string) =>
  execFileSync(process.execPath, [join(POS, "node_modules/vite/bin/vite.js"), "build", "--logLevel", "error"], { cwd: POS, env: { ...process.env, BUILD_ID: buildId }, stdio: "inherit" });

// ---------- build and start ----------
const t0 = Date.now();
vite("v1");
execFileSync(process.execPath, [join(SERVER, "build.mjs")], { cwd: SERVER, stdio: "ignore" });
const server = spawn(process.execPath, [join(SERVER, "dist/server.mjs")], {
  env: { ...process.env, NODE_ENV: "development", SANDBOX: "1", PORT: String(PORT), BASE_URL: B, JAAY_POS_DIR: DIST },
  stdio: ["ignore", "ignore", "inherit"],
});
const stopAll = async (ctx?: BrowserContext) => {
  await ctx?.close().catch(() => {});
  server.kill();
};
for (let i = 0; i < 50; i++) {
  if (await fetch(`${B}/healthz`).then((r) => r.ok, () => false)) break;
  await new Promise((r) => setTimeout(r, 200));
}
// Wait until the server has a live FX rate (it polls at start).
for (let i = 0; i < 50; i++) {
  if ((await (await fetch(`${B}/healthz`)).json()).fx === "ok") break;
  await new Promise((r) => setTimeout(r, 200));
}

// ---------- operator: enroll a sandbox device, build the enrollment payload ----------
const en = (await (await fetch(`${B}/api/enroll`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ label: "Boutique Test", backend: "sandbox", connection: "", minXof: 50, maxXof: 500000 }),
})).json()) as { deviceId: string; deviceSecretB64u: string; baseUrl: string };
const SECRET = en.deviceSecretB64u;
const keys: DeviceKeys = await deriveKeys(secretFromString(SECRET));
const payload = { deviceId: en.deviceId, deviceSecretB64u: SECRET, baseUrl: en.baseUrl, minXof: 50, maxXof: 500000, label: "Boutique Test", sandbox: true };
const fragment = Buffer.from(JSON.stringify(payload)).toString("base64url");

// ---------- customer (Node): plays an LNURL-pay wallet over plain HTTP ----------
async function tokenOf(qr: string) {
  const url = new URL(lnurlDecode(qr.replace(/^LIGHTNING:/, "").toLowerCase()));
  return { url, token: url.searchParams.get("p")! };
}
async function customerPays(qr: string): Promise<{ sid: string; code: string }> {
  const { url, token } = await tokenOf(qr);
  const pay = (await (await fetch(url)).json()) as { callback: string; minSendable: number };
  const cb = (await (await fetch(`${pay.callback}&amount=${pay.minSendable}`)).json()) as { successAction: { url: string } };
  const { sid } = await decodeSale(token, keys, { minAmountXof: 1, maxAmountXof: 0xffffffff });
  const paid = await fetch(`${B}/sandbox/pay/${sid}`, { method: "POST" });
  assert(paid.ok, "sandbox pay failed");
  const html = await (await fetch(cb.successAction.url)).text();
  const code = /class="code">(\d{6})</.exec(html)?.[1];
  assert(code, "no code on the receipt page");
  return { sid, code: code! };
}

// ---------- merchant UI helpers ----------
async function sell(page: Page, amount: number): Promise<string> {
  await page.click("#tab-sell");
  for (const d of String(amount)) await page.click(`.keypad button[data-key="${d}"]`);
  await page.click("#create");
  await page.waitForSelector("#qr");
  return (await page.getAttribute("#qr", "data-qr"))!;
}
async function typeCode(page: Page, code: string): Promise<string> {
  await page.fill("#code", code);
  await page.click("#check");
  await page.waitForSelector("#result");
  return (await page.textContent("#result"))!;
}
async function statusOf(page: Page, sid: string): Promise<string | null> {
  await page.click("#tab-ledger");
  return page.getAttribute(`li[data-sid="${sid}"]`, "data-status");
}
const launch = (dir: string, offline = false) => chromium.launchPersistentContext(dir, { viewport: { width: 360, height: 780 }, locale: "en-US", offline });
const sidOf = async (qr: string) => (await decodeSale((await tokenOf(qr)).token, keys, { minAmountXof: 1, maxAmountXof: 0xffffffff })).sid;

const profile = mkdtempSync(join(tmpdir(), "jaay-pos-e2e-"));
let ctx = await launch(profile);
let page = ctx.pages()[0] ?? (await ctx.newPage());
mkdirSync(SCREENS, { recursive: true });

try {
  // a. golden path
  await step("a", "golden path: enroll, sell, customer pays, merchant types code, ledger shows confirmed", async () => {
    await page.goto(`${B}/app/#enroll=${fragment}`);
    await page.waitForSelector("#enroll-host");
    assert(!page.url().includes("#enroll"), "enrollment fragment still in the address bar");
    assert((await page.textContent("#enroll-host")) === HOST, "destination host not shown");
    await page.check("#enroll-check");
    await page.click("#enroll-submit");
    await page.waitForSelector("#tab-sell");
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    const qr = await sell(page, 1000);
    const { sid, code } = await customerPays(qr);
    await page.click("#to-confirm");
    const msg = await typeCode(page, code);
    assert(msg === "Payment confirmed.", `got "${msg}"`);
    const st = await statusOf(page, sid);
    assert(st === "confirmed", `ledger status ${st}`);
    return `sid ${sid.slice(0, 4)}..., status ${st}`;
  });

  await step("a2", "raw device secret absent from IndexedDB and localStorage (5 encodings)", async () => {
    const dump = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((r) => {
        const o = indexedDB.open("jaay-pos");
        o.onsuccess = () => r(o.result);
      });
      const out: string[] = [JSON.stringify({ ...localStorage })];
      for (const s of Array.from(db.objectStoreNames)) {
        const all = await new Promise<unknown[]>((r) => {
          const q = db.transaction(s).objectStore(s).getAll();
          q.onsuccess = () => r(q.result);
        });
        out.push(JSON.stringify(all, (_k, v) => (v instanceof CryptoKey ? `CryptoKey(${v.algorithm.name},extractable=${v.extractable})` : v)));
      }
      return out.join("\n");
    });
    const bytes = Buffer.from(SECRET, "base64url");
    for (const f of [SECRET, bytes.toString("base64"), bytes.toString("hex"), bytes.toString("latin1"), Array.from(bytes).join(",")]) assert(!dump.includes(f), "secret found");
    assert(dump.includes("extractable=false") && !dump.includes("extractable=true"), "keys are not all non-extractable");
    return `${dump.length} chars scanned`;
  });

  // e. host next to QR and exact QR decode
  await step("e", "destination host shown under the QR; QR pixels decode to the exact LNURL string", async () => {
    const qr = await sell(page, 2500);
    const hostText = await page.textContent("#host");
    assert(hostText?.includes(HOST), `host text "${hostText}"`);
    const png = PNG.sync.read(await page.locator("#qr").screenshot());
    const d = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    assert(d && d.data === qr, "decoded QR differs from the sale's LNURL string");
    const { url, token } = await tokenOf(d!.data);
    assert(url.origin === B && url.pathname === "/lnurlp", "QR points elsewhere");
    const s = await decodeSale(token, keys, { minAmountXof: 1, maxAmountXof: 0xffffffff });
    assert(s.amountXof === 2500, "amount in token");
    await page.screenshot({ path: join(SCREENS, "sell.png") });
    await page.click("#cancel");
    await page.click("#cancel");
    return `QR v${d!.version}, ${d!.data.length} chars, mode ${[...new Set(d!.chunks.map((c) => c.type))].join("+")}`;
  });

  // d. attempt cap
  await step("d", "three wrong codes lock the sale; it survives a reload; a fourth attempt (even correct) is refused", async () => {
    const qr = await sell(page, 700);
    const sid = await sidOf(qr);
    const right = await deriveConfirmCode(keys, sid);
    const wrong = String((Number(right) + 1) % 1e6).padStart(6, "0");
    await page.click("#to-confirm");
    const r1 = await typeCode(page, wrong);
    const r2 = await typeCode(page, wrong);
    await page.screenshot({ path: join(SCREENS, "confirm.png") });
    const r3 = await typeCode(page, wrong);
    assert(r1 === "Code not accepted." && r2 === "Code not accepted.", `first two: ${r1} / ${r2}`);
    assert(r3.startsWith("Too many wrong codes"), `third: ${r3}`);
    const r4 = await typeCode(page, right);
    assert(r4.startsWith("This sale cannot be confirmed here"), `fourth: ${r4}`);
    // Reload offline, so the automatic reconcile cannot move the sale on (locked + never scanned -> unpaid).
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector("#tab-ledger");
    const st = await statusOf(page, sid);
    const attempts = await page.evaluate(async (s) => {
      const db = await new Promise<IDBDatabase>((r) => {
        const o = indexedDB.open("jaay-pos");
        o.onsuccess = () => r(o.result);
      });
      return new Promise<number>((r) => {
        const q = db.transaction("sales").objectStore("sales").get(s);
        q.onsuccess = () => r((q.result as { attempts: number }).attempts);
      });
    }, sid);
    assert(st === "locked" && attempts === 3, `after reload: ${st}, attempts ${attempts}`);
    await ctx.setOffline(false);
    return `locked, attempts ${attempts}`;
  });

  // b. offline golden path
  const offline = { paidConfirmed: "", paidUnconfirmed: "", leaked: "" };
  await step("b", "OFFLINE: reload offline, sell and confirm; back online, reconcile marks paid, paid, and flags the leaked-code sale", async () => {
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector("#tab-sell");
    assert((await page.textContent("#net")) === "Offline", "offline state not visible");
    // Sale 1: paid by the customer, confirmed offline with the receipt code.
    let qr = await sell(page, 1500);
    let paid = await customerPays(qr);
    offline.paidConfirmed = paid.sid;
    await page.click("#to-confirm");
    assert((await typeCode(page, paid.code)) === "Payment confirmed.", "offline confirm");
    await page.click("#next");
    // Sale 2: paid by the customer, merchant does not confirm.
    qr = await sell(page, 2500);
    paid = await customerPays(qr);
    offline.paidUnconfirmed = paid.sid;
    await page.click("#new-sale"); // leave sale 2 open, unconfirmed
    // Sale 3: never paid, but someone has the code (leak): merchant confirms offline.
    qr = await sell(page, 3500);
    offline.leaked = await sidOf(qr);
    await page.click("#to-confirm");
    assert((await typeCode(page, await deriveConfirmCode(keys, offline.leaked))) === "Payment confirmed.", "leaked confirm");
    await page.click("#tab-ledger");
    assert((await page.getAttribute(`li[data-sid="${offline.leaked}"]`, "data-status")) === "confirmed", "leaked sale not confirmed offline");

    await ctx.setOffline(false);
    const want: Record<string, string> = { [offline.paidConfirmed]: "paid", [offline.paidUnconfirmed]: "paid", [offline.leaked]: "mismatch" };
    for (const [sid, st] of Object.entries(want)) await page.waitForSelector(`li[data-sid="${sid}"][data-status="${st}"]`, { timeout: 20_000 });
    const note = await page.textContent(`li[data-sid="${offline.leaked}"] .hint`);
    assert(note?.includes("server shows no matching payment"), `mismatch note "${note}"`);
    await page.screenshot({ path: join(SCREENS, "ledger.png") });
    return "paid, paid, mismatch";
  });

  await step("wallet", "Wallet screen: receive-only statement, no spend methods, server totals", async () => {
    await page.click("#tab-wallet");
    await page.waitForSelector("#wallet-today");
    const ro = await page.textContent("#receive-only");
    const sm = await page.textContent("#spend-methods");
    assert(ro === "Receive only. This app and the server cannot spend.", ro ?? "");
    assert(sm?.endsWith(": none"), sm ?? "");
    assert((await page.locator("text=/send|pay out|withdraw/i").count()) === 0, "a send control exists");
    await page.screenshot({ path: join(SCREENS, "wallet.png") });
    return (await page.textContent("#wallet-today"))!.replace(/ /g, " ");
  });

  // c. cold start offline from the installed profile
  await step("c", "cold start offline: browser closed and reopened offline, app and ledger load, a sale can be made", async () => {
    await ctx.close();
    ctx = await launch(profile, true);
    page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(`${B}/app/`);
    await page.waitForSelector("#tab-sell");
    assert((await page.textContent("#net")) === "Offline", "not offline");
    const st = await statusOf(page, offline.paidConfirmed);
    assert(st === "paid", `ledger after restart: ${st}`);
    const qr = await sell(page, 900);
    assert(qr.startsWith("LIGHTNING:LNURL1"), "no QR");
    await page.click("#cancel");
    await page.click("#cancel");
    return "app shell from the service worker, ledger intact";
  });

  // g. update flow
  await ctx.close();
  ctx = await launch(profile);
  page = ctx.pages()[0] ?? (await ctx.newPage());
  await step("g", "update: new SW waits, update offered but blocked while a sale is open, applied after; ledger kept", async () => {
    await page.goto(`${B}/app/`);
    await page.waitForSelector("#tab-sell");
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    const qr = await sell(page, 1200);
    vite("v2"); // deploy a new build while the merchant has an open sale
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration("/app/"))?.update());
    await page.click("#tab-settings");
    await page.waitForFunction(() => document.querySelector("#update-status")?.textContent?.includes("Finish or cancel"), null, { timeout: 15_000 });
    assert(await page.isDisabled("#update"), "update button enabled during an open sale");
    assert((await page.textContent("#version")) === "Version v1", "already v2?");
    await page.click("#tab-sell");
    assert((await page.getAttribute("#qr", "data-qr")) === qr, "the open sale was interrupted");
    await page.click("#cancel");
    await page.click("#cancel");
    await page.click("#tab-settings");
    await page.waitForSelector("#update:not([disabled])");
    await Promise.all([page.waitForEvent("load"), page.click("#update")]);
    await page.waitForSelector("#tab-settings");
    await page.click("#tab-settings");
    const v = await page.textContent("#version");
    assert(v === "Version v2", `after update: ${v}`);
    const st = await statusOf(page, offline.paidConfirmed);
    assert(st === "paid", "ledger lost");
    return "v1 -> v2 after the sale was closed";
  });
} finally {
  await stopAll(ctx);
}

// f. size budget (first load = everything the shell precaches, gzipped)
await step("f", "first load under 150 KB gzipped (HTML, JS, CSS, SW, manifest, icons)", async () => {
  vite("v1");
  const sw = readFileSync(join(DIST, "sw.js"), "utf8");
  const files: string[] = JSON.parse(/PRECACHE = (\[.*?\]);/.exec(sw)![1]!);
  let gz = gzipSync(sw, { level: 9 }).length;
  const parts: string[] = [];
  for (const p of new Set(files.map((f) => (f === "/app/" ? "index.html" : f.slice("/app/".length))))) {
    const n = gzipSync(readFileSync(join(DIST, p)), { level: 9 }).length;
    gz += n;
    parts.push(`${p}=${(n / 1024).toFixed(1)}`);
  }
  assert(gz < 150 * 1024, `${(gz / 1024).toFixed(1)} KB`);
  return `${(gz / 1024).toFixed(1)} KB total (${parts.join(", ")})`;
});

console.table(rows.map(({ id, check, ok }) => ({ id, ok: ok ? "PASS" : "FAIL", check })));
console.log(`elapsed ${Math.round((Date.now() - t0) / 1000)} s`);
const failed = rows.filter((r) => !r.ok);
console.log(failed.length ? `FAILED: ${failed.map((r) => r.id).join(", ")}` : `ALL ${rows.length} E2E CHECKS PASSED`);
process.exit(failed.length ? 1 : 0);
