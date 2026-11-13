import { MAX_TOKEN_CHARS } from "./constants";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const HRP = "lnurl";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]!;
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function toWords(bytes: Uint8Array): number[] {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >> bits) & 31);
    }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}

function fromWords(words: number[]): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const w of words) {
    acc = ((acc << 5) | w) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  // Leftover must be under one byte and all zero, so each payload has one encoding.
  if (bits >= 5 || (acc & ((1 << bits) - 1)) !== 0)
    throw new Error("invalid lnurl");
  return new Uint8Array(out);
}

/** Bech32-encode a URL with hrp "lnurl" (LUD-01). Returns lowercase. No 90-char limit. */
export function lnurlEncode(url: string): string {
  const words = toWords(new TextEncoder().encode(url));
  const mod = polymod([...hrpExpand(HRP), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  let out = HRP + "1";
  for (const w of words) out += CHARSET[w];
  for (let i = 0; i < 6; i++) out += CHARSET[(mod >>> (5 * (5 - i))) & 31];
  return out;
}

/** Decode an LNURL. Accepts all lowercase or all uppercase; rejects mixed case, bad checksum, wrong hrp. */
export function lnurlDecode(lnurl: string): string {
  if (typeof lnurl !== "string") throw new Error("invalid lnurl");
  const lower = lnurl.toLowerCase();
  if (lnurl !== lower && lnurl !== lnurl.toUpperCase())
    throw new Error("invalid lnurl");
  const sep = lower.lastIndexOf("1");
  if (lower.slice(0, sep) !== HRP || lower.length - sep - 1 < 6)
    throw new Error("invalid lnurl");
  const values: number[] = [];
  for (let i = sep + 1; i < lower.length; i++) {
    const v = CHARSET.indexOf(lower[i]!);
    if (v < 0) throw new Error("invalid lnurl");
    values.push(v);
  }
  if (polymod([...hrpExpand(HRP), ...values]) !== 1)
    throw new Error("invalid lnurl");
  return new TextDecoder("utf-8", { fatal: true }).decode(
    fromWords(values.slice(0, -6)),
  );
}

const TOKEN_RE = /^[A-Za-z0-9_-]+$/;

/**
 * LNURL for a sale: GET {baseUrl}/lnurlp?p={token} (D4).
 * baseUrl must be https, or http for localhost and .onion (LUD-01), with no query or fragment.
 * shortcut: baseUrl is not authenticated by the token (D6), M3 shows the host on screen.
 */
export function buildSaleLnurl(baseUrl: string, token: string): string {
  if (token.length > MAX_TOKEN_CHARS || !TOKEN_RE.test(token))
    throw new Error("invalid token");
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error("invalid base url");
  }
  const host = u.hostname;
  const localHttp =
    host === "localhost" || host === "127.0.0.1" || host.endsWith(".onion");
  const okScheme =
    u.protocol === "https:" || (u.protocol === "http:" && localHttp);
  if (
    !okScheme ||
    u.search ||
    u.hash ||
    baseUrl.includes("?") ||
    baseUrl.includes("#")
  ) {
    throw new Error("invalid base url");
  }
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return lnurlEncode(`${base}/lnurlp?p=${token}`);
}

/** QR content: uppercase so the QR can use alphanumeric mode. */
export function toQrString(lnurl: string): string {
  return "LIGHTNING:" + lnurl.toUpperCase();
}
