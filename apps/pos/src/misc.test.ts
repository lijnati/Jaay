import { readdirSync, readFileSync } from "node:fs";
import { deriveKeys, generateDeviceSecret } from "@jaay/protocol";
import { expect, test } from "vitest";
import { canonicalRequest } from "../../server/src/deviceauth";
import { signedHeaders } from "./auth";
import { CATALOG } from "./i18n";
import { formatXof } from "./money";

test("money: XOF with thin grouping and F, tabular-friendly, integers only", () => {
  const nb = " ";
  expect(formatXof(5000)).toBe(`5${nb}000${nb}F`);
  expect(formatXof(50)).toBe(`50${nb}F`);
  expect(formatXof(1234567)).toBe(`1${nb}234${nb}567${nb}F`);
  expect(formatXof(0)).toBe(`0${nb}F`);
  expect(() => formatXof(1.5)).toThrow();
});

test("i18n: every English key exists in French, nothing empty, same placeholders", () => {
  const en = CATALOG.en;
  const fr = CATALOG.fr;
  expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
  const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");
  for (const k of Object.keys(en) as (keyof typeof en)[]) {
    expect(en[k].trim().length, k).toBeGreaterThan(0);
    expect(fr[k].trim().length, k).toBeGreaterThan(0);
    expect(ph(fr[k]), k).toBe(ph(en[k]));
  }
});

test("request signing matches the server's canonical string and verifies under the auth key", async () => {
  const keys = await deriveKeys(generateDeviceSecret());
  const body = JSON.stringify({ sales: [] });
  const h = await signedHeaders(keys.auth, "QEFCQ0RFRkdISUpLTE1OTw", "/v1/sales/reconcile", body, 1_794_600_000_000);
  const canonical = canonicalRequest("POST", "/v1/sales/reconcile", h["x-jaay-device"], h["x-jaay-ts"], h["x-jaay-nonce"], new TextEncoder().encode(body));
  const ok = await crypto.subtle.verify("HMAC", keys.auth, Buffer.from(h["x-jaay-sig"], "base64url"), new TextEncoder().encode(canonical));
  expect(ok).toBe(true);
  expect(h["x-jaay-nonce"]).toMatch(/^[A-Za-z0-9_-]{22}$/);
});

test("no console logging anywhere in the PWA source (tokens, codes, amounts, keys never reach a log)", () => {
  const dir = new URL("./", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "test-setup.ts");
  expect(files.length).toBeGreaterThan(5);
  for (const f of files) expect(readFileSync(new URL(f, dir), "utf8"), f).not.toMatch(/\bconsole\s*\./);
});

test("i18n: no hard-coded user-visible text in the PWA or the simulator; only the wordmark is literal", () => {
  for (const f of ["./main.ts", "../../customer-sim/src/main.ts"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    const literals = [...src.matchAll(/\btext: (["'`])((?:(?!\1).)*)\1/g)].map((m) => m[2]!).filter((s) => !s.includes("${"));
    expect(literals.filter((s) => s !== "jaay" && s !== "jaay sim"), f).toEqual([]);
  }
});
