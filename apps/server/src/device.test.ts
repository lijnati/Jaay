// A1 device authentication and A2 reconcile. Written before the implementation.
import { deriveConfirmCode, deriveKeys, generateDeviceSecret } from "@jaay/protocol";
import { describe, expect, test } from "vitest";
import { EXPIRY_GRACE_MS, INVOICE_EXPIRY_SEC } from "./sales";
import { ConfigError, loadConfig } from "./config";
import { enroll, ENROLL_TOKEN, makeServer, q, sell, signedPost, type Device } from "./testkit";

type Srv = ReturnType<typeof makeServer>;
const RECONCILE = "/v1/sales/reconcile";
const UNAUTHORIZED = JSON.stringify({ error: "unauthorized", sandbox: true });

async function ready() {
  const srv = makeServer();
  await srv.fx.poll();
  return srv;
}

async function invoiced(srv: Srv, dev: Device, amountXof: number) {
  const s = await sell(dev, amountXof);
  const pr = (await (await srv.req(`/lnurlp?p=${q(s.token)}`)).json()) as { callback: string; minSendable: number };
  const cb = (await (await srv.req(`${pr.callback.slice("http://localhost:8787".length)}&amount=${pr.minSendable}`)).json()) as {
    successAction: { url: string };
  };
  return { ...s, rt: cb.successAction.url.split("/r/")[1]! };
}

describe("A1 device authentication", () => {
  test("a correctly signed request is accepted", async () => {
    const srv = await ready();
    const dev = await enroll(srv);
    const res = await signedPost(srv, dev, RECONCILE, { sales: [] });
    expect(res.status).toBe(200);
  });

  test("every failure cause gets the same 401 body", async () => {
    const srv = await ready();
    const dev = await enroll(srv);
    const other = await enroll(srv);
    const stranger = await deriveKeys(generateDeviceSecret());
    const body = { sales: [] };
    const reused = "Ab".repeat(11);
    expect((await signedPost(srv, dev, RECONCILE, body, { nonce: reused })).status).toBe(200);

    const cases: [string, () => Promise<Response>][] = [
      ["missing signature", () => signedPost(srv, dev, RECONCILE, body, { omit: "x-jaay-sig" })],
      ["missing device", () => signedPost(srv, dev, RECONCILE, body, { omit: "x-jaay-device" })],
      ["missing timestamp", () => signedPost(srv, dev, RECONCILE, body, { omit: "x-jaay-ts" })],
      ["missing nonce", () => signedPost(srv, dev, RECONCILE, body, { omit: "x-jaay-nonce" })],
      ["another device's key", () => signedPost(srv, dev, RECONCILE, body, { keys: other.keys })],
      ["random key", () => signedPost(srv, dev, RECONCILE, body, { keys: stranger })],
      ["unknown device id", () => signedPost(srv, dev, RECONCILE, body, { deviceId: "QEFCQ0RFRkdISUpLTE1OTw", keys: stranger })],
      ["timestamp 121 s old", () => signedPost(srv, dev, RECONCILE, body, { ts: srv.clock.t - 121_000 })],
      ["timestamp 121 s ahead", () => signedPost(srv, dev, RECONCILE, body, { ts: srv.clock.t + 121_000 })],
      ["replayed nonce", () => signedPost(srv, dev, RECONCILE, body, { nonce: reused })],
      ["body changed after signing", () => signedPost(srv, dev, RECONCILE, body, { signBody: JSON.stringify({ sales: [1] }) })],
      ["signed for another path", () => signedPost(srv, dev, RECONCILE, body, { signPath: "/v1/wallet/summary" })],
      ["malformed nonce", () => signedPost(srv, dev, RECONCILE, body, { nonce: "short" })],
      ["malformed timestamp", () => signedPost(srv, dev, RECONCILE, body, { ts: Number.NaN })],
    ];
    for (const [name, run] of cases) {
      const res = await run();
      expect.soft(res.status, name).toBe(401);
      expect.soft(await res.text(), name).toBe(UNAUTHORIZED);
    }
  });

  test("timestamps within 120 s either way are accepted (server time is authoritative)", async () => {
    const srv = await ready();
    const dev = await enroll(srv);
    expect((await signedPost(srv, dev, RECONCILE, { sales: [] }, { ts: srv.clock.t - 120_000 })).status).toBe(200);
    expect((await signedPost(srv, dev, RECONCILE, { sales: [] }, { ts: srv.clock.t + 120_000 })).status).toBe(200);
  });

  test("a failed MAC does not consume the nonce", async () => {
    const srv = await ready();
    const dev = await enroll(srv);
    const nonce = "Cd".repeat(11);
    expect((await signedPost(srv, dev, RECONCILE, { sales: [] }, { nonce, keys: (await enroll(srv)).keys })).status).toBe(401);
    expect((await signedPost(srv, dev, RECONCILE, { sales: [] }, { nonce })).status).toBe(200);
  });
});

describe("A2 POST /v1/sales/reconcile", () => {
  test("reports each sid as the server sees it, flags mismatches, and only for this device", async () => {
    const srv = await ready();
    const dev = await enroll(srv);
    const other = await enroll(srv);

    const paid = await invoiced(srv, dev, 1000);
    await srv.req(`/sandbox/pay/${paid.sid}`, { method: "POST" });
    const pending = await invoiced(srv, dev, 2000);
    const othersSale = await invoiced(srv, other, 3000);
    const expiring = await invoiced(srv, dev, 4000);
    srv.clock.advance(INVOICE_EXPIRY_SEC * 1000 + EXPIRY_GRACE_MS + 1);
    srv.sandbox!.markPaid(srv.repo.getSale(dev.deviceId, pending.sid)!.paymentHash!);
    await srv.poller.tick(); // pending gets paid... so re-create a truly pending one below
    await srv.fx.poll();
    const open = await invoiced(srv, dev, 5000);
    const expiredRow = srv.repo.getSale(dev.deviceId, expiring.sid)!;
    expect(expiredRow.status).toBe("expired");

    const res = await signedPost(srv, dev, RECONCILE, {
      sales: [
        { sid: paid.sid, amountXof: 1000, claimedAt: 1, confirmed: true },
        { sid: paid.sid, amountXof: 999, claimedAt: 1, confirmed: true },
        { sid: open.sid, amountXof: 5000, claimedAt: 1, confirmed: false },
        { sid: open.sid, amountXof: 5000, claimedAt: 1, confirmed: true },
        { sid: expiring.sid, amountXof: 4000, claimedAt: 1, confirmed: false },
        { sid: othersSale.sid, amountXof: 3000, claimedAt: 1, confirmed: true },
        { sid: "AAAAAAAAAAA", amountXof: 10, claimedAt: 1, confirmed: false },
      ],
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const { results } = JSON.parse(text) as { results: Record<string, unknown>[] };
    expect(results[0]).toMatchObject({ sid: paid.sid, status: "paid", amountXof: 1000, mismatch: false });
    expect(typeof results[0]!.settledAt).toBe("string");
    expect(results[1]).toMatchObject({ status: "paid", amountXof: 1000, mismatch: true }); // amount differs
    expect(results[2]).toMatchObject({ status: "pending", amountXof: 5000, mismatch: false, settledAt: null });
    expect(results[3]).toMatchObject({ status: "pending", mismatch: true }); // confirmed but not paid
    expect(results[4]).toMatchObject({ status: "expired", amountXof: 4000, mismatch: false });
    expect(results[5]).toEqual({ sid: othersSale.sid, status: "unknown", amountXof: null, settledAt: null, mismatch: true });
    expect(results[6]).toEqual({ sid: "AAAAAAAAAAA", status: "unknown", amountXof: null, settledAt: null, mismatch: false });

    // Never the confirm code or a receipt token.
    for (const s of [paid, open, expiring, othersSale]) {
      expect(text).not.toContain(await deriveConfirmCode(dev.keys, s.sid));
      expect(text).not.toContain(s.rt);
    }
  });

  test("paid_late is reported as such", async () => {
    const srv = await ready();
    const dev = await enroll(srv);
    const s = await invoiced(srv, dev, 1000);
    srv.clock.advance(INVOICE_EXPIRY_SEC * 1000 + EXPIRY_GRACE_MS + 1);
    await srv.poller.tick();
    srv.sandbox!.markPaid(srv.repo.getSale(dev.deviceId, s.sid)!.paymentHash!);
    srv.clock.advance(5 * 60_000);
    await srv.poller.tick();
    const r = (await (await signedPost(srv, dev, RECONCILE, { sales: [{ sid: s.sid, amountXof: 1000, claimedAt: 0, confirmed: true }] })).json()) as {
      results: Record<string, unknown>[];
    };
    expect(r.results[0]).toMatchObject({ status: "paid_late", mismatch: false });
  });

  test("idempotent: the same batch twice gives the same answer and changes nothing", async () => {
    const srv = await ready();
    const dev = await enroll(srv);
    const s = await invoiced(srv, dev, 1000);
    const batch = { sales: [{ sid: s.sid, amountXof: 1000, claimedAt: 5, confirmed: false }] };
    const a = await (await signedPost(srv, dev, RECONCILE, batch)).text();
    const before = srv.repo.getSale(dev.deviceId, s.sid);
    const b = await (await signedPost(srv, dev, RECONCILE, batch)).text();
    expect(b).toBe(a);
    expect(srv.repo.getSale(dev.deviceId, s.sid)).toEqual(before);
  });

  test("rejects bad batches with one generic 400: too many, malformed entries, not JSON", async () => {
    const srv = await ready();
    const dev = await enroll(srv);
    const entry = { sid: "AAAAAAAAAAA", amountXof: 1, claimedAt: 0, confirmed: false };
    const bads: unknown[] = [
      { sales: Array.from({ length: 201 }, () => entry) },
      { sales: [{ ...entry, sid: "bad" }] },
      { sales: [{ ...entry, amountXof: 1.5 }] },
      { sales: [{ ...entry, amountXof: -1 }] },
      { sales: [{ ...entry, confirmed: "yes" }] },
      { sales: [{ ...entry, claimedAt: "now" }] },
      { sales: "nope" },
      {},
      "not json",
    ];
    for (const b of bads) {
      const res = await signedPost(srv, dev, RECONCILE, b);
      expect.soft(res.status).toBe(400);
      expect.soft(await res.json()).toEqual({ error: "bad request", sandbox: true });
    }
    expect((await signedPost(srv, dev, RECONCILE, { sales: Array.from({ length: 200 }, () => entry) })).status).toBe(200);
  });
});

describe("A3 POST /v1/wallet/summary", () => {
  const SUMMARY = "/v1/wallet/summary";
  const NWC = `nostr+walletconnect://${"1".repeat(64)}?relay=ws%3A%2F%2F127.0.0.1%3A10547&secret=${"2".repeat(64)}`;

  test("server-computed totals for today and all time, last paid sales, receive-only statement", async () => {
    const srv = await ready();
    const dev = await enroll(srv);
    const other = await enroll(srv);
    const yesterday = await invoiced(srv, dev, 1000);
    await srv.req(`/sandbox/pay/${yesterday.sid}`, { method: "POST" });
    srv.clock.advance(24 * 3600_000);
    await srv.fx.poll();
    const today = await invoiced(srv, dev, 2500);
    await srv.req(`/sandbox/pay/${today.sid}`, { method: "POST" });
    await invoiced(srv, dev, 7000); // unpaid: not counted
    const theirs = await invoiced(srv, other, 9000);
    await srv.req(`/sandbox/pay/${theirs.sid}`, { method: "POST" });

    const res = await signedPost(srv, dev, SUMMARY, {});
    expect(res.status).toBe(200);
    const text = await res.text();
    const j = JSON.parse(text);
    const msat = (sid: string) => srv.repo.getSale(dev.deviceId, sid)!.quoteMsat!;
    expect(j.receiveOnly).toBe(true);
    expect(j.backend).toMatchObject({ kind: "sandbox", available: true, spendMethods: [], balanceMsat: null });
    expect(j.totals.today).toEqual({ xof: 2500, msat: String(msat(today.sid)), count: 1 });
    expect(j.totals.allTime).toEqual({ xof: 3500, msat: String(msat(today.sid) + msat(yesterday.sid)), count: 2 });
    expect(j.recent.map((r: { amountXof: number }) => r.amountXof)).toEqual([2500, 1000]);
    expect(j.recent[0]).toMatchObject({ sid: today.sid.slice(0, 6), status: "paid" });
    expect(text).not.toContain(today.sid); // short form only
    expect(text).not.toContain(await deriveConfirmCode(dev.keys, today.sid));
    expect(j.recent.some((r: { amountXof: number }) => r.amountXof === 9000)).toBe(false); // other device excluded
  });

  test("recent list is capped at 50", async () => {
    const big: [number, number] = [1000, 60_000]; // 52 sales would trip the default callback limit
    const srv = makeServer({ edges: { limits: { lnurlp: big, cb: big, sandbox: big } } });
    await srv.fx.poll();
    const dev = await enroll(srv);
    for (let i = 0; i < 52; i++) {
      const s = await invoiced(srv, dev, 100 + i);
      await srv.req(`/sandbox/pay/${s.sid}`, { method: "POST" });
    }
    const j = await (await signedPost(srv, dev, SUMMARY, {})).json();
    expect(j.recent).toHaveLength(50);
    expect(j.totals.allTime.count).toBe(52);
  });

  test("NWC: balance only when get_balance is granted, labeled as the backend's report", async () => {
    const srv = makeServer({ cfg: { sandbox: false } });
    await srv.fx.poll();
    const dev = await enroll(srv, { backend: "nwc", connection: NWC });
    let j = await (await signedPost(srv, dev, SUMMARY, {})).json();
    expect(j.backend).toMatchObject({ kind: "nwc", available: true, balanceMsat: null, spendMethods: [] });
    srv.nwc.methods.push("get_balance");
    srv.clock.advance(61_000); // info cache
    j = await (await signedPost(srv, dev, SUMMARY, {})).json();
    expect(j.backend.balanceMsat).toBe("123456000");
    expect(j.backend.balanceNote).toMatch(/reported by the backend/i);
  });

  test("NWC: a spend method granted after enrollment is reported and receiveOnly turns false", async () => {
    const srv = makeServer({ cfg: { sandbox: false } });
    await srv.fx.poll();
    const dev = await enroll(srv, { backend: "nwc", connection: NWC });
    srv.nwc.methods.push("pay_invoice");
    const j = await (await signedPost(srv, dev, SUMMARY, {})).json();
    expect(j.receiveOnly).toBe(false);
    expect(j.backend.spendMethods).toEqual(["pay_invoice"]);
    expect(srv.logs.some((l) => l.includes("spend_method_detected"))).toBe(true);
  });

  test("NWC down: totals still served, backend marked unavailable", async () => {
    const srv = makeServer({ cfg: { sandbox: false } });
    await srv.fx.poll();
    const dev = await enroll(srv, { backend: "nwc", connection: NWC });
    srv.nwc.mode = "down";
    const res = await signedPost(srv, dev, SUMMARY, {});
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.backend).toMatchObject({ available: false, spendMethods: null, balanceMsat: null });
    expect(j.totals.allTime.count).toBe(0);
  });

  test("requires device auth", async () => {
    const srv = await ready();
    const dev = await enroll(srv);
    expect((await signedPost(srv, dev, SUMMARY, {}, { omit: "x-jaay-sig" })).status).toBe(401);
  });
});

describe("A4 operator enrollment token", () => {
  const NWC = `nostr+walletconnect://${"1".repeat(64)}?relay=ws%3A%2F%2F127.0.0.1%3A10547&secret=${"2".repeat(64)}`;
  const body = (backend: string, connection = "") => JSON.stringify({ label: "x", backend, connection, minXof: 1, maxXof: 10 });
  const post = (srv: Srv, b: string, auth?: string) =>
    srv.req("/api/enroll", { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: b });

  test("non-sandbox enrollment needs the bearer token; every failure is the same answer", async () => {
    const srv = makeServer({ cfg: { sandbox: false } });
    const generic = JSON.stringify({ error: "enrollment rejected" });
    for (const auth of [undefined, "Bearer wrong", `Bearer ${ENROLL_TOKEN}x`, `bearer${ENROLL_TOKEN}`, ENROLL_TOKEN]) {
      const res = await post(srv, body("nwc", NWC), auth);
      expect.soft(res.status, String(auth)).toBe(400);
      expect.soft(await res.text(), String(auth)).toBe(generic);
    }
    expect((await post(srv, body("nwc", NWC), `Bearer ${ENROLL_TOKEN}`)).status).toBe(200);
  });

  test("with no token configured, non-sandbox enrollment is impossible", async () => {
    const srv = makeServer({ cfg: { sandbox: false, enrollToken: null } });
    expect((await post(srv, body("nwc", NWC), `Bearer ${ENROLL_TOKEN}`)).status).toBe(400);
  });

  test("sandbox enrollment stays open (rate limited); mixed mode still guards real backends", async () => {
    const srv = makeServer({ cfg: { allowMixed: true } });
    expect((await post(srv, body("sandbox"))).status).toBe(200);
    expect((await post(srv, body("nwc", NWC))).status).toBe(400);
    expect((await post(srv, body("nwc", NWC), `Bearer ${ENROLL_TOKEN}`)).status).toBe(200);
  });

  test("production refuses to start without a token when a non-sandbox backend is enabled", () => {
    const base = { NODE_ENV: "production", BASE_URL: "https://pay.example.sn", JAAY_MASTER_KEY: Buffer.alloc(32, 7).toString("base64") };
    expect(() => loadConfig(base)).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, SANDBOX: "1", JAAY_ALLOW_MIXED: "1" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, JAAY_ENROLL_TOKEN: "short" })).toThrow(ConfigError);
    expect(loadConfig({ ...base, SANDBOX: "1" }).enrollToken).toBeNull();
    expect(loadConfig({ ...base, JAAY_ENROLL_TOKEN: "x".repeat(32) }).enrollToken).toBe("x".repeat(32));
  });
});
