import { describe, expect, test } from "vitest";
import vectors from "../vectors/v1.json";
import { b64uEncode } from "./base64url";
import {
  constantTimeEqual,
  deriveConfirmCode,
  verifyConfirmCode,
} from "./confirm";
import { deriveKeys, generateDeviceSecret, secretFromString } from "./keys";

const keys = await deriveKeys(generateDeviceSecret());
const randomSid = () => b64uEncode(crypto.getRandomValues(new Uint8Array(8)));

describe("deriveConfirmCode", () => {
  test("matches the independent Python reference (D1)", async () => {
    const ref = await deriveKeys(secretFromString(vectors.secret));
    for (const { sid, code } of vectors.codes) {
      expect(await deriveConfirmCode(ref, sid)).toBe(code);
    }
  });

  test("is deterministic for the same key and sid, and depends on the key", async () => {
    const sid = randomSid();
    const code = await deriveConfirmCode(keys, sid);
    expect(await deriveConfirmCode(keys, sid)).toBe(code);
    const other = await deriveKeys(generateDeviceSecret());
    const sids = Array.from({ length: 20 }, randomSid);
    const a = await Promise.all(sids.map((s) => deriveConfirmCode(keys, s)));
    const b = await Promise.all(sids.map((s) => deriveConfirmCode(other, s)));
    expect(a).not.toEqual(b);
  });

  test("preserves leading zeros", async () => {
    let found: string | null = null;
    for (let i = 0; i < 2000 && !found; i++) {
      const code = await deriveConfirmCode(keys, randomSid());
      if (code.startsWith("0")) found = code;
    }
    expect(found).toMatch(/^0\d{5}$/);
  });

  test("is always 6 digits and digits are uniform over 20,000 samples", async () => {
    const counts = Array.from({ length: 6 }, () =>
      new Array<number>(10).fill(0),
    );
    for (let i = 0; i < 20_000; i++) {
      const code = await deriveConfirmCode(keys, randomSid());
      expect(code).toMatch(/^\d{6}$/);
      for (let p = 0; p < 6; p++) counts[p]![Number(code[p])]!++;
    }
    // Chi-square with 9 degrees of freedom; 40 is roughly p = 7e-6.
    for (const row of counts) {
      const chi = row.reduce((s, c) => s + (c - 2000) ** 2 / 2000, 0);
      expect(chi).toBeLessThan(40);
    }
  });

  test.each(["", "short", "A".repeat(12), "AAAAAAAAAA+"])(
    "rejects sid %j",
    async (sid) => {
      await expect(deriveConfirmCode(keys, sid)).rejects.toThrow();
    },
  );
});

describe("verifyConfirmCode", () => {
  test("accepts the right code and rejects every single-digit change", async () => {
    const sid = randomSid();
    const code = await deriveConfirmCode(keys, sid);
    expect(await verifyConfirmCode(keys, sid, code)).toBe(true);
    for (let p = 0; p < 6; p++) {
      const wrong =
        code.slice(0, p) + ((Number(code[p]) + 1) % 10) + code.slice(p + 1);
      expect(await verifyConfirmCode(keys, sid, wrong)).toBe(false);
    }
  });

  test("rejects short, long, padded and non-digit input without throwing", async () => {
    const sid = randomSid();
    const code = await deriveConfirmCode(keys, sid);
    for (const bad of [
      "",
      code.slice(0, 5),
      code + "0",
      " " + code,
      code + " ",
      "abcdef",
      code.slice(0, 5) + "\u0000",
    ]) {
      expect(await verifyConfirmCode(keys, sid, bad)).toBe(false);
    }
    for (const bad of [null, undefined, 123456, {}]) {
      expect(await verifyConfirmCode(keys, sid, bad as unknown as string)).toBe(
        false,
      );
    }
  });

  test("returns false for an invalid sid instead of throwing", async () => {
    expect(await verifyConfirmCode(keys, "bad", "123456")).toBe(false);
  });
});

describe("constantTimeEqual", () => {
  test.each([
    ["", "", true],
    ["123456", "123456", true],
    ["123456", "123457", false],
    ["123456", "12345", false],
    ["12345", "123456", false],
    ["123456", "", false],
    ["Ā", "\u0000", false],
  ])("%j vs %j is %s", (a, b, want) => {
    expect(constantTimeEqual(a, b)).toBe(want);
  });
});
