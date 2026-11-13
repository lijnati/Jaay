import { describe, expect, test } from "vitest";
import { diverges, FxService, msatForXof, parseDecimalMicro, QUOTE_LOCK_MS, STALE_MS, XOF_PER_EUR_MILLI } from "./fx";
import { createLogger } from "./log";
import { Clock, FakeFx } from "./testkit";

describe("money math (bigint, no floats)", () => {
  test("parseDecimalMicro is strict and truncates past 6 decimals", () => {
    expect(parseDecimalMicro("62347.80000")).toBe(62_347_800_000n);
    expect(parseDecimalMicro("62350")).toBe(62_350_000_000n);
    expect(parseDecimalMicro("1.1234569")).toBe(1_123_456n);
    for (const bad of ["", "1e5", "-1", "1,5", " 1", "1.", ".5", "0x10", 62350, null, undefined, "1".repeat(13)]) {
      expect(parseDecimalMicro(bad)).toBeNull();
    }
  });

  test("peg constant is 655.957 XOF per EUR", () => {
    expect(XOF_PER_EUR_MILLI).toBe(655_957n);
  });

  test("known value: 1000 XOF at 62,347.80 EUR/BTC is 2446 sats (2445.15 rounded up)", () => {
    expect(msatForXof(1000, 62_347_800_000n)).toBe(2_446_000n);
  });

  test("always a whole sat, rounded up, and minimal (one sat less would underpay)", () => {
    const rates = [1_000_000_000n, 62_347_800_000n, 99_999_999_999n, 123_456_789_012n];
    for (const rate of rates) {
      for (const xof of [1, 50, 999, 1000, 4321, 5_000_000, 0xffffffff]) {
        const msat = msatForXof(xof, rate);
        expect(msat % 1000n).toBe(0n);
        const sats = msat / 1000n;
        const num = BigInt(xof) * 10n ** 17n;
        const den = rate * XOF_PER_EUR_MILLI;
        expect(sats * den >= num).toBe(true);
        expect((sats - 1n) * den < num).toBe(true);
      }
    }
  });

  test("rejects non-integer or non-positive amounts and rates", () => {
    expect(() => msatForXof(1.5, 1n)).toThrow(RangeError);
    expect(() => msatForXof(0, 1n)).toThrow(RangeError);
    expect(() => msatForXof(10, 0n)).toThrow(RangeError);
  });

  test("divergence threshold is 2 percent of the lower rate", () => {
    expect(diverges(100_000n, 102_000n)).toBe(false);
    expect(diverges(100_000n, 102_001n)).toBe(true);
    expect(diverges(102_001n, 100_000n)).toBe(true);
  });
});

describe("FxService", () => {
  const make = () => {
    const clock = new Clock();
    const api = new FakeFx();
    const logs: string[] = [];
    const fx = new FxService({ fetch: api.fetch, now: clock.now, log: createLogger((l) => logs.push(l)) });
    return { clock, api, fx, logs };
  };

  test("uses Kraken when both agree, and locks a quote for 120 s with rate, source and timestamps", async () => {
    const { fx, clock } = make();
    await fx.poll();
    const q = fx.quote(1000)!;
    expect(q.source).toBe("kraken");
    expect(q.eurPerBtcMicro).toBe(62_347_800_000n);
    expect(q.msat).toBe(2_446_000n);
    expect(q.fetchedAt).toBe(clock.t);
    expect(q.quotedAt).toBe(clock.t);
    expect(q.expiresAt - q.quotedAt).toBe(QUOTE_LOCK_MS);
  });

  test("falls back to Coinbase when Kraken fails", async () => {
    const { fx, api } = make();
    api.kraken = null;
    await fx.poll();
    expect(fx.quote(1000)!.source).toBe("coinbase");
  });

  test("refuses quotes while the sources differ by more than 2 percent, recovers when they agree", async () => {
    const { fx, api, logs } = make();
    api.coinbase = "64000";
    await fx.poll();
    expect(fx.quote(1000)).toBeNull();
    expect(logs.some((l) => l.includes("fx_divergent"))).toBe(true);
    api.coinbase = "62400";
    await fx.poll();
    expect(fx.quote(1000)).not.toBeNull();
  });

  test("both down: last good rate is reused for 10 minutes, then refused", async () => {
    const { fx, api, clock } = make();
    await fx.poll();
    api.kraken = null;
    api.coinbase = null;
    clock.advance(STALE_MS);
    await fx.poll();
    expect(fx.quote(1000)).not.toBeNull();
    clock.advance(1);
    expect(fx.quote(1000)).toBeNull();
    expect(fx.status()).toBe("unavailable");
  });

  test("never fetched: no quote", () => {
    expect(make().fx.quote(1000)).toBeNull();
  });

  test("absurd or malformed exchange values are ignored", async () => {
    const { fx, api } = make();
    api.kraken = "5";
    api.coinbase = "abc";
    await fx.poll();
    expect(fx.quote(1000)).toBeNull();
  });
});
