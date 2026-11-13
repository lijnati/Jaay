import { b64uDecode } from "./base64url";
import { CONFIRM_CODE_DIGITS, SID_BYTES } from "./constants";
import type { DeviceKeys } from "./keys";

const MODULUS = 10n ** BigInt(CONFIRM_CODE_DIGITS);

/**
 * D1: code = uint64be(HMAC-SHA256(codeKey, sid)[0..8]) mod 10^6, zero padded.
 * The modulo bias (2^64 mod 10^6 over 2^64) is below 1e-13, so digits are uniform for practical purposes.
 */
export async function deriveConfirmCode(
  keys: DeviceKeys,
  sid: string,
): Promise<string> {
  const sidBytes = b64uDecode(sid);
  if (sidBytes.length !== SID_BYTES) throw new Error("invalid sid");
  const mac = await crypto.subtle.sign("HMAC", keys.code, sidBytes);
  const n = new DataView(mac).getBigUint64(0) % MODULUS;
  return n.toString().padStart(CONFIRM_CODE_DIGITS, "0");
}

/**
 * Compares two strings without an early exit on the first difference.
 * Best effort only: JavaScript engines give no hard timing guarantee (D6).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++)
    diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return diff === 0;
}

/** Recomputes the code from sid and compares. Never throws; any bad input is just false. */
export async function verifyConfirmCode(
  keys: DeviceKeys,
  sid: string,
  entered: string,
): Promise<boolean> {
  if (typeof entered !== "string") return false;
  let expected: string;
  try {
    expected = await deriveConfirmCode(keys, sid);
  } catch {
    return false;
  }
  return constantTimeEqual(expected, entered);
}
