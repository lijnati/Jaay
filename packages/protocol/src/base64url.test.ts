import { describe, expect, test } from "vitest";
import { b64uDecode, b64uEncode } from "./base64url";

const vectors: [number[], string][] = [
  [[], ""],
  [[0x66], "Zg"],
  [[0x66, 0x6f], "Zm8"],
  [[0x66, 0x6f, 0x6f], "Zm9v"],
  [[0xfb, 0xff], "-_8"],
  [[0xff, 0xff, 0xff], "____"],
];

describe("base64url", () => {
  test("encodes and decodes known vectors", () => {
    for (const [bytes, text] of vectors) {
      expect(b64uEncode(new Uint8Array(bytes))).toBe(text);
      expect(Array.from(b64uDecode(text))).toEqual(bytes);
    }
  });

  test("round trips random bytes of every length up to 100", () => {
    for (let n = 0; n <= 100; n++) {
      const bytes = crypto.getRandomValues(new Uint8Array(n));
      expect(b64uDecode(b64uEncode(bytes))).toEqual(bytes);
    }
  });

  test.each([
    "Zg==",
    "Zm8=",
    "Zm 9v",
    " Zm9v",
    "Zm9v\n",
    "Zm+v",
    "Zm/v",
    "Zm9v!",
    "Z",
    "Zm9vZ",
    "Zm9é",
  ])("rejects %j", (bad) => {
    expect(() => b64uDecode(bad)).toThrow();
  });

  test("rejects non-canonical trailing bits", () => {
    expect(() => b64uDecode("Zh")).toThrow(); // "Zg" is canonical for 0x66
    expect(() => b64uDecode("Zm9")).toThrow(); // "Zm8" is canonical for 0x66 0x6f
  });
});
