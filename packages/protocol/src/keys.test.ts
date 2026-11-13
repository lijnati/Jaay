import { describe, expect, test } from "vitest";
import vectors from "../vectors/v1.json";
import { b64uDecode, b64uEncode } from "./base64url";
import {
  deriveKeys,
  generateDeviceSecret,
  newDeviceId,
  secretFromString,
  secretToString,
} from "./keys";

const enc = new TextEncoder();

async function hmac(key: CryptoKey, data: string): Promise<string> {
  return b64uEncode(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))),
  );
}

describe("device secret", () => {
  test("is 32 random bytes", () => {
    const a = generateDeviceSecret();
    expect(a).toBeInstanceOf(Uint8Array);
    expect(a.length).toBe(32);
    expect(generateDeviceSecret()).not.toEqual(a);
  });

  test("string form round trips", () => {
    const s = generateDeviceSecret();
    const text = secretToString(s);
    expect(text).toHaveLength(43);
    expect(secretFromString(text)).toEqual(s);
  });

  test.each([
    "",
    "A".repeat(42),
    "A".repeat(44),
    "A".repeat(42) + "=",
    "A".repeat(42) + "+",
  ])("secretFromString rejects %j", (bad) => {
    expect(() => secretFromString(bad)).toThrow();
  });
});

describe("device id", () => {
  test("is 16 random bytes as 22 base64url chars, unique over 1000", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = newDeviceId();
      expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(b64uDecode(id).length).toBe(16);
      seen.add(id);
    }
    expect(seen.size).toBe(1000);
  });
});

describe("deriveKeys", () => {
  test("keys are non-extractable with the expected algorithms and usages", async () => {
    const keys = await deriveKeys(generateDeviceSecret());
    expect(keys.enc.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect(keys.code.algorithm).toMatchObject({
      name: "HMAC",
      hash: { name: "SHA-256" },
    });
    expect(keys.auth.algorithm).toMatchObject({
      name: "HMAC",
      hash: { name: "SHA-256" },
    });
    for (const k of [keys.enc, keys.code, keys.auth]) {
      expect(k.extractable).toBe(false);
      await expect(crypto.subtle.exportKey("raw", k)).rejects.toThrow();
    }
    expect([...keys.enc.usages].sort()).toEqual(["decrypt", "encrypt"]);
    expect(keys.code.usages).toEqual(["sign"]);
  });

  test("matches the independent Python HKDF reference for the auth key", async () => {
    const keys = await deriveKeys(secretFromString(vectors.secret));
    expect(await hmac(keys.auth, "test")).toBe(vectors.authHmacOfTest);
  });

  test("is deterministic, and code and auth keys are distinct", async () => {
    const s = generateDeviceSecret();
    const a = await deriveKeys(s);
    const b = await deriveKeys(s);
    expect(await hmac(a.code, "x")).toBe(await hmac(b.code, "x"));
    expect(await hmac(a.code, "x")).not.toBe(await hmac(a.auth, "x"));
    const other = await deriveKeys(generateDeviceSecret());
    expect(await hmac(other.code, "x")).not.toBe(await hmac(a.code, "x"));
  });

  test("rejects a secret that is not 32 bytes", async () => {
    await expect(deriveKeys(new Uint8Array(31))).rejects.toThrow();
    await expect(deriveKeys(new Uint8Array(33))).rejects.toThrow();
  });
});
