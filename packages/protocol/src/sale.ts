import { b64uDecode, b64uEncode } from "./base64url";
import {
  AMOUNT_FIELD_MAX,
  CURRENCY_XOF,
  DEVICE_ID_BYTES,
  IV_BYTES,
  MAX_AMOUNT_XOF,
  MAX_TOKEN_CHARS,
  MIN_AMOUNT_XOF,
  PLAINTEXT_BYTES,
  PROTOCOL_VERSION,
  SID_BYTES,
  TOKEN_BYTES,
} from "./constants";
import type { DeviceKeys } from "./keys";

export interface LimitOptions {
  minAmountXof?: number;
  maxAmountXof?: number;
}

export interface Sale {
  deviceId: string;
  amountXof: number;
  sid: string;
}

/** The only error decodeSale throws. One constant message, no detail about which check failed (Hard rule 7). */
export class DecodeError extends Error {
  constructor() {
    super("invalid sale token");
  }
}
// On the prototype, so instances carry no own fields at all.
DecodeError.prototype.name = "DecodeError";

const HEADER_BYTES = 1 + DEVICE_ID_BYTES;

function limits(opts: LimitOptions = {}): { min: number; max: number } {
  const min = opts.minAmountXof ?? MIN_AMOUNT_XOF;
  const max = opts.maxAmountXof ?? MAX_AMOUNT_XOF;
  if (
    !Number.isInteger(min) ||
    !Number.isInteger(max) ||
    min < 1 ||
    min > max ||
    max > AMOUNT_FIELD_MAX
  ) {
    throw new RangeError("invalid amount limits");
  }
  return { min, max };
}

function deviceIdBytes(deviceId: string): Uint8Array<ArrayBuffer> {
  const bytes = b64uDecode(deviceId);
  if (bytes.length !== DEVICE_ID_BYTES) throw new Error("invalid device id");
  return bytes;
}

/** D3: version | deviceId | iv | AES-256-GCM(amount u32be | sid | currency) with AAD version | deviceId. */
export async function encodeSale(
  keys: DeviceKeys,
  deviceId: string,
  sale: { amountXof: number },
  opts?: LimitOptions,
): Promise<{ token: string; sid: string }> {
  const { min, max } = limits(opts);
  const amount = sale.amountXof;
  if (!Number.isInteger(amount) || amount < min || amount > max) {
    throw new RangeError("amount out of range");
  }
  const header = new Uint8Array(HEADER_BYTES);
  header[0] = PROTOCOL_VERSION;
  header.set(deviceIdBytes(deviceId), 1);

  const sid = crypto.getRandomValues(new Uint8Array(SID_BYTES));
  const plaintext = new Uint8Array(PLAINTEXT_BYTES);
  new DataView(plaintext.buffer).setUint32(0, amount);
  plaintext.set(sid, 4);
  plaintext[4 + SID_BYTES] = CURRENCY_XOF;

  // Hard rule 6: fresh random 96-bit IV per payload, never a counter.
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: header },
      keys.enc,
      plaintext,
    ),
  );

  const out = new Uint8Array(TOKEN_BYTES);
  out.set(header, 0);
  out.set(iv, HEADER_BYTES);
  out.set(sealed, HEADER_BYTES + IV_BYTES);
  return { token: b64uEncode(out), sid: b64uEncode(sid) };
}

function parseHeader(token: unknown): Uint8Array<ArrayBuffer> {
  if (typeof token !== "string" || token.length > MAX_TOKEN_CHARS)
    throw new Error("bad");
  const bytes = b64uDecode(token);
  if (bytes.length !== TOKEN_BYTES || bytes[0] !== PROTOCOL_VERSION)
    throw new Error("bad");
  return bytes;
}

/**
 * Unauthenticated: returns the device id only so the caller can look up that device's keys.
 * Never trust it until decodeSale succeeds with those keys.
 */
export function peekDeviceId(token: string): string | null {
  try {
    return b64uEncode(parseHeader(token).subarray(1, HEADER_BYTES));
  } catch {
    return null;
  }
}

/** Opens a sale token. Throws DecodeError on any failure (fail closed). */
export async function decodeSale(
  token: string,
  keys: DeviceKeys,
  opts?: LimitOptions,
): Promise<Sale> {
  const { min, max } = limits(opts);
  try {
    const bytes = parseHeader(token);
    const header = bytes.subarray(0, HEADER_BYTES);
    const iv = bytes.subarray(HEADER_BYTES, HEADER_BYTES + IV_BYTES);
    const sealed = bytes.subarray(HEADER_BYTES + IV_BYTES);
    const pt = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: header },
        keys.enc,
        sealed,
      ),
    );
    if (pt.length !== PLAINTEXT_BYTES || pt[4 + SID_BYTES] !== CURRENCY_XOF)
      throw new Error("bad");
    const amountXof = new DataView(pt.buffer).getUint32(0);
    if (amountXof < min || amountXof > max) throw new Error("bad");
    return {
      deviceId: b64uEncode(header.subarray(1)),
      amountXof,
      sid: b64uEncode(pt.subarray(4, 4 + SID_BYTES)),
    };
  } catch {
    throw new DecodeError();
  }
}
