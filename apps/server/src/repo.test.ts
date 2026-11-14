import { expect, test } from "vitest";
import { SqliteRepo, type SaleRow } from "./repo";

const device = { id: "dev1", label: "x", backend: "sandbox" as const, connSealed: "c", secretSealed: "s", minXof: 50, maxXof: 100, createdAt: 1 };
const sale = (over: Partial<SaleRow> = {}): SaleRow => ({
  deviceId: "dev1",
  sid: "sid1",
  amountXof: 1000,
  status: "created",
  firstSeenAt: 10,
  receiptHash: "h1",
  receiptSealed: "r",
  quoteMsat: null,
  quoteRateMicro: null,
  quoteSource: null,
  quoteFetchedAt: null,
  quotedAt: null,
  quoteExpiresAt: null,
  invoice: null,
  paymentHash: null,
  invoiceExpiresAt: null,
  paidAt: null,
  nextCheckAt: null,
  checkFailures: 0,
  demo: 0,
  ...over,
});

test("devices and sales round trip, bigints included", () => {
  const r = new SqliteRepo(":memory:");
  r.insertDevice(device);
  expect(r.getDevice("dev1")).toEqual(device);
  expect(r.getDevice("nope")).toBeUndefined();
  const big = 2n ** 62n + 7n;
  r.insertSale(sale({ quoteMsat: big, quoteRateMicro: 62_347_800_000n }));
  const got = r.getSale("dev1", "sid1")!;
  expect(got.quoteMsat).toBe(big);
  expect(got.quoteRateMicro).toBe(62_347_800_000n);
  expect(r.getSaleByReceiptHash("h1")?.sid).toBe("sid1");
  expect(r.getSalesBySid("sid1")).toHaveLength(1);
});

test("one row per (device, sid) and per receipt hash", () => {
  const r = new SqliteRepo(":memory:");
  r.insertDevice(device);
  r.insertSale(sale());
  expect(() => r.insertSale(sale({ receiptHash: "h2" }))).toThrow();
  expect(() => r.insertSale(sale({ sid: "sid2" }))).toThrow(); // same receipt hash
});

test("updateSale is a compare-and-set on status", () => {
  const r = new SqliteRepo(":memory:");
  r.insertDevice(device);
  r.insertSale(sale());
  expect(r.updateSale("dev1", "sid1", "quoted", { status: "invoiced" })).toBe(false);
  expect(r.updateSale("dev1", "sid1", "created", { status: "quoted", quoteMsat: 5n })).toBe(true);
  expect(r.getSale("dev1", "sid1")!.status).toBe("quoted");
  expect(r.updateSale("dev1", "sid1", "created", { status: "quoted" })).toBe(false);
});

test("dueChecks returns invoiced sales that are due, and expired ones still in the late window", () => {
  const r = new SqliteRepo(":memory:");
  r.insertDevice(device);
  r.insertSale(sale({ sid: "a", receiptHash: "a", status: "invoiced", paymentHash: "p", nextCheckAt: 100, invoiceExpiresAt: 1000 }));
  r.insertSale(sale({ sid: "b", receiptHash: "b", status: "invoiced", paymentHash: "p", nextCheckAt: 300, invoiceExpiresAt: 1000 }));
  r.insertSale(sale({ sid: "c", receiptHash: "c", status: "expired", paymentHash: "p", nextCheckAt: 100, invoiceExpiresAt: 50 }));
  r.insertSale(sale({ sid: "d", receiptHash: "d", status: "expired", paymentHash: "p", nextCheckAt: 100, invoiceExpiresAt: 500 }));
  r.insertSale(sale({ sid: "e", receiptHash: "e", status: "paid", paymentHash: "p", nextCheckAt: 100 }));
  expect(r.dueChecks(200, 100, 10).map((s) => s.sid).sort()).toEqual(["a", "d"]);
});
