import { describe, expect, test } from "vitest";
import { ConfigError, loadConfig, parseMasterKey } from "./config";
import { createSealer, SealError } from "./seal";
import { MASTER_KEY } from "./testkit";

describe("secrets at rest (security item 11)", () => {
  const s = createSealer(MASTER_KEY);

  test("round trips, versioned, and a fresh IV every time", () => {
    const a = s.seal("nostr+walletconnect://secret", "connection:dev1");
    const b = s.seal("nostr+walletconnect://secret", "connection:dev1");
    expect(a.startsWith("v1.")).toBe(true);
    expect(a).not.toBe(b);
    expect(Buffer.from(a.slice(3), "base64url").subarray(0, 12)).not.toEqual(Buffer.from(b.slice(3), "base64url").subarray(0, 12));
    expect(s.open(a, "connection:dev1")).toBe("nostr+walletconnect://secret");
  });

  test("wrong master key fails closed", () => {
    const sealed = s.seal("x", "p");
    const other = createSealer(new Uint8Array(32).fill(9));
    expect(() => other.open(sealed, "p")).toThrow(SealError);
  });

  test("any byte flip in iv, ciphertext or tag is detected", () => {
    const sealed = s.seal("device secret value", "device-secret:d");
    const raw = Buffer.from(sealed.slice(3), "base64url");
    for (let i = 0; i < raw.length; i++) {
      const t = Buffer.from(raw);
      t[i]! ^= 0x01;
      expect(() => s.open(`v1.${t.toString("base64url")}`, "device-secret:d")).toThrow(SealError);
    }
  });

  test("a sealed value cannot be moved to another row or field (purpose is authenticated)", () => {
    const sealed = s.seal("x", "device-secret:A");
    expect(() => s.open(sealed, "device-secret:B")).toThrow(SealError);
    expect(() => s.open(sealed, "connection:A")).toThrow(SealError);
  });

  test("unknown version, truncation and garbage fail closed with one error type and no detail", () => {
    for (const bad of ["", "v2.AAAA", "v1.", "v1.AAAA", "garbage", s.seal("x", "p").slice(0, -4)]) {
      try {
        s.open(bad, "p");
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(SealError);
        expect((e as Error).message).toBe("sealed value rejected");
      }
    }
  });
});

describe("master key config", () => {
  const good = Buffer.from(MASTER_KEY).toString("base64");

  test("parses strict 32-byte base64 (standard or url alphabet)", () => {
    expect(parseMasterKey(good)).toEqual(MASTER_KEY);
    expect(parseMasterKey(Buffer.from(MASTER_KEY).toString("base64url"))).toEqual(MASTER_KEY);
    for (const bad of [undefined, "", "short", Buffer.alloc(31).toString("base64"), Buffer.alloc(33).toString("base64"), `${good}x`]) {
      expect(parseMasterKey(bad)).toBeNull();
    }
  });

  test("production refuses to start without a valid master key", () => {
    expect(() => loadConfig({ NODE_ENV: "production", BASE_URL: "https://pay.example.sn" })).toThrow(ConfigError);
    expect(() => loadConfig({ NODE_ENV: "production", BASE_URL: "https://pay.example.sn", JAAY_MASTER_KEY: "bad" })).toThrow(ConfigError);
    expect(loadConfig({ NODE_ENV: "production", BASE_URL: "https://pay.example.sn", JAAY_MASTER_KEY: good }).ephemeralMasterKey).toBe(false);
  });

  test("dev without a key gets an ephemeral one; a malformed key is still refused", () => {
    expect(loadConfig({}).ephemeralMasterKey).toBe(true);
    expect(() => loadConfig({ JAAY_MASTER_KEY: "bad" })).toThrow(ConfigError);
  });

  test("BASE_URL must be https outside localhost, with no query", () => {
    expect(() => loadConfig({ BASE_URL: "http://pay.example.sn" })).toThrow(ConfigError);
    expect(() => loadConfig({ BASE_URL: "https://pay.example.sn/?x=1" })).toThrow(ConfigError);
    expect(loadConfig({ BASE_URL: "https://pay.example.sn/" }).baseUrl).toBe("https://pay.example.sn");
  });
});
