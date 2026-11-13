import { bech32 } from "bech32";
import { describe, expect, test } from "vitest";
import { buildSaleLnurl, lnurlDecode, lnurlEncode, toQrString } from "./lnurl";

// Example from LUD-01 (github.com/lnurl/luds/blob/luds/01.md).
const LUD01_LNURL =
  "LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS";
const LUD01_URL =
  "https://service.com/api?q=3fc3645b439ce8e7f2553a69e5267081d96dcd340693afabe04be7b0ccd178df";

const URL_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~/?=&%";

function randomUrl(): string {
  const n = 1 + Math.floor(Math.random() * 300);
  let path = "";
  for (let i = 0; i < n; i++)
    path += URL_CHARS[Math.floor(Math.random() * URL_CHARS.length)];
  return `https://h${Math.floor(Math.random() * 1e6)}.example/${path}`;
}

const oracleEncode = (url: string) =>
  bech32.encode("lnurl", bech32.toWords(new TextEncoder().encode(url)), 2000);

/** Replace one data character with a different valid bech32 character. */
function corrupt(lnurl: string, index: number): string {
  const c = lnurl[index] === "q" ? "p" : "q";
  return lnurl.slice(0, index) + c + lnurl.slice(index + 1);
}

describe("lnurl bech32", () => {
  test("decodes the LUD-01 example vector", () => {
    expect(lnurlDecode(LUD01_LNURL)).toBe(LUD01_URL);
  });

  test("encodes the LUD-01 example vector", () => {
    expect(lnurlEncode(LUD01_URL)).toBe(LUD01_LNURL.toLowerCase());
  });

  test("matches the bech32 npm oracle over 300 random URLs", () => {
    for (let i = 0; i < 300; i++) {
      const url = randomUrl();
      const ours = lnurlEncode(url);
      expect(ours).toBe(oracleEncode(url));
      expect(lnurlDecode(ours)).toBe(url);
      const back = bech32.decode(ours, 2000);
      expect(
        new TextDecoder().decode(new Uint8Array(bech32.fromWords(back.words))),
      ).toBe(url);
    }
  });

  test("round trips and accepts all uppercase", () => {
    const url = "https://pay.example.sn/lnurlp?p=abc";
    const lnurl = lnurlEncode(url);
    expect(lnurlDecode(lnurl)).toBe(url);
    expect(lnurlDecode(lnurl.toUpperCase())).toBe(url);
  });

  test("rejects mixed case", () => {
    const lnurl = lnurlEncode("https://pay.example.sn/x");
    expect(() =>
      lnurlDecode(lnurl.slice(0, 10) + lnurl.slice(10).toUpperCase()),
    ).toThrow();
    expect(() => lnurlDecode("LNURL" + lnurl.slice(5))).toThrow();
  });

  test("rejects a checksum failure at every data position", () => {
    const lnurl = lnurlEncode("https://pay.example.sn/lnurlp?p=abc");
    for (let i = 6; i < lnurl.length; i++) {
      expect(() => lnurlDecode(corrupt(lnurl, i))).toThrow();
    }
  });

  test("rejects a wrong hrp even with a valid checksum", () => {
    const words = bech32.toWords(
      new TextEncoder().encode("https://a.example/"),
    );
    expect(() => lnurlDecode(bech32.encode("lnbc", words, 2000))).toThrow();
    expect(() => lnurlDecode(bech32.encode("lnurlx", words, 2000))).toThrow();
  });

  test.each([
    "",
    "lnurl1",
    "lnurl1qqqqqq",
    "lnurl1b2345678",
    "noseparator",
    "lnurl1 qqqqqqqq",
  ])("rejects malformed input %j", (bad) => {
    expect(() => lnurlDecode(bad)).toThrow();
  });

  test("rejects non-zero padding bits even with a valid checksum", () => {
    // 1 byte payload needs 2 words; the second word must have its low 2 bits clear.
    const bad = bech32.encode("lnurl", [12, 1], 2000);
    expect(() => lnurlDecode(bad)).toThrow();
  });
});

describe("sale lnurl", () => {
  const token = "A".repeat(78);

  test("builds the D4 target and QR string", () => {
    const lnurl = buildSaleLnurl("https://pay.example.sn", token);
    expect(lnurlDecode(lnurl)).toBe(`https://pay.example.sn/lnurlp?p=${token}`);
    expect(toQrString(lnurl)).toBe("LIGHTNING:" + lnurl.toUpperCase());
  });

  test("tolerates one trailing slash and a path prefix", () => {
    expect(
      lnurlDecode(buildSaleLnurl("https://pay.example.sn/jaay/", token)),
    ).toBe(`https://pay.example.sn/jaay/lnurlp?p=${token}`);
  });

  test("allows http only for localhost and onion hosts", () => {
    expect(() => buildSaleLnurl("http://localhost:8080", token)).not.toThrow();
    expect(() => buildSaleLnurl("http://abc.onion", token)).not.toThrow();
    expect(() => buildSaleLnurl("http://pay.example.sn", token)).toThrow();
  });

  test.each([
    "ftp://pay.example.sn",
    "https://pay.example.sn?x=1",
    "https://pay.example.sn#x",
    "not a url",
  ])("rejects base url %j", (base) => {
    expect(() => buildSaleLnurl(base, token)).toThrow();
  });

  test("rejects a token with characters outside base64url or over 256 chars", () => {
    expect(() => buildSaleLnurl("https://pay.example.sn", "abc&x=1")).toThrow();
    expect(() =>
      buildSaleLnurl("https://pay.example.sn", "A".repeat(257)),
    ).toThrow();
  });
});
