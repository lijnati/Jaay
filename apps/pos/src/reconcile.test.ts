import { deriveKeys, generateDeviceSecret } from "@jaay/protocol";
import { expect, test } from "vitest";
import { allSales, getSale, putSale, type DeviceConfig, type SaleRec } from "./db";
import { applyResults, runReconcile, serverEvent, toReconcile } from "./reconcile";

const DAY = 86_400_000;
const rec = (sid: string, over: Partial<SaleRec> = {}): SaleRec => ({ sid, amountXof: 1000, createdAt: 10 * DAY, windowEndsAt: 10 * DAY + 900_000, status: "open", attempts: 0, qr: "Q", ...over });
const res = (sid: string, status: string, over: Record<string, unknown> = {}) => ({ sid, status, amountXof: 1000, settledAt: null, mismatch: false, ...over });
const sid = (n: number) => `S${String(n).padStart(10, "0")}`;

test("server event: an amount difference always wins as srv_mismatch, otherwise the server status", () => {
  expect(serverEvent(rec(sid(1)), res(sid(1), "paid") as never)).toBe("srv_paid");
  expect(serverEvent(rec(sid(1)), res(sid(1), "paid", { amountXof: 999 }) as never)).toBe("srv_mismatch");
  expect(serverEvent(rec(sid(1)), res(sid(1), "unknown", { amountXof: null }) as never)).toBe("srv_unknown");
});

test.each([
  ["open", "paid", "paid"],
  ["confirmed", "paid", "paid"],
  ["confirmed", "paid_late", "paid_late"],
  ["confirmed", "pending", "confirmed"],
  ["confirmed", "expired", "mismatch"], // you confirmed it but the server shows no payment
  ["confirmed", "unknown", "mismatch"],
  ["locked", "paid", "paid"],
  ["locked", "expired", "unpaid"],
  ["cancelled", "paid", "mismatch"], // paid after cancel: refund needed
  ["expired", "expired", "unpaid"],
  ["open", "unknown", "open"], // not scanned yet
  ["unpaid", "paid_late", "paid_late"],
] as const)("merge: local %s + server %s -> %s", (local, server, want) => {
  const [out] = applyResults([rec(sid(1), { status: local })], [res(sid(1), server)], 99);
  expect(out!.status).toBe(want);
  expect(out!.server).toMatchObject({ status: server, at: 99 });
});

test("results must line up with the batch, or nothing is applied", () => {
  const batch = [rec(sid(1)), rec(sid(2))];
  expect(() => applyResults(batch, [res(sid(1), "paid")], 1)).toThrow();
  expect(() => applyResults(batch, [res(sid(2), "paid"), res(sid(1), "paid")], 1)).toThrow();
  expect(() => applyResults(batch, [res(sid(1), "paid"), res(sid(2), "weird")], 1)).toThrow();
  expect(() => applyResults(batch, [res(sid(1), "paid"), { sid: sid(2) }], 1)).toThrow();
});

test("which sales are sent: not final, from the last 7 days", () => {
  const now = 20 * DAY;
  const sales = [
    rec(sid(1), { status: "open", createdAt: now - DAY }),
    rec(sid(2), { status: "paid", createdAt: now - DAY }),
    rec(sid(3), { status: "mismatch", createdAt: now - DAY }),
    rec(sid(4), { status: "confirmed", createdAt: now - 8 * DAY }),
    rec(sid(5), { status: "unpaid", createdAt: now - DAY }),
    rec(sid(6), { status: "cancelled", createdAt: now - DAY }),
  ];
  expect(toReconcile(sales, now).map((s) => s.sid)).toEqual([sid(1), sid(5), sid(6)]);
});

const config: DeviceConfig = { deviceId: "QEFCQ0RFRkdISUpLTE1OTw", baseUrl: "https://pay.example.sn", minXof: 1, maxXof: 1e6, label: "x", sandbox: true, saleWindowMin: 15, enrolledAt: 0 };

test("runReconcile batches by 200, signs each request, and applies results", async () => {
  const keys = await deriveKeys(generateDeviceSecret());
  const now = 20 * DAY;
  for (let i = 0; i < 450; i++) await putSale(rec(sid(i), { createdAt: now - 1000 + i }));
  const calls: { url: string; headers: Headers; body: { sales: { sid: string }[] } }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    calls.push({ url, headers: new Headers(init.headers), body });
    return Response.json({ results: body.sales.map((s: { sid: string }) => res(s.sid, "paid")) });
  }) as unknown as typeof fetch;
  const out = await runReconcile({ fetchFn, config, keys, now });
  expect(out).toEqual({ sent: 450, updated: 450 });
  expect(calls.map((c) => c.body.sales.length)).toEqual([200, 200, 50]);
  expect(calls[0]!.url).toBe("https://pay.example.sn/v1/sales/reconcile");
  for (const c of calls) for (const h of ["x-jaay-device", "x-jaay-ts", "x-jaay-nonce", "x-jaay-sig"]) expect(c.headers.get(h)).toBeTruthy();
  expect(new Set(calls.map((c) => c.headers.get("x-jaay-nonce"))).size).toBe(3);
  expect((await allSales()).every((s) => s.status === "paid")).toBe(true);
});

test("a failed request leaves the ledger unchanged, and is safe to retry", async () => {
  const keys = await deriveKeys(generateDeviceSecret());
  await putSale(rec(sid(1), { status: "confirmed", createdAt: 20 * DAY }));
  const before = await getSale(sid(1));
  for (const bad of [() => Promise.reject(new TypeError("offline")), async () => new Response("nope", { status: 401 }), async () => Response.json({ results: [] })]) {
    await expect(runReconcile({ fetchFn: bad as unknown as typeof fetch, config, keys, now: 20 * DAY })).rejects.toThrow();
    expect(await getSale(sid(1))).toEqual(before);
  }
  const ok = (async (_u: string, init: RequestInit) =>
    Response.json({ results: JSON.parse(init.body as string).sales.map((s: { sid: string }) => res(s.sid, "paid")) })) as unknown as typeof fetch;
  await runReconcile({ fetchFn: ok, config, keys, now: 20 * DAY });
  await runReconcile({ fetchFn: ok, config, keys, now: 20 * DAY }); // idempotent: paid is final and not resent
  expect((await getSale(sid(1)))!.status).toBe("paid");
});
