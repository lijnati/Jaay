// A5: BOLT11 checks on every invoice a backend returns, plus a minimal encoder for the SANDBOX backend and tests.
// Decoding uses light-bolt11-decoder (decode only, one audited dependency, exercised against real Alby Hub
// invoices in spike S1). The signature is not verified: the invoice comes from the merchant's own wallet;
// what matters is that it pays the amount and commits to the metadata Jaay quoted.
import { decode } from "light-bolt11-decoder";

export type Network = "regtest" | "signet" | "testnet";
export const NETWORK_PREFIX: Record<Network, string> = { regtest: "bcrt", signet: "tbs", testnet: "tb" };

export interface InvoiceExpectation {
  network: Network;
  msat: bigint;
  paymentHash: string;
  descriptionHashHex: string;
  /** Server time, ms. */
  now: number;
}

/** True only if the invoice decodes and matches network, amount, payment hash and description hash, and is unexpired. */
export function invoiceMatches(pr: string, e: InvoiceExpectation): boolean {
  try {
    const d = decode(pr);
    const sec = (name: string) => d.sections.find((s) => s.name === name) as { letters?: string; value?: unknown } | undefined;
    if (sec("coin_network")?.letters !== NETWORK_PREFIX[e.network]) return false;
    if (sec("amount")?.value !== String(e.msat)) return false;
    if (sec("payment_hash")?.value !== e.paymentHash) return false;
    if (sec("description_hash")?.value !== e.descriptionHashHex) return false;
    const ts = sec("timestamp")?.value;
    if (typeof ts !== "number" || typeof d.expiry !== "number") return false;
    return (ts + d.expiry) * 1000 > e.now;
  } catch {
    return false;
  }
}

// ---------- encoder (SANDBOX and tests only; the signature is 65 zero bytes, so no wallet will pay it) ----------
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
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

function checksum(hrp: string, data: number[]): number[] {
  const expand = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  const mod = polymod([...expand, ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  return Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
}

function toWords(bytes: Uint8Array): number[] {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >>> bits) & 31);
    }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}

function intWords(n: number, len?: number): number[] {
  const out: number[] = [];
  do {
    out.unshift(n & 31);
    n = Math.floor(n / 32);
  } while (n > 0);
  while (len !== undefined && out.length < len) out.unshift(0);
  return out;
}

const tagged = (type: number, words: number[]) => [type, ...intWords(words.length, 2), ...words];
const hexWords = (hex: string) => toWords(Buffer.from(hex, "hex"));

export function encodeBolt11(i: {
  network: Network;
  msat: bigint;
  paymentHash: string;
  descriptionHash: string | null;
  timestampSec: number;
  expirySec: number;
}): string {
  // Whole sats as nano-BTC (1 sat = 10 n), otherwise pico-BTC (1 msat = 10 p).
  const amount = i.msat % 1000n === 0n ? `${(i.msat / 1000n) * 10n}n` : `${i.msat * 10n}p`;
  const hrp = `ln${NETWORK_PREFIX[i.network]}${amount}`;
  const data = [
    ...intWords(i.timestampSec, 7),
    ...tagged(1, hexWords(i.paymentHash)),
    ...(i.descriptionHash ? tagged(23, hexWords(i.descriptionHash)) : []),
    ...tagged(6, intWords(i.expirySec)),
    ...toWords(new Uint8Array(65)),
  ];
  return `${hrp}1${[...data, ...checksum(hrp, data)].map((w) => CHARSET[w]).join("")}`;
}
