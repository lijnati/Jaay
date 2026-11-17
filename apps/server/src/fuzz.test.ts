// M6 fuzz and property tests (fast-check). Fixed seed and a fixed number of runs, so every run is reproducible:
// a failure prints the seed and the shrunk counterexample. The protocol properties live here (they import the
// package through its public API) so packages/protocol itself stays untouched.
import {
  DecodeError,
  decodeSale,
  deriveConfirmCode,
  deriveKeys,
  encodeSale,
  generateDeviceSecret,
  lnurlDecode,
  lnurlEncode,
  MAX_AMOUNT_XOF,
  MIN_AMOUNT_XOF,
  newDeviceId,
  verifyConfirmCode,
  type DeviceKeys,
} from "@jaay/protocol";
import fc from "fast-check";
import { beforeAll, describe, expect, test } from "vitest";
import { GENERIC_LNURL_ERROR } from "./app";
import { pickLang, renderReceipt } from "./receipt";
import { enroll, makeServer, q, sell, signedPost, type Device } from "./testkit";

const SEED = 20261118;
const runs = (numRuns: number) => ({ seed: SEED, numRuns });
const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
let ipSeq = 0;
/** A fresh client address per request, so the rate limiter never answers in place of the code under test. */
const nextIp = () => {
  const n = ++ipSeq;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
};

let keys: DeviceKeys;
let devId: string;
let valid: string;
beforeAll(async () => {
  keys = await deriveKeys(generateDeviceSecret());
  devId = newDeviceId();
  valid = (await encodeSale(keys, devId, { amountXof: 2500 })).token;
});

/** Strings shaped like tokens and not: garbage, random base64url bytes, truncated, oversized, wrong version. */
const tokenish = () =>
  fc.oneof(
    fc.string({ maxLength: 300 }),
    fc.string({ unit: "binary", maxLength: 120 }),
    fc.uint8Array({ maxLength: 200 }).map(b64u),
    fc.nat({ max: 77 }).map((n) => valid.slice(0, n)),
    fc.string({ minLength: 1, maxLength: 200 }).map((s) => valid + s),
    fc.integer({ min: 0, max: 255 }).filter((v) => v !== 1).map((v) => {
      const b = Buffer.from(valid, "base64url");
      b[0] = v;
      return b.toString("base64url");
    }),
    fc.constant("A".repeat(78)),
  );

describe("protocol properties", () => {
  test("decodeSale fails closed with DecodeError on any input, never another exception", async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(tokenish(), fc.anything().map((x) => x as unknown as string)), async (input) => {
        const err = await decodeSale(input, keys).then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(DecodeError);
        expect((err as Error).message).toBe("invalid sale token");
      }),
      runs(500),
    );
  });

  test("every single-bit flip of a valid token is rejected", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: MIN_AMOUNT_XOF, max: MAX_AMOUNT_XOF }), fc.nat({ max: 58 * 8 - 1 }), async (amountXof, bit) => {
        const { token } = await encodeSale(keys, devId, { amountXof });
        const b = Buffer.from(token, "base64url");
        expect(b.length).toBe(58);
        b[bit >> 3]! ^= 1 << (bit & 7);
        await expect(decodeSale(b.toString("base64url"), keys)).rejects.toBeInstanceOf(DecodeError);
      }),
      runs(300),
    );
  });

  test("encode then decode round-trips any amount within the limits", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: MIN_AMOUNT_XOF, max: MAX_AMOUNT_XOF }), async (amountXof) => {
        const { token, sid } = await encodeSale(keys, devId, { amountXof });
        expect(await decodeSale(token, keys)).toEqual({ deviceId: devId, amountXof, sid });
      }),
      runs(300),
    );
  });

  test("LNURL encode then decode round-trips; random text never decodes", () => {
    fc.assert(
      fc.property(fc.oneof(fc.webUrl({ withQueryParameters: true, withFragments: true }), fc.string({ maxLength: 300 })), (url) => {
        expect(lnurlDecode(lnurlEncode(url))).toBe(url);
        expect(lnurlDecode(lnurlEncode(url).toUpperCase())).toBe(url);
      }),
      runs(500),
    );
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        expect(() => lnurlDecode(s)).toThrow();
      }),
      runs(500),
    );
  });

  test("the confirm code is always exactly 6 digits, deterministic, and verifies", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 8, maxLength: 8 }), async (raw) => {
        const sid = b64u(raw);
        const a = await deriveConfirmCode(keys, sid);
        expect(a).toMatch(/^\d{6}$/);
        expect(await deriveConfirmCode(keys, sid)).toBe(a);
        expect(await verifyConfirmCode(keys, sid, a)).toBe(true);
      }),
      runs(300),
    );
  });
});

// ---------- server: random requests never 5xx, never leak a stack or which check failed ----------
const LEAK = /\bat .*\(|stack|TypeError|RangeError|SyntaxError|DecodeError|SealError|sqlite|node:|\.ts:\d/i;
const headerArb = fc.dictionary(
  fc.constantFrom("accept-language", "content-type", "x-forwarded-for", "x-jaay-device", "x-jaay-ts", "x-jaay-nonce", "x-jaay-sig", "authorization", "origin", "cookie"),
  fc.string({ maxLength: 120 }).map((s) => s.replace(/[\r\n\0]/g, "")),
  { maxKeys: 6 },
);

describe("server fuzz", () => {
  test("/lnurlp and /lnurlp/cb: any query gives the uniform LNURL error, never a 5xx", async () => {
    const srv = makeServer();
    await srv.fx.poll(); // a live rate, so a valid token would get past FX: only the token or amount can fail
    const dev = await enroll(srv);
    const real = (await sell(dev, 2500)).token;
    const flipped = fc.nat({ max: 58 * 8 - 1 }).map((bit) => {
      const b = Buffer.from(real, "base64url");
      b[bit >> 3]! ^= 1 << (bit & 7);
      return b.toString("base64url");
    });
    const want = JSON.stringify({ ...GENERIC_LNURL_ERROR, sandbox: true });
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(tokenish(), flipped),
        fc.option(fc.oneof(fc.string({ maxLength: 30 }), fc.bigInt({ min: -(10n ** 20n), max: 10n ** 20n }).map(String))),
        fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.string({ maxLength: 40 }), { maxKeys: 3 }),
        headerArb,
        async (p, amount, extra, headers) => {
          const qs = new URLSearchParams({ ...extra, p });
          if (amount !== null) qs.set("amount", amount);
          for (const path of ["/lnurlp", "/lnurlp/cb"]) {
            const res = await srv.req(`${path}?${qs}`, { headers, ip: nextIp() });
            const body = await res.text();
            expect(res.status).toBe(400);
            expect(body).toBe(want);
          }
        },
      ),
      runs(150),
    );
  });

  test("/r/:rt and /api/receipt/:rt/status: any token gives the generic answer, never a 5xx", async () => {
    const srv = makeServer();
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.string({ minLength: 1, maxLength: 200 }), fc.uint8Array({ minLength: 1, maxLength: 40 }).map(b64u)), headerArb, async (rt, headers) => {
        const r = await srv.req(`/r/${encodeURIComponent(rt)}`, { headers, ip: nextIp() });
        const html = await r.text();
        expect([404, 414]).toContain(r.status);
        if (r.status === 404) expect(html).toBe(renderReceipt({ kind: "generic" }, pickLang(headers["accept-language"]), true));
        expect(html).not.toMatch(LEAK);
        const s = await srv.req(`/api/receipt/${encodeURIComponent(rt)}/status`, { headers, ip: nextIp() });
        expect(s.status).toBeLessThan(500);
        if (s.status === 404) expect(await s.json()).toEqual({ status: "expired", sandbox: true });
      }),
      runs(200),
    );
  });

  test("device endpoints: random headers and bodies give one generic 401, never a 5xx", async () => {
    const srv = makeServer();
    const dev = await enroll(srv);
    const unauthorized = JSON.stringify({ error: "unauthorized", sandbox: true });
    const devHeaders = fc.record(
      {
        "x-jaay-device": fc.oneof(fc.constant(dev.deviceId), fc.string({ maxLength: 40 }), fc.uint8Array({ minLength: 16, maxLength: 16 }).map(b64u)),
        "x-jaay-ts": fc.oneof(fc.constant(String(srv.clock.t)), fc.string({ maxLength: 20 }), fc.integer().map(String)),
        "x-jaay-nonce": fc.oneof(fc.string({ maxLength: 30 }), fc.uint8Array({ minLength: 16, maxLength: 16 }).map(b64u)),
        "x-jaay-sig": fc.oneof(fc.string({ maxLength: 60 }), fc.uint8Array({ minLength: 32, maxLength: 32 }).map(b64u)),
      },
      { requiredKeys: [] },
    );
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("/v1/sales/reconcile", "/v1/wallet/summary", "/sandbox/seed", "/sandbox/unseed"),
        devHeaders,
        fc.oneof(fc.string({ maxLength: 300 }), fc.json({ maxDepth: 3 })),
        async (path, headers, body) => {
          const res = await srv.req(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body, ip: nextIp() });
          expect(res.status).toBe(401);
          expect(await res.text()).toBe(unauthorized);
        },
      ),
      runs(200),
    );
  });

  test("device endpoints: a correctly signed but malformed body gives the generic 400, never a 5xx", async () => {
    const srv = makeServer();
    const dev = await enroll(srv);
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.string({ maxLength: 300 }), fc.json({ maxDepth: 4 })), async (body) => {
        const res = await signedPost(srv, dev, "/v1/sales/reconcile", body, { ip: nextIp() });
        expect(res.status).toBeLessThan(500);
        const text = await res.text();
        expect(text).not.toMatch(LEAK);
        if (res.status !== 200) expect(text).toBe(JSON.stringify({ error: "bad request", sandbox: true }));
      }),
      runs(200),
    );
    expect(srv.logs.join("\n")).not.toMatch(LEAK);
  });
});

// ---------- reconcile: random batches never expose another device's data, and are idempotent ----------
describe("reconcile properties", () => {
  test("a device sees only its own sales; asking twice changes nothing and answers the same", async () => {
    const srv = makeServer();
    await srv.fx.poll();
    const a = await enroll(srv);
    const b = await enroll(srv);
    const own = async (d: Device, amountXof: number, pay: boolean) => {
      const s = await sell(d, amountXof);
      const pr = (await (await srv.req(`/lnurlp?p=${q(s.token)}`, { ip: nextIp() })).json()) as { callback: string; minSendable: number };
      const cb = new URL(pr.callback);
      await srv.req(`${cb.pathname}${cb.search}&amount=${pr.minSendable}`, { ip: nextIp() });
      if (pay) await srv.req(`/sandbox/pay/${s.sid}`, { method: "POST", ip: nextIp() });
      return s.sid;
    };
    const aSids = [await own(a, 1000, true), await own(a, 2000, false)];
    const bSids = [await own(b, 3000, true), await own(b, 4000, false), await own(b, 5000, true)];
    const snapshot = () => JSON.stringify([...aSids.map((s) => srv.repo.getSale(a.deviceId, s)), ...bSids.map((s) => srv.repo.getSale(b.deviceId, s))], (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v));
    const before = snapshot();
    // Not vacuous: the device's own paid sale really answers "paid" with its amount.
    const own0 = (await (await signedPost(srv, a, "/v1/sales/reconcile", { sales: [{ sid: aSids[0], amountXof: 1000, claimedAt: 1, confirmed: true }] }, { ip: nextIp() })).json()) as { results: { status: string; amountXof: number }[] };
    expect(own0.results[0]).toMatchObject({ status: "paid", amountXof: 1000 });
    const entry = fc.record({
      sid: fc.oneof(fc.constantFrom(...aSids, ...bSids), fc.uint8Array({ minLength: 8, maxLength: 8 }).map(b64u)),
      amountXof: fc.integer({ min: 1, max: 10_000_000 }),
      claimedAt: fc.nat({ max: 2 ** 40 }),
      confirmed: fc.boolean(),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(entry, { maxLength: 30 }), async (sales) => {
        const ask = async () => ((await (await signedPost(srv, a, "/v1/sales/reconcile", { sales }, { ip: nextIp() })).json()) as { results: { sid: string; status: string; amountXof: number | null; settledAt: string | null }[] }).results;
        const first = await ask();
        const second = await ask();
        expect(second).toEqual(first);
        expect(first.map((r) => r.sid)).toEqual(sales.map((s) => s.sid));
        for (const r of first) {
          if (!aSids.includes(r.sid)) expect(r).toMatchObject({ status: "unknown", amountXof: null, settledAt: null });
        }
        expect(JSON.stringify(first)).not.toMatch(/3000|4000|5000/);
      }),
      runs(100),
    );
    expect(snapshot()).toBe(before);
  });
});
