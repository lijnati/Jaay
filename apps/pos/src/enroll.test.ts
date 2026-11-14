import { decodeSale, deriveConfirmCode, encodeSale, generateDeviceSecret, newDeviceId, secretToString } from "@jaay/protocol";
import { expect, test } from "vitest";
import { getConfig, getKeys } from "./db";
import { enrollDevice, parseEnrollPayload, readEnrollFragment } from "./enroll";

const ORIGIN = "https://pay.example.sn";
const payload = (over: Record<string, unknown> = {}) => ({
  deviceId: newDeviceId(),
  deviceSecretB64u: secretToString(generateDeviceSecret()),
  baseUrl: ORIGIN,
  minXof: 50,
  maxXof: 100_000,
  label: "Boutique Awa",
  sandbox: true,
  ...over,
});

test("parses raw JSON or the base64url fragment form, strictly", () => {
  const p = payload();
  expect(parseEnrollPayload(JSON.stringify(p))).toEqual(p);
  expect(parseEnrollPayload(Buffer.from(JSON.stringify(p)).toString("base64url"))).toEqual(p);
  for (const bad of [
    "",
    "not json",
    JSON.stringify({ ...p, extra: 1 }),
    JSON.stringify({ ...p, deviceId: "short" }),
    JSON.stringify({ ...p, deviceSecretB64u: "A".repeat(42) }),
    JSON.stringify({ ...p, baseUrl: "http://evil.example" }),
    JSON.stringify({ ...p, baseUrl: "https://x.example/?q=1" }),
    JSON.stringify({ ...p, minXof: 10, maxXof: 5 }),
    JSON.stringify({ ...p, minXof: 1.5 }),
    JSON.stringify({ ...p, label: "" }),
    JSON.stringify({ ...p, label: "<img src=x onerror=alert(1)>" }),
    JSON.stringify({ ...p, sandbox: "yes" }),
    "x".repeat(3000),
  ]) {
    expect(parseEnrollPayload(bad), bad.slice(0, 40)).toBeNull();
  }
});

test("the #enroll= fragment is read once and removed from the address bar immediately", () => {
  const replaced: string[] = [];
  const loc = { hash: "#enroll=abc", pathname: "/app/", search: "" };
  expect(readEnrollFragment(loc, (u) => replaced.push(u))).toBe("abc");
  expect(replaced).toEqual(["/app/"]);
  expect(readEnrollFragment({ ...loc, hash: "#other" }, (u) => replaced.push(u))).toBeNull();
  expect(replaced).toHaveLength(1);
});

test("enrollment refuses a server that is not this app's own origin (QR swap)", async () => {
  await expect(enrollDevice(payload(), "https://other.example", 1)).rejects.toThrow();
  expect(await getConfig()).toBeUndefined();
});

test("stores only non-extractable keys and non-secret config; the raw secret is nowhere in IndexedDB", async () => {
  const p = payload();
  const secretBytes = Buffer.from(p.deviceSecretB64u, "base64url");
  await enrollDevice(p, ORIGIN, 1234);

  const config = await getConfig();
  expect(config).toEqual({ deviceId: p.deviceId, baseUrl: ORIGIN, minXof: 50, maxXof: 100_000, label: "Boutique Awa", sandbox: true, saleWindowMin: 15, enrolledAt: 1234 });
  const keys = (await getKeys())!;
  for (const k of [keys.enc, keys.code, keys.auth]) {
    expect(k.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", k)).rejects.toThrow();
  }

  // Dump every record the app stored and look for the secret in all common encodings.
  const db = await new Promise<IDBDatabase>((r) => {
    const o = indexedDB.open("jaay-pos");
    o.onsuccess = () => r(o.result);
  });
  const dump: string[] = [];
  for (const store of Array.from(db.objectStoreNames)) {
    const all = await new Promise<unknown[]>((r) => {
      const q = db.transaction(store).objectStore(store).getAll();
      q.onsuccess = () => r(q.result);
    });
    for (const v of all) dump.push(JSON.stringify(v, (_k, x) => (x instanceof CryptoKey ? `CryptoKey(${x.algorithm.name},extractable=${x.extractable})` : x)));
  }
  const text = dump.join("\n");
  const forms = [
    p.deviceSecretB64u,
    Buffer.from(secretBytes).toString("base64"),
    Buffer.from(secretBytes).toString("hex"),
    Buffer.from(secretBytes).toString("latin1"),
    Array.from(secretBytes).join(","),
  ];
  for (const f of forms) expect(text.includes(f)).toBe(false);
  expect(text).toContain("extractable=false");

  // And the stored keys still do the job: seal, open, and derive the same confirm code.
  const s = await encodeSale(keys, p.deviceId, { amountXof: 500 });
  expect((await decodeSale(s.token, keys)).amountXof).toBe(500);
  expect(await deriveConfirmCode(keys, s.sid)).toMatch(/^\d{6}$/);
});
