// M4 server additions, written before the implementation: fixed demo rate, sandbox seed and unseed,
// paying a sandbox invoice by payment hash, receipt polish (label escaping, sats), /sim/ serving.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ConfigError, loadConfig } from "./config";
import { msatForXofAtXofRate } from "./fx";
import { RECEIPT_TEXT, renderReceipt } from "./receipt";
import { enroll, makeServer, q, sell, signedPost, type Device } from "./testkit";

type Srv = ReturnType<typeof makeServer>;
const FIXED = 40_000_000n; // demo value: 40,000,000 XOF per BTC
const base = "http://localhost:8787";

async function invoice(srv: Srv, dev: Device, amountXof: number) {
  const s = await sell(dev, amountXof);
  const pr = (await (await srv.req(`/lnurlp?p=${q(s.token)}`)).json()) as { callback: string; minSendable: number; metadata: string };
  const cb = (await (await srv.req(`${pr.callback.slice(base.length)}&amount=${pr.minSendable}`)).json()) as { pr: string; successAction: { url: string } };
  return { ...s, pr, cb, rt: cb.successAction.url.split("/r/")[1]! };
}

describe("fixed demo rate", () => {
  test("only allowed with SANDBOX=1; strict integer format", () => {
    expect(() => loadConfig({ JAAY_FX_FIXED_XOF_PER_BTC: "40000000" })).toThrow(ConfigError);
    expect(() => loadConfig({ SANDBOX: "1", JAAY_FX_FIXED_XOF_PER_BTC: "4e7" })).toThrow(ConfigError);
    expect(() => loadConfig({ SANDBOX: "1", JAAY_FX_FIXED_XOF_PER_BTC: "0" })).toThrow(ConfigError);
    expect(loadConfig({ SANDBOX: "1", JAAY_FX_FIXED_XOF_PER_BTC: "40000000" }).fxFixedXofPerBtc).toBe(FIXED);
    expect(loadConfig({ SANDBOX: "1" }).fxFixedXofPerBtc).toBeNull();
  });

  test("same math: whole sats, rounded up", () => {
    expect(msatForXofAtXofRate(1000, FIXED)).toBe(2_500_000n); // exactly 2500 sats
    expect(msatForXofAtXofRate(1001, FIXED)).toBe(2_503_000n); // 2502.5 rounded up
    expect(msatForXofAtXofRate(1, FIXED)).toBe(3_000n); // 2.5 rounded up
  });

  test("labeled everywhere, never fetches a market rate, 120 s lock unchanged", async () => {
    const srv = makeServer({ cfg: { fxFixedXofPerBtc: FIXED } });
    await srv.fx.poll();
    expect(srv.fxApi.calls).toBe(0);
    expect(await (await srv.req("/healthz")).json()).toEqual({ status: "ok", fx: "fixed demo rate", sandbox: true });
    const dev = await enroll(srv);
    const s = await invoice(srv, dev, 2500);
    expect(s.pr.minSendable).toBe(6_250_000);
    expect(JSON.parse(s.pr.metadata)[0][1]).toMatch(/fixed demo rate/);
    const row = srv.repo.getSale(dev.deviceId, s.sid)!;
    expect(row.quoteSource).toBe("fixed-demo");
    expect(row.quoteExpiresAt! - row.quotedAt!).toBe(120_000);
    await srv.req(`/sandbox/pay/${s.sid}`, { method: "POST" });
    const html = await (await srv.req(`/r/${s.rt}`, { headers: { "accept-language": "en" } })).text();
    expect(html).toMatch(/fixed demo rate/);
    expect(html).toContain("6 250 sats");
  });
});

describe("sandbox seed and unseed (demo data)", () => {
  const seedBody = (n: number, now: number) => ({
    sales: Array.from({ length: n }, (_, i) => ({ sid: `DEMO${String(i).padStart(7, "0")}`, amountXof: 500 + i * 1000, paidAt: now - (i + 1) * 3_600_000 })),
  });

  test("creates paid sales for this device, idempotent, visible to reconcile and wallet, removable", async () => {
    const srv = makeServer({ cfg: { fxFixedXofPerBtc: FIXED } });
    const dev = await enroll(srv);
    const real = await invoice(srv, dev, 1000);
    await srv.req(`/sandbox/pay/${real.sid}`, { method: "POST" });
    const body = seedBody(12, srv.clock.t);

    const r1 = await signedPost(srv, dev, "/sandbox/seed", body);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ sandbox: true, created: 12, existing: 0 });
    const r2 = await signedPost(srv, dev, "/sandbox/seed", body);
    expect(await r2.json()).toEqual({ sandbox: true, created: 0, existing: 12 });

    const summary = await (await signedPost(srv, dev, "/v1/wallet/summary", {})).json();
    expect(summary.totals.allTime.count).toBe(13);
    expect(summary.totals.allTime.xof).toBe(1000 + body.sales.reduce((a, s) => a + s.amountXof, 0));
    const rec = await (await signedPost(srv, dev, "/v1/sales/reconcile", { sales: [{ sid: body.sales[3]!.sid, amountXof: body.sales[3]!.amountXof, claimedAt: 0, confirmed: false }] })).json();
    expect(rec.results[0]).toMatchObject({ status: "paid", mismatch: false });

    const un = await signedPost(srv, dev, "/sandbox/unseed", {});
    expect(await un.json()).toEqual({ sandbox: true, removed: 12 });
    const after = await (await signedPost(srv, dev, "/v1/wallet/summary", {})).json();
    expect(after.totals.allTime.count).toBe(1); // the real sandbox sale stays
  });

  test("never touches another device's sales and refuses bad batches", async () => {
    const srv = makeServer();
    await srv.fx.poll();
    const dev = await enroll(srv);
    const other = await enroll(srv);
    const real = await invoice(srv, other, 1000);
    // A seed entry reusing another device's sid creates this device's own row; the other row is untouched.
    await signedPost(srv, dev, "/sandbox/seed", { sales: [{ sid: real.sid, amountXof: 777, paidAt: srv.clock.t - 1000 }] });
    expect(srv.repo.getSale(other.deviceId, real.sid)!.status).toBe("invoiced");
    for (const bad of [
      { sales: [{ sid: "short", amountXof: 1, paidAt: 1 }] },
      { sales: [{ sid: "AAAAAAAAAAA", amountXof: 0, paidAt: srv.clock.t }] },
      { sales: [{ sid: "AAAAAAAAAAA", amountXof: 1, paidAt: srv.clock.t + 60_000 }] }, // future
      { sales: [{ sid: "AAAAAAAAAAA", amountXof: 1, paidAt: srv.clock.t - 31 * 86_400_000 }] }, // too old
      { sales: Array.from({ length: 51 }, (_, i) => ({ sid: `B${String(i).padStart(10, "0")}`, amountXof: 1, paidAt: srv.clock.t })) },
    ]) {
      expect((await signedPost(srv, dev, "/sandbox/seed", bad)).status).toBe(400);
    }
    expect((await signedPost(srv, dev, "/sandbox/seed", { sales: [] }, { omit: "x-jaay-sig" })).status).toBe(401);
  });

  test("does not exist on a non-sandbox server", async () => {
    const srv = makeServer({ cfg: { sandbox: false } });
    for (const p of ["/sandbox/seed", "/sandbox/unseed", "/sandbox/pay/AAAAAAAAAAA"]) expect((await srv.req(p, { method: "POST" })).status).toBe(404);
  });
});

describe("paying a sandbox invoice by payment hash (the simulator never knows the sid)", () => {
  test("POST /sandbox/pay/<payment hash> settles exactly that invoice", async () => {
    const srv = makeServer({ cfg: { fxFixedXofPerBtc: FIXED } });
    const dev = await enroll(srv);
    const s = await invoice(srv, dev, 1500);
    const hash = srv.repo.getSale(dev.deviceId, s.sid)!.paymentHash!;
    expect((await srv.req(`/sandbox/pay/${"0".repeat(64)}`, { method: "POST" })).status).toBe(404);
    const r = await srv.req(`/sandbox/pay/${hash}`, { method: "POST" });
    expect(await r.json()).toEqual({ sandbox: true, status: "paid" });
    expect(srv.repo.getSale(dev.deviceId, s.sid)!.status).toBe("paid");
  });
});

describe("receipt polish", () => {
  const paid = (label: string) => ({ kind: "paid" as const, amountXof: 2500, paidAt: Date.UTC(2026, 10, 14, 9, 30), code: "123456", late: false, label, msat: "6250000", fixedRate: false });

  test.each([
    `<script>alert(1)</script>`,
    `"><img src=x onerror=alert(1)>`,
    `Chez 'Awa' & "Fils"`,
    `</title><style>*{}</style>`,
  ])("merchant label is HTML-escaped: %s", (label) => {
    const html = renderReceipt(paid(label), "en", false);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html.match(/<style>/g)).toHaveLength(1); // only the page's own stylesheet; escaped text may still read "onerror=" harmlessly
    expect(html).toContain(label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"));
  });

  test("paid page: label, XOF and sats, time, SANDBOX; under 15 KB; pending page shows the label but no code", async () => {
    const html = renderReceipt(paid("Boutique Awa"), "fr", true);
    for (const s of ["Boutique Awa", "2 500 XOF", "6 250 sats", "2026-11-14 09:30 UTC", "SANDBOX", "123456"]) expect(html).toContain(s);
    expect(Buffer.byteLength(html)).toBeLessThan(15 * 1024);
    const srv = makeServer({ cfg: { fxFixedXofPerBtc: FIXED } });
    const dev = await enroll(srv, { label: "Boutique Awa" });
    const s = await invoice(srv, dev, 1000);
    const pending = await (await srv.req(`/r/${s.rt}`)).text();
    expect(pending).toContain("Boutique Awa");
    expect(pending).not.toMatch(/class="code"/);
  });

  test("pending page: label, XOF amount, waiting message and server-time last check, in EN and FR; no code", async () => {
    const srv = makeServer({ cfg: { fxFixedXofPerBtc: FIXED } });
    const dev = await enroll(srv, { label: "Boutique Awa" });
    const s = await invoice(srv, dev, 2500);
    const clock = new Date(srv.clock.t).toISOString().slice(11, 19);
    const fr = await (await srv.req(`/r/${s.rt}`)).text();
    const en = await (await srv.req(`/r/${s.rt}`, { headers: { "accept-language": "en" } })).text();
    expect(fr).toContain("2 500 XOF");
    expect(fr).toContain("En attente de votre paiement. Si vous avez déjà payé, touchez Vérifier à nouveau.");
    expect(fr).toContain(`Dernière vérification : ${clock} UTC`);
    expect(en).toContain("Waiting for your payment. If you already paid, tap Check again.");
    expect(en).toContain(`Last checked: ${clock} UTC`);
    // An empty href reloads this same receipt URL.
    expect(fr).toContain('<a class="again" href="">Vérifier à nouveau</a>');
    expect(en).toContain('<a class="again" href="">Check again</a>');
    for (const html of [fr, en]) {
      // No timed reload (WCAG 2.2.1, axe meta-refresh): the customer decides when to check again.
      expect(html).not.toMatch(/http-equiv="refresh"/i);
      expect(html).not.toMatch(/class="(code|vh)"/);
    }
  });

  test("paid page: code grouped in threes for reading, plain digits for screen readers, still the largest text; keep-page note", () => {
    const fr = renderReceipt(paid("Boutique Awa"), "fr", false);
    expect(fr).toContain('<p class="code"><span aria-hidden="true">123 456</span><span class="vh">123456</span></p>');
    expect(fr).toContain("Gardez cette page. C'est votre reçu.");
    expect(renderReceipt(paid("x"), "en", false)).toContain("Keep this page. It is your receipt.");
    const sizes = [...fr.matchAll(/font:700 (\d+)px|font-size:(\d+)px/g)].map((m) => Number(m[1] ?? m[2]));
    expect(/\.code\{font:700 (\d+)px/.exec(fr)![1]).toBe(String(Math.max(...sizes)));
  });

  test("a hostile label stored directly in the database is still escaped on the live page", async () => {
    const srv = makeServer({ cfg: { fxFixedXofPerBtc: FIXED } });
    const dev = await enroll(srv);
    srv.repo.renameDevice(dev.deviceId, `<script>alert("x")</script>`);
    const s = await invoice(srv, dev, 1000);
    await srv.req(`/sandbox/pay/${s.sid}`, { method: "POST" });
    const html = await (await srv.req(`/r/${s.rt}`)).text();
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });
});

describe("/sim/ serving", () => {
  test("serves JAAY_SIM_DIR at /sim/ with the same strict CSP; absent otherwise", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jaay-sim-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>sim</title>");
    const srv = makeServer({ cfg: { simDir: dir } });
    const r = await srv.req("/sim/");
    expect(await r.text()).toContain("<title>sim</title>");
    expect(r.headers.get("content-security-policy")).toMatch(/^default-src 'self'; script-src 'self'/);
    expect((await makeServer().req("/sim/")).status).toBe(404);
    expect(() => loadConfig({ JAAY_SIM_DIR: join(tmpdir(), "nope-sim") })).toThrow(ConfigError);
  });
});

test("receipt strings: every key in FR and EN, non-empty; the page has no other user-visible text", () => {
  expect(Object.keys(RECEIPT_TEXT.en).sort()).toEqual(Object.keys(RECEIPT_TEXT.fr).sort());
  for (const lang of ["fr", "en"] as const) for (const [k, v] of Object.entries(RECEIPT_TEXT[lang])) expect(v.trim(), `${lang}.${k}`).not.toBe("");
  const strip = (html: string) => html.replace(/<style>[^<]*<\/style>/, "").replace(/<[^>]+>/g, "\n").split("\n").map((x) => x.trim()).filter(Boolean);
  const views = [
    renderReceipt({ kind: "generic" }, "en", true),
    renderReceipt({ kind: "pending", label: "L", amountXof: 1000, checkedAt: 0 }, "en", true),
    renderReceipt({ kind: "paid", amountXof: 1000, paidAt: 0, code: "123456", late: true, label: "L", msat: "1000", fixedRate: true }, "en", true),
  ];
  const known = Object.values(RECEIPT_TEXT.en);
  for (const line of views.flatMap(strip)) {
    // Each text node is either catalog text (possibly followed by a value), the wordmark, or data (label, numbers, time).
    const ok = line === "jaay" || /^[\d\s\u00a0:()XOFsatUTC.-]+$/.test(line) || known.some((k) => line.startsWith(k) || line.includes(k)) || line === "L" || /^jaay /.test(line);
    expect(ok, line).toBe(true);
  }
});

test("receipt design: every colour it uses comes from the shared tokens (apps/pos/src/tokens.css)", async () => {
  const { readFileSync } = await import("node:fs");
  const tokens = readFileSync(new URL("../../pos/src/tokens.css", import.meta.url), "utf8").toUpperCase();
  const html = renderReceipt({ kind: "paid", amountXof: 1000, paidAt: 0, code: "123456", late: false, label: "L", msat: "1000", fixedRate: false }, "en", true);
  const used = [...new Set(html.match(/#[0-9A-Fa-f]{6}/g) ?? [])];
  expect(used.length).toBeGreaterThan(5);
  for (const c of used) expect(tokens, c).toContain(c.toUpperCase());
});
