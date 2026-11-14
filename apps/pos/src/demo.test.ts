import { deriveKeys, generateDeviceSecret, type DeviceKeys } from "@jaay/protocol";
import { beforeEach, expect, test } from "vitest";
import { allSales, putSale, type DeviceConfig, type SaleRec } from "./db";
import { DEMO_LABELS, demoSales, loadDemo, removeDemo, sandboxHelpers } from "./demo";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 14, 12, 0);
const cfg = (sandbox: boolean): DeviceConfig => ({ deviceId: "QEFCQ0RFRkdISUpLTE1OTw", baseUrl: "https://pay.example.sn", minXof: 50, maxXof: 500_000, label: "x", sandbox, saleWindowMin: 15, enrolledAt: 0 });
let keys: DeviceKeys;
beforeEach(async () => {
  keys = await deriveKeys(generateDeviceSecret());
});

test("sandbox helpers exist only in sandbox mode", () => {
  const qr = "LIGHTNING:LNURL1ABC";
  expect(sandboxHelpers(cfg(false), qr)).toBeNull();
  expect(sandboxHelpers(cfg(true), qr)).toEqual({ copy: qr, simUrl: "/sim/?lnurl=LIGHTNING%3ALNURL1ABC" });
});

test("12 deterministic demo sales over the last 3 days, realistic XOF amounts, 3 merchant types, flagged demo", async () => {
  const a = await demoSales(cfg(true).deviceId, NOW);
  const b = await demoSales(cfg(true).deviceId, NOW);
  expect(a).toHaveLength(12);
  expect(a.map((s) => s.sid)).toEqual(b.map((s) => s.sid));
  expect(new Set(a.map((s) => s.sid)).size).toBe(12);
  for (const s of a) {
    expect(s.sid).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(s.amountXof).toBeGreaterThanOrEqual(500);
    expect(s.amountXof).toBeLessThanOrEqual(25_000);
    expect(s.createdAt).toBeLessThan(NOW);
    expect(s.createdAt).toBeGreaterThan(NOW - 3 * DAY);
    expect(s).toMatchObject({ status: "paid", demo: true });
    expect(DEMO_LABELS).toContain(s.demoLabel);
  }
  expect(new Set(a.map((s) => s.demoLabel)).size).toBe(3);
  expect((await demoSales("AAAAAAAAAAAAAAAAAAAAAA", NOW))[0]!.sid).not.toBe(a[0]!.sid);
});

function fakeServer() {
  const calls: { path: string; body: unknown; headers: Headers }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body as string);
    calls.push({ path, body, headers: new Headers(init.headers) });
    if (path === "/sandbox/seed") return Response.json({ sandbox: true, created: body.sales.length, existing: 0 });
    if (path === "/sandbox/unseed") return Response.json({ sandbox: true, removed: 12 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

test("load is idempotent and seeds the server with the same signed batch; remove deletes only demo sales", async () => {
  const real: SaleRec = { sid: "REALSALE001", amountXof: 1000, createdAt: NOW - 1000, windowEndsAt: NOW, status: "confirmed", attempts: 1, qr: "Q" };
  await putSale(real);
  const srv = fakeServer();
  expect(await loadDemo({ fetchFn: srv.fetchFn, config: cfg(true), keys, now: NOW })).toBe(12);
  expect(await loadDemo({ fetchFn: srv.fetchFn, config: cfg(true), keys, now: NOW })).toBe(12);
  expect(await allSales()).toHaveLength(13);
  expect(srv.calls.map((c) => c.path)).toEqual(["/sandbox/seed", "/sandbox/seed"]);
  expect(JSON.stringify(srv.calls[0]!.body)).toBe(JSON.stringify(srv.calls[1]!.body));
  expect(srv.calls[0]!.headers.get("x-jaay-sig")).toBeTruthy();

  expect(await removeDemo({ fetchFn: srv.fetchFn, config: cfg(true), keys, now: NOW })).toBe(12);
  expect(await allSales()).toEqual([real]);
  expect(srv.calls.at(-1)!.path).toBe("/sandbox/unseed");
});

test("never runs outside sandbox mode: no request, no local change", async () => {
  const srv = fakeServer();
  await expect(loadDemo({ fetchFn: srv.fetchFn, config: cfg(false), keys, now: NOW })).rejects.toThrow();
  await expect(removeDemo({ fetchFn: srv.fetchFn, config: cfg(false), keys, now: NOW })).rejects.toThrow();
  expect(srv.calls).toHaveLength(0);
  expect(await allSales()).toHaveLength(0);
});

test("a failed seed leaves the local ledger unchanged", async () => {
  const failing = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
  await expect(loadDemo({ fetchFn: failing, config: cfg(true), keys, now: NOW })).rejects.toThrow();
  expect(await allSales()).toHaveLength(0);
});
