// M3 end to end: the built server (SANDBOX=1, JAAY_POS_DIR) plus Chromium (Playwright), at 360 px, English.
// A Node-side customer plays the wallet over plain HTTP: GET lnurlp, GET cb, POST /sandbox/pay, GET /r/<token>.
// SANDBOX only, no real bitcoin. Prints PASS/FAIL per check; exit code 1 if any check fails.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
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
const SIM = fileURLToPath(new URL("../../customer-sim", import.meta.url));
const SCREENS = fileURLToPath(new URL("../../../docs/screens", import.meta.url));
const DIST = join(POS, "dist");
// E2E_WIDTH=320|360|412 runs the whole suite at that width (default 360; screenshots only at 360). E2E_ONLY=layout runs just the layout step.
const WIDTH = Number(process.env.E2E_WIDTH ?? 360);
const ONLY = process.env.E2E_ONLY;
// E2E_SHOTS=<dir> also saves a screenshot of every layout check (all widths and both languages, plus 1280 px desktop).
const SHOTS_DIR = process.env.E2E_SHOTS;
const LAYOUT_WIDTHS = [...new Set([320, 360, WIDTH, ...(SHOTS_DIR ? [412, 1280] : [])])];
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
    const lines = (e as Error).message.split("\n");
    rec(id, check, false, [lines[0], lines.find((l) => l.includes("waiting for"))].filter(Boolean).join(" | ").slice(0, 240));
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
execFileSync(process.execPath, [join(SIM, "node_modules/vite/bin/vite.js"), "build", "--logLevel", "error"], { cwd: SIM, stdio: "inherit" });
execFileSync(process.execPath, [join(SERVER, "build.mjs")], { cwd: SERVER, stdio: "ignore" });
const server = spawn(process.execPath, [join(SERVER, "dist/server.mjs")], {
  // Fixed demo rate: the suite needs no internet. SANDBOX only, labeled "fixed demo rate".
  env: { ...process.env, NODE_ENV: "development", SANDBOX: "1", PORT: String(PORT), JAAY_BASE_URL: B, JAAY_POS_DIR: DIST, JAAY_SIM_DIR: join(SIM, "dist"), JAAY_FX_FIXED_XOF_PER_BTC: "40000000" },
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
const fxLabel = (await (await fetch(`${B}/healthz`)).json()).fx;
rec("fx", "server runs on the fixed demo rate, labeled as such", fxLabel === "fixed demo rate", fxLabel);

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
  const code = codeIn(html);
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
/** Cancel takes two taps; wait for the armed state between them so the second tap hits the re-rendered button. */
async function cancelSale(page: Page): Promise<void> {
  await page.click("#cancel");
  await page.waitForFunction(() => document.querySelector("#cancel")?.textContent?.startsWith("Tap again"));
  await page.click("#cancel");
  await page.waitForSelector("#create");
}
async function typeCode(page: Page, code: string): Promise<string> {
  await page.fill("#code", code);
  // Drop the previous result first, so we read the answer to THIS attempt, not the last one.
  await page.evaluate(() => document.querySelector("#result")?.remove());
  await page.click("#check");
  await page.waitForSelector("#result");
  return (await page.textContent("#result"))!;
}
async function statusOf(page: Page, sid: string): Promise<string | null> {
  await page.click("#tab-ledger");
  return page.getAttribute(`li[data-sid="${sid}"]`, "data-status");
}
const launch = (dir: string, offline = false) => chromium.launchPersistentContext(dir, { viewport: { width: WIDTH, height: 780 }, locale: "en-US", offline });
const shot = (page: Page, name: string, fullPage = false) => (WIDTH === 360 ? page.screenshot({ path: join(SCREENS, `${name}.png`), fullPage }) : Promise.resolve());
mkdirSync(join(SCREENS, "fr"), { recursive: true });
const sidOf = async (qr: string) => (await decodeSale((await tokenOf(qr)).token, keys, { minAmountXof: 1, maxAmountXof: 0xffffffff })).sid;


// ---------- layout: no horizontal scroll on every screen, EN and FR; FR screenshot set at 360 px ----------
const codeIn = (html: string) => (/class="vh">(\d{6})</.exec(html) ?? /class="code">(\d{6})</.exec(html))?.[1];
await step("layout", `no horizontal scroll at ${LAYOUT_WIDTHS.join(", ")} px (EN, FR): PWA screens, simulator, receipt; primary button above the fold at 640 px high`, async () => {
  const bad: string[] = [];
  const seen: string[] = [];
  for (const w of LAYOUT_WIDTHS) {
    for (const lang of ["en", "fr"] as const) {
      const ldir = mkdtempSync(join(tmpdir(), "jaay-layout-"));
      const lctx = await chromium.launchPersistentContext(ldir, { viewport: { width: w, height: 640 }, locale: lang === "fr" ? "fr-FR" : "en-US", reducedMotion: SHOTS_DIR ? "reduce" : "no-preference" });
      const shots = w === 360 && lang === "fr" && WIDTH === 360;
      if (process.env.E2E_DEBUG) console.log(`  layout run ${w} ${lang}`);
      const check = async (pg: Page, name: string) => {
        const [sw, cw] = await pg.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
        seen.push(name);
        if (sw !== cw) bad.push(`${w} ${lang} ${name}: ${sw} > ${cw}`);
        if (shots || SHOTS_DIR) await pg.evaluate(() => scrollTo(0, 0));
        if (SHOTS_DIR) { mkdirSync(SHOTS_DIR, { recursive: true }); await pg.screenshot({ path: join(SHOTS_DIR, `${w}-${lang}-${name}.png`) }); }
        if (shots && ["sell", "confirm", "wallet", "receipt-before", "receipt-after", "sim-request", "ledger"].includes(name)) await pg.screenshot({ path: join(SCREENS, "fr", `${name}.png`), fullPage: !["sell", "wallet"].includes(name) });
      };
      try {
        const app = lctx.pages()[0] ?? (await lctx.newPage());
        await app.goto(`${B}/app/`);
        await app.waitForSelector("#demo-shop");
        await check(app, "enroll");
        await app.click("#demo-shop");
        await app.check("#enroll-check");
        await app.click("#enroll-submit");
        await app.waitForSelector("#create");
        await check(app, "keypad");
        const qr = await sell(app, 2500);
        await check(app, "sell");
        const fold = await app.evaluate(() => {
          const b = document.querySelector("#to-confirm")!.getBoundingClientRect();
          const nav = document.querySelector("nav.tabs")!.getBoundingClientRect();
          const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          return { bottom: Math.round(b.bottom), limit: Math.round(nav.top), hit: hit?.id ?? hit?.tagName };
        });
        if (w <= 412 && (fold.bottom > fold.limit || fold.hit !== "to-confirm")) bad.push(`${w} ${lang} primary button below the fold: bottom ${fold.bottom}, nav at ${fold.limit}, hit ${fold.hit}`);
        if (await app.$("#demo-tools summary")) await app.click("#demo-tools summary");
        await check(app, "sell-demo-tools");

        const sim = await lctx.newPage();
        await sim.goto(`${B}/sim/?lnurl=${encodeURIComponent(qr)}`);
        await sim.waitForSelector("#step1");
        await check(sim, "sim-request");
        const desc = (await sim.textContent("#desc"))!;
        const receipt = await lctx.newPage();
        await receipt.goto(/https?:\/\/\S+\/r\/[A-Za-z0-9_-]{22}/.exec(desc)![0]);
        await check(receipt, "receipt-before");
        await sim.click("#pay");
        await sim.waitForSelector("#step3");
        await sim.click("#raw summary");
        await check(sim, "sim-paid");
        await receipt.goto((await sim.getAttribute("#success-link", "href"))!);
        const code = codeIn(await receipt.content());
        assert(code, "no code on the paid receipt");
        await check(receipt, "receipt-after");

        await app.bringToFront();
        await app.click("#to-confirm");
        await check(app, "confirm-empty");
        await typeCode(app, code === "000000" ? "111111" : "000000");
        await check(app, "confirm");
        await typeCode(app, code!);
        await check(app, "confirm-ok");
        await app.click("#next");
        await app.waitForSelector("#create"); // the handler awaits before switching screens
        await app.click("#tab-settings");
        await app.click("#demo-load");
        await app.waitForSelector("#demo-note");
        await check(app, "settings");
        await app.click("#tab-ledger");
        await check(app, "ledger");
        await app.click("#tab-wallet");
        await app.waitForSelector("#wallet-all");
        await app.waitForSelector("#wallet-recent li", { timeout: 10_000 }).catch(() => {});
        if (await app.$("#wallet-details summary")) await app.click("#wallet-details summary");
        await check(app, "wallet");
      } finally {
        await lctx.close();
      }
    }
  }
  for (const b of bad) console.log(`  layout: ${b}`);
  assert(bad.length === 0, `${bad.length} problems (listed above)`);
  return `${seen.length} screen checks, none wider than the viewport`;
});

if (!ONLY) {
try {
  // The full judge flow, in its own fresh profile: no enrollment code, no wallet, no internet.
  await step("judge", "judge flow: demo shop, 2 500 F sale, copy, simulator pays, receipt code, merchant confirms; demo data matches Wallet", async () => {
    const jdir = mkdtempSync(join(tmpdir(), "jaay-judge-"));
    const jctx = await chromium.launchPersistentContext(jdir, { viewport: { width: WIDTH, height: 780 }, locale: "en-US" });
    await jctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: B });
    const app = jctx.pages()[0] ?? (await jctx.newPage());
    try {
      await app.goto(`${B}/app/`);
      await app.click("#demo-shop");
      await app.waitForSelector("#enroll-host");
      assert((await app.textContent("#enroll-host")) === HOST, "host not shown before enrolling the demo shop");
      assert((await app.inputValue("#enroll-input")) === "", "the secret was put in the visible text box");
      await app.check("#enroll-check");
      await app.click("#enroll-submit");
      await app.waitForSelector("#tab-sell");
      const qr = await sell(app, 2500);
      assert(!(await app.isVisible("#copy")), "demo tools should start collapsed");
      await app.click("#demo-tools summary");
      assert(await app.isVisible("#copy"), "copy helper missing in sandbox");
      await app.click("#copy");
      const copied = await app.evaluate(() => navigator.clipboard.readText());
      assert(copied === qr, "clipboard differs from the QR string");
      await app.evaluate(() => scrollTo(0, 0));
      await shot(app, "sell");
      const simHref = (await app.getAttribute("#open-sim", "href"))!;
      assert(simHref === `/sim/?lnurl=${encodeURIComponent(qr)}`, "simulator link");

      const sim = await jctx.newPage();
      await sim.goto(`${B}${simHref}`);
      await sim.waitForSelector("#step1");
      assert((await sim.textContent("#sandbox")) === "SANDBOX customer wallet (simulator, not a real wallet)", "simulator label");
      const desc = (await sim.textContent("#desc"))!;
      assert(desc.includes("2500 XOF") && desc.includes("fixed demo rate"), `description "${desc}"`);
      assert((await sim.textContent("#msat"))!.includes("6\u00a0250\u00a0000 msat (6\u00a0250 sats)"), `amount "${await sim.textContent("#msat")}"`);
      await shot(sim, "sim-request");
      const fallback = /https?:\/\/\S+\/r\/[A-Za-z0-9_-]{22}/.exec(desc)![0];
      const receipt = await jctx.newPage();
      await receipt.goto(fallback);
      assert(!(await receipt.content()).includes('class="code"'), "code visible before payment");
      await shot(receipt, "receipt-before");

      await sim.click("#pay");
      await sim.waitForSelector("#step3");
      assert(await sim.isVisible("#step2 .msg.ok"), "description hash (with the accented metadata text) does not match");
      const link = (await sim.getAttribute("#success-link", "href"))!;
      assert(new URL(link).host === HOST, "success link host");
      assert(sim.context().pages().length === 3, "the simulator opened something by itself");
      await shot(sim, "sim-paid", true);
      await receipt.goto(link);
      const code = codeIn(await receipt.content());
      assert(code, "no code after payment");
      await shot(receipt, "receipt-after");

      await app.bringToFront();
      await app.click("#to-confirm");
      assert((await typeCode(app, code!)) === "Payment confirmed.", "confirm");
      await app.click("#next");
      await app.waitForSelector("#create"); // the handler awaits before switching screens

      await app.click("#tab-settings");
      await app.click("#demo-load");
      await app.waitForSelector("#demo-note");
      assert((await app.textContent("#demo-note")) === "12 demo sales loaded.", (await app.textContent("#demo-note"))!);
      await app.click("#tab-ledger");
      await app.click("#reconcile");
      // Wait for the result itself (the confirmed 2 500 F sale becomes paid), not for any "Checked" message.
      await app.waitForSelector('li[data-status="confirmed"]', { state: "detached", timeout: 15_000 });
      const ledgerSum = await app.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((r) => {
          const o = indexedDB.open("jaay-pos");
          o.onsuccess = () => r(o.result);
        });
        const all = await new Promise<{ amountXof: number; status: string }[]>((r) => {
          const q = db.transaction("sales").objectStore("sales").getAll();
          q.onsuccess = () => r(q.result);
        });
        return all.filter((s) => s.status === "paid" || s.status === "paid_late").reduce((a, s) => a + s.amountXof, 0);
      });
      await app.click("#tab-wallet");
      await app.waitForSelector("#wallet-all");
      await app.waitForFunction((want) => document.querySelector("#wallet-all")?.textContent?.replace(/\D/g, "") === String(want), ledgerSum, { timeout: 10_000 });
      await shot(app, "wallet");
      assert(ledgerSum === 2500 + 80850, `ledger paid total ${ledgerSum}`);
      assert((await app.locator('#wallet-recent li[data-demo="1"] .st-demo').count()) === 12, "demo rows not labeled in Wallet");
      return `code typed, confirmed; Wallet all time ${ledgerSum} F = ledger paid total`;
    } finally {
      await jctx.close();
    }
  });

  await step("manifest", "manifest parses; every icon resolves with the declared size and type", async () => {
    const m = (await (await fetch(`${B}/app/manifest.webmanifest`)).json()) as {
      id: string; scope: string; start_url: string; display: string; short_name: string; lang: string; theme_color: string; background_color: string;
      icons: { src: string; sizes: string; type: string; purpose: string }[];
    };
    assert(m.id === "/app/" && m.scope === "/app/" && m.start_url === "/app/" && m.display === "standalone" && m.short_name === "Jaay", "manifest fields");
    assert(m.lang && m.theme_color && m.background_color, "colors or lang missing");
    const purposes = new Set(m.icons.map((i) => i.purpose));
    assert(purposes.has("any") && purposes.has("maskable"), "icon purposes");
    const seen: string[] = [];
    for (const icon of m.icons) {
      const r = await fetch(`${B}${icon.src}`);
      assert(r.ok && (r.headers.get("content-type") ?? "").startsWith(icon.type), `${icon.src} ${r.status} ${r.headers.get("content-type")}`);
      if (icon.type === "image/png") {
        const png = PNG.sync.read(Buffer.from(await r.arrayBuffer()));
        assert(`${png.width}x${png.height}` === icon.sizes, `${icon.src} is ${png.width}x${png.height}, declared ${icon.sizes}`);
      }
      seen.push(`${icon.src.split("/").pop()} ${icon.sizes} ${icon.purpose}`);
    }
    return seen.join(", ");
  });
} catch (e) {
  rec("judge", "setup", false, String(e));
}

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
    await cancelSale(page);
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
    await shot(page, "confirm");
    assert(r1 === "Code not accepted. 2 attempts left." && r2 === "Code not accepted. 1 attempt left.", `first two: ${r1} / ${r2}`);
    // The counter text after a reload is read from the persisted record and matches it.
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector("#to-confirm");
    await page.click("#to-confirm");
    const shown = await page.textContent("#attempts");
    const stored = await page.evaluate(async (s) => {
      const db = await new Promise<IDBDatabase>((r) => {
        const o = indexedDB.open("jaay-pos");
        o.onsuccess = () => r(o.result);
      });
      return new Promise<number>((r) => {
        const q = db.transaction("sales").objectStore("sales").get(s);
        q.onsuccess = () => r((q.result as { attempts: number }).attempts);
      });
    }, sid);
    assert(stored === 2 && shown === "1 attempt left.", `after reload: stored ${stored}, shown "${shown}"`);
    assert((await page.textContent("#sale-id"))?.startsWith("Sale "), "sale identity missing");
    const r3 = await typeCode(page, wrong);
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
    await shot(page, "ledger");
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
    await cancelSale(page);
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
    await cancelSale(page);
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
} else server.kill();

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

await step("f2", "customer simulator under 40 KB gzipped (HTML, JS, CSS)", async () => {
  const dir = join(SIM, "dist");
  const files = ["index.html", ...readdirSync(join(dir, "assets")).map((f) => `assets/${f}`)];
  const gz = files.reduce((a, f) => a + gzipSync(readFileSync(join(dir, f)), { level: 9 }).length, 0);
  assert(gz < 40 * 1024, `${(gz / 1024).toFixed(1)} KB`);
  return `${(gz / 1024).toFixed(1)} KB total`;
});

console.table(rows.map(({ id, check, ok }) => ({ id, ok: ok ? "PASS" : "FAIL", check })));
console.log(`elapsed ${Math.round((Date.now() - t0) / 1000)} s`);
const failed = rows.filter((r) => !r.ok);
console.log(failed.length ? `FAILED: ${failed.map((r) => r.id).join(", ")}` : `ALL ${rows.length} E2E CHECKS PASSED`);
process.exit(failed.length ? 1 : 0);
