import { b64uDecode, b64uEncode } from "./base64url";
import { DEVICE_ID_BYTES, DEVICE_SECRET_BYTES } from "./constants";

export interface DeviceKeys {
  /** AES-256-GCM key for sale payloads. */
  enc: CryptoKey;
  /** HMAC-SHA256 key for confirm codes (D1). */
  code: CryptoKey;
  /** HMAC-SHA256 key reserved for M2 request signing. */
  auth: CryptoKey;
}

const utf8 = new TextEncoder();
const SALT = utf8.encode("jaay/v1/salt");

export function generateDeviceSecret(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(DEVICE_SECRET_BYTES));
}

export function secretToString(secret: Uint8Array): string {
  return b64uEncode(secret);
}

export function secretFromString(text: string): Uint8Array<ArrayBuffer> {
  const bytes = b64uDecode(text);
  if (bytes.length !== DEVICE_SECRET_BYTES) throw new Error("invalid secret");
  return bytes;
}

/** 16 random bytes as 22 base64url characters. */
export function newDeviceId(): string {
  return b64uEncode(crypto.getRandomValues(new Uint8Array(DEVICE_ID_BYTES)));
}

/** D2: HKDF-SHA256 key schedule. Every derived key is non-extractable. */
export async function deriveKeys(secret: Uint8Array): Promise<DeviceKeys> {
  if (
    !(secret instanceof Uint8Array) ||
    secret.length !== DEVICE_SECRET_BYTES
  ) {
    throw new Error("invalid secret");
  }
  const ikm = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  const hkdf = (info: string) => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: SALT,
    info: utf8.encode(info),
  });
  const hmac = { name: "HMAC", hash: "SHA-256", length: 256 };
  const [enc, code, auth] = await Promise.all([
    crypto.subtle.deriveKey(
      hkdf("jaay/v1/enc"),
      ikm,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    ),
    crypto.subtle.deriveKey(hkdf("jaay/v1/code"), ikm, hmac, false, ["sign"]),
    crypto.subtle.deriveKey(hkdf("jaay/v1/auth"), ikm, hmac, false, [
      "sign",
      "verify",
    ]),
  ]);
  return { enc, code, auth };
}
