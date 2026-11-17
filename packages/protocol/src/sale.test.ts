import { describe, expect, test } from "vitest";
import vectors from "../vectors/v1.json";
import { b64uDecode, b64uEncode } from "./base64url";
import { MAX_AMOUNT_XOF, MIN_AMOUNT_XOF, TOKEN_CHARS } from "./constants";
import {
  deriveKeys,
  generateDeviceSecret,
  newDeviceId,
  secretFromString,
} from "./keys";
import { buildSaleLnurl } from "./lnurl";
import { DecodeError, decodeSale, encodeSale, peekDeviceId } from "./sale";

const keysA = await deriveKeys(generateDeviceSecret());
const keysB = await deriveKeys(generateDeviceSecret());
const devA = newDeviceId();
const devB = newDeviceId();

/** Encrypt an arbitrary v-x payload with a real enc key, so only the field checks can reject it. */
async function seal(
  version: number,
  deviceId: string,
  amount: number,
  currency = 0x01,
) {
  const dev = b64uDecode(deviceId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new Uint8Array(13);
  new DataView(pt.buffer).setUint32(0, amount);
  pt.set(crypto.getRandomValues(new Uint8Array(8)), 4);
  pt[12] = currency;
  const aad = new Uint8Array([version, ...dev]);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      keysA.enc,
      pt,
    ),
  );
  return b64uEncode(new Uint8Array([version, ...dev, ...iv, ...ct]));
}

async function expectRejected(token: unknown, keys = keysA, opts?: object) {
  const err = await decodeSale(token as string, keys, opts).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DecodeError);
  expect((err as Error).message).toBe("invalid sale token");
  expect(Object.keys(err as object)).toEqual([]);
}

describe("decodeSale against the independent Python reference", () => {
  test("opens the reference token", async () => {
    const keys = await deriveKeys(secretFromString(vectors.secret));
    expect(await decodeSale(vectors.token, keys)).toEqual({
      deviceId: vectors.deviceId,
      amountXof: vectors.amountXof,
      sid: vectors.sid,
    });
  });
});

describe("round trip", () => {
  test.each([
    MIN_AMOUNT_XOF,
    MIN_AMOUNT_XOF + 1,
    100,
    2_500,
    12_345,
    1_000_000,
    MAX_AMOUNT_XOF,
  ])("amount %i", async (amountXof) => {
    const { token, sid } = await encodeSale(keysA, devA, { amountXof });
    expect(token).toHaveLength(TOKEN_CHARS);
    expect(sid).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(await decodeSale(token, keysA)).toEqual({
      deviceId: devA,
      amountXof,
      sid,
    });
  });

  test("custom limits allow the full uint32 range", async () => {
    const opts = { minAmountXof: 1, maxAmountXof: 2 ** 32 - 1 };
    for (const amountXof of [1, 2 ** 32 - 1]) {
      const { token } = await encodeSale(keysA, devA, { amountXof }, opts);
      expect((await decodeSale(token, keysA, opts)).amountXof).toBe(amountXof);
    }
  });

  test("wire layout is version | deviceId | iv | ciphertext+tag", async () => {
    const { token } = await encodeSale(keysA, devA, { amountXof: 2500 });
    const bytes = b64uDecode(token);
    expect(bytes.length).toBe(58);
    expect(bytes[0]).toBe(0x01);
    expect(b64uEncode(bytes.subarray(1, 17))).toBe(devA);
  });
});

describe("tamper", () => {
  test("a flipped bit in every byte (bits 0 and 7) is rejected", async () => {
    const { token } = await encodeSale(keysA, devA, { amountXof: 2500 });
    const bytes = b64uDecode(token);
    for (let i = 0; i < bytes.length; i++) {
      for (const bit of [0, 7]) {
        const t = new Uint8Array(bytes);
        t[i]! ^= 1 << bit;
        await expectRejected(b64uEncode(t));
      }
    }
  });

  test("wrong key is rejected, and two secrets cannot open each other's tokens", async () => {
    const a = await encodeSale(keysA, devA, { amountXof: 2500 });
    const b = await encodeSale(keysB, devB, { amountXof: 2500 });
    await expectRejected(a.token, keysB);
    await expectRejected(b.token, keysA);
  });

  test("deviceId bytes rewritten from A to B are rejected under either key (AAD)", async () => {
    const bytes = b64uDecode(
      (await encodeSale(keysA, devA, { amountXof: 2500 })).token,
    );
    bytes.set(b64uDecode(devB), 1);
    const swapped = b64uEncode(bytes);
    expect(peekDeviceId(swapped)).toBe(devB);
    await expectRejected(swapped, keysA);
    await expectRejected(swapped, keysB);
  });

  test.each([0x00, 0x02])(
    "validly encrypted version 0x%s is rejected",
    async (v) => {
      await expectRejected(await seal(v, devA, 2500));
    },
  );

  test("validly encrypted unknown currency is rejected", async () => {
    await expectRejected(await seal(0x01, devA, 2500, 0x02));
    expect(
      (await decodeSale(await seal(0x01, devA, 2500), keysA)).amountXof,
    ).toBe(2500);
  });
});

describe("malformed tokens", () => {
  test("truncation at every length is rejected", async () => {
    const { token } = await encodeSale(keysA, devA, { amountXof: 2500 });
    for (let n = 0; n < token.length; n++)
      await expectRejected(token.slice(0, n));
  });

  test("extra trailing bytes and characters are rejected", async () => {
    const { token } = await encodeSale(keysA, devA, { amountXof: 2500 });
    const bytes = b64uDecode(token);
    for (const extra of [1, 2, 3, 16]) {
      await expectRejected(
        b64uEncode(new Uint8Array([...bytes, ...new Uint8Array(extra)])),
      );
    }
    await expectRejected(token + "A");
    await expectRejected(token + "AA");
  });

  test.each([
    "",
    "=",
    "!".repeat(78),
    " ".repeat(78),
    "+".repeat(78),
    "A".repeat(76) + "==",
    "A".repeat(257),
    "A".repeat(100_000),
  ])("rejects %j", async (bad) => {
    await expectRejected(bad);
  });

  test("padding, whitespace or invalid characters around a valid token are rejected", async () => {
    const { token } = await encodeSale(keysA, devA, { amountXof: 2500 });
    for (const t of [
      token + "==",
      " " + token,
      token + "\n",
      token.replace(/[-_]/, "+"),
    ]) {
      if (t !== token) await expectRejected(t);
    }
  });

  test.each([null, undefined, 42, {}, []])(
    "rejects non-string %j",
    async (bad) => {
      await expectRejected(bad);
    },
  );
});

describe("amount limits", () => {
  test.each([
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    2 ** 32,
    MIN_AMOUNT_XOF - 1,
    MAX_AMOUNT_XOF + 1,
  ])("encode rejects %s", async (amountXof) => {
    await expect(encodeSale(keysA, devA, { amountXof })).rejects.toThrow(
      RangeError,
    );
  });

  test("decode rejects a validly encrypted amount outside the default limits", async () => {
    await expectRejected(await seal(0x01, devA, MIN_AMOUNT_XOF - 1));
    await expectRejected(await seal(0x01, devA, MAX_AMOUNT_XOF + 1));
    await expectRejected(await seal(0x01, devA, 0));
    await expectRejected(await seal(0x01, devA, 2 ** 32 - 1));
  });

  test("decode enforces configured limits", async () => {
    const { token } = await encodeSale(keysA, devA, { amountXof: 2500 });
    await expectRejected(token, keysA, { maxAmountXof: 2499 });
    await expectRejected(token, keysA, { minAmountXof: 2501 });
    expect(
      (await decodeSale(token, keysA, { maxAmountXof: 2500 })).amountXof,
    ).toBe(2500);
  });

  test.each([
    { minAmountXof: 0 },
    { minAmountXof: 100, maxAmountXof: 99 },
    { maxAmountXof: 2 ** 32 },
    { minAmountXof: 1.5 },
  ])("rejects invalid limit options %j", async (opts) => {
    await expect(
      encodeSale(keysA, devA, { amountXof: 2500 }, opts),
    ).rejects.toThrow(RangeError);
  });

  test.each(["", "short", devA + "A", "A".repeat(21) + "+"])(
    "encode rejects device id %j",
    async (id) => {
      await expect(
        encodeSale(keysA, id, { amountXof: 2500 }),
      ).rejects.toThrow();
    },
  );
});

describe("peekDeviceId", () => {
  test("returns the device id of a well formed token without a key", async () => {
    const { token } = await encodeSale(keysA, devA, { amountXof: 2500 });
    expect(peekDeviceId(token)).toBe(devA);
  });

  test.each(["", "A".repeat(77), "A".repeat(257), "!".repeat(78)])(
    "returns null for %j",
    (bad) => {
      expect(peekDeviceId(bad)).toBeNull();
    },
  );

  test("returns null for a wrong version byte or a non-string", async () => {
    const bytes = b64uDecode(
      (await encodeSale(keysA, devA, { amountXof: 2500 })).token,
    );
    bytes[0] = 0x02;
    expect(peekDeviceId(b64uEncode(bytes))).toBeNull();
    expect(peekDeviceId(42 as unknown as string)).toBeNull();
  });
});

describe("randomness", () => {
  // Bounded by operation count; the timeout is only a generous safety net for a loaded machine. 2,000 random
  // 96-bit IVs collide with probability about 2^-75, so a repeat here means the IV is not random (Hard rule 6).
  test("2,000 encodes never repeat an IV or a sid, and every sid is 8 bytes", async () => {
    const ivs = new Set<string>();
    const sids = new Set<string>();
    for (let i = 0; i < 2_000; i++) {
      const { token, sid } = await encodeSale(keysA, devA, { amountXof: 2500 });
      expect(b64uDecode(sid).length).toBe(8);
      ivs.add(b64uEncode(b64uDecode(token).subarray(17, 29)));
      sids.add(sid);
    }
    expect(ivs.size).toBe(2_000);
    expect(sids.size).toBe(2_000);
  }, 120_000);
});

describe("size budget", () => {
  test("30-char base url gives a 78-char token and an lnurl under 220 chars", async () => {
    const base = "https://pay.jaay.example.sn/v1";
    expect(base).toHaveLength(30);
    const { token } = await encodeSale(keysA, devA, {
      amountXof: MAX_AMOUNT_XOF,
    });
    expect(token).toHaveLength(78);
    const lnurl = buildSaleLnurl(base, token);
    console.info(`size budget: token=${token.length} lnurl=${lnurl.length}`);
    expect(lnurl.length).toBeLessThan(220);
  });
});
