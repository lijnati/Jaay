import { createHash } from "node:crypto";
import { lnurlEncode } from "@jaay/protocol";
import { describe, expect, test } from "vitest";
import { fetchPayRequest, invoiceSummary, parseInput, requestInvoice, successLink, WalletError } from "./wallet";

const TARGET = "https://pay.example.sn/lnurlp?p=AbCd";
const LNURL = lnurlEncode(TARGET);
const META = JSON.stringify([["text/plain", "[SANDBOX] Jaay: 2500 XOF. Recu / receipt: https://pay.example.sn/r/AAAAAAAAAAAAAAAAAAAAAA"]]);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchOf = (body: unknown, status = 200) => (async () => json(body, status)) as unknown as typeof fetch;

describe("input decoding (LUD-01 via packages/protocol)", () => {
  test.each([
    [LNURL, TARGET],
    [LNURL.toUpperCase(), TARGET],
    [`LIGHTNING:${LNURL.toUpperCase()}`, TARGET],
    [`lightning:${LNURL}`, TARGET],
    [`  ${LNURL}\n`, TARGET],
  ])("accepts %s", (input, want) => {
    expect(parseInput(input).toString()).toBe(want);
  });

  test.each([
    ["", "empty"],
    ["hello", "not an LNURL"],
    [`${LNURL.slice(0, -1)}q`, "bad checksum"],
    [LNURL.slice(0, 10) + LNURL.slice(10).toUpperCase(), "mixed case"],
    [lnurlEncode("http://pay.example.sn/lnurlp?p=x"), "http on a public host"],
    [lnurlEncode("ftp://pay.example.sn/x"), "not http(s)"],
    [lnurlEncode("javascript:alert(1)"), "javascript scheme"],
  ])("rejects %s (%s)", (input) => {
    expect(() => parseInput(input)).toThrow(WalletError);
  });

  test("http is accepted only for localhost and 127.0.0.1", () => {
    expect(parseInput(lnurlEncode("http://localhost:8787/lnurlp?p=x")).host).toBe("localhost:8787");
    expect(parseInput(lnurlEncode("http://127.0.0.1:8787/lnurlp?p=x")).host).toBe("127.0.0.1:8787");
    expect(() => parseInput(lnurlEncode("http://192.168.1.10/lnurlp?p=x"))).toThrow(WalletError);
  });
});

describe("payRequest", () => {
  const good = { tag: "payRequest", callback: "https://pay.example.sn/lnurlp/cb?p=AbCd", minSendable: 6_250_000, maxSendable: 6_250_000, metadata: META, commentAllowed: 0 };

  test("reads amount, description, XOF from the description, and the fallback receipt URL", async () => {
    const p = await fetchPayRequest(fetchOf(good), new URL(TARGET));
    expect(p).toMatchObject({ amountMsat: 6_250_000, xof: "2500 XOF", receiptUrl: "https://pay.example.sn/r/AAAAAAAAAAAAAAAAAAAAAA" });
    expect(p.description).toContain("[SANDBOX] Jaay");
    expect(p.callback.toString()).toBe(good.callback);
  });

  test.each([
    ["min differs from max", { ...good, maxSendable: 7_000_000 }],
    ["wrong tag", { ...good, tag: "withdrawRequest" }],
    ["no text/plain", { ...good, metadata: JSON.stringify([["image/png;base64", "x"]]) }],
    ["empty description", { ...good, metadata: JSON.stringify([["text/plain", ""]]) }],
    ["metadata not JSON", { ...good, metadata: "nope" }],
    ["http callback on a public host", { ...good, callback: "http://pay.example.sn/cb" }],
    ["non-integer amount", { ...good, minSendable: 1.5, maxSendable: 1.5 }],
  ])("refuses a payRequest with %s", async (_n, body) => {
    await expect(fetchPayRequest(fetchOf(body), new URL(TARGET))).rejects.toThrow(WalletError);
  });

  test("an LNURL error body shows its reason and nothing else", async () => {
    const err = await fetchPayRequest(fetchOf({ status: "ERROR", reason: "Invalid or expired sale", extra: "secret detail" }, 400), new URL(TARGET)).catch((e: Error) => e);
    expect(err).toBeInstanceOf(WalletError);
    expect((err as Error).message).toBe("Invalid or expired sale");
    const odd = await fetchPayRequest(fetchOf({ status: "ERROR", reason: { html: "<b>x</b>" } }, 400), new URL(TARGET)).catch((e: Error) => e);
    expect((odd as Error).message).toBe("Error");
    const net = await fetchPayRequest((async () => Promise.reject(new TypeError("Failed to fetch http://internal"))) as unknown as typeof fetch, new URL(TARGET)).catch((e: Error) => e);
    expect((net as Error).message).toBe("Error");
  });
});

describe("callback and invoice", () => {
  const pay = { callback: new URL("https://pay.example.sn/lnurlp/cb?p=AbCd"), amountMsat: 6_250_000, metadata: META, description: "", xof: null, receiptUrl: null, raw: {} };

  test("calls the callback with the exact amount and returns the invoice", async () => {
    let called = "";
    const f = (async (u: string) => {
      called = u;
      return json({ pr: "lnbcrt1x", routes: [], successAction: { tag: "url", url: "https://pay.example.sn/r/x", description: "Recu" } });
    }) as unknown as typeof fetch;
    const r = await requestInvoice(f, pay);
    expect(called).toBe("https://pay.example.sn/lnurlp/cb?p=AbCd&amount=6250000");
    expect(r.pr).toBe("lnbcrt1x");
  });

  test("callback error shows only the reason", async () => {
    await expect(requestInvoice(fetchOf({ status: "ERROR", reason: "Invalid or expired sale" }, 400), pay)).rejects.toThrow("Invalid or expired sale");
  });

  test("invoice summary checks description_hash against the metadata (LUD-06)", async () => {
    const pr = encodeTestInvoice(6_250_000n, createHash("sha256").update(META).digest("hex"));
    const s = await invoiceSummary(pr, META);
    expect(s).toMatchObject({ network: "bcrt", msat: "6250000", descriptionHashOk: true });
    expect(s.paymentHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await invoiceSummary(pr, `${META} `)).descriptionHashOk).toBe(false);
    await expect(invoiceSummary("lnbc1garbage", META)).rejects.toThrow(WalletError);
  });
});

describe("success action link (Phoenix rule)", () => {
  const cb = new URL("https://pay.example.sn/lnurlp/cb?p=x");
  test("a url action on the callback host is a link", () => {
    expect(successLink({ tag: "url", url: "https://pay.example.sn/r/abc", description: "Recu" }, cb)).toEqual({ description: "Recu", url: "https://pay.example.sn/r/abc" });
  });
  test.each([
    ["another host", { tag: "url", url: "https://evil.example/r/abc", description: "Recu" }],
    ["a subdomain", { tag: "url", url: "https://x.pay.example.sn/r/abc", description: "Recu" }],
    ["javascript", { tag: "url", url: "javascript:alert(1)", description: "Recu" }],
    ["not a url", { tag: "url", url: "nope", description: "Recu" }],
  ])("on %s only the description is shown", (_n, a) => {
    expect(successLink(a, cb)).toEqual({ description: "Recu", url: null });
  });
  test("message and missing actions", () => {
    expect(successLink({ tag: "message", message: "Merci" }, cb)).toEqual({ description: "Merci", url: null });
    expect(successLink(undefined, cb)).toBeNull();
  });
});

// Minimal BOLT11 for tests (same layout as the server's sandbox encoder; zero signature).
function encodeTestInvoice(msat: bigint, descHash: string): string {
  const CH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const words = (b: Uint8Array) => {
    const o: number[] = [];
    let a = 0;
    let n = 0;
    for (const x of b) {
      a = (a << 8) | x;
      n += 8;
      while (n >= 5) o.push((a >>> (n -= 5)) & 31);
    }
    if (n) o.push((a << (5 - n)) & 31);
    return o;
  };
  const int = (v: number, len: number) => Array.from({ length: len }, (_, i) => Math.floor(v / 32 ** (len - 1 - i)) % 32);
  const tag = (t: number, w: number[]) => [t, ...int(w.length, 2), ...w];
  const hrp = `lnbcrt${(msat / 1000n) * 10n}n`;
  const data = [...int(1_800_000_000, 7), ...tag(1, words(new Uint8Array(32).fill(7))), ...tag(23, words(Buffer.from(descHash, "hex"))), ...tag(6, int(600, 2)), ...words(new Uint8Array(65))];
  const exp = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  let chk = 1;
  for (const v of [...exp, ...data, 0, 0, 0, 0, 0, 0]) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]!;
  }
  chk ^= 1;
  const sum = Array.from({ length: 6 }, (_, i) => (chk >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...sum].map((w) => CH[w]).join("")}`;
}
