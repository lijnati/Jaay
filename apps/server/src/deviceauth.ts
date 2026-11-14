// A1: device-authenticated requests from the merchant PWA.
// Headers: X-Jaay-Device (device id), X-Jaay-Ts (unix ms), X-Jaay-Nonce (16 random bytes, base64url),
// X-Jaay-Sig = base64url(HMAC-SHA256(authKey, canonical)), where canonical is the newline-joined list
//   "jaay-auth-v1", METHOD, path, deviceId, ts, nonce, hex(sha256(body bytes)).
// Any failure returns null; the caller answers with one generic 401 (Hard rule 7).
import { createHash, timingSafeEqual } from "node:crypto";
import type { Repo, DeviceRow } from "./repo";
import type { SaleService } from "./sales";

export const AUTH_WINDOW_MS = 120_000;
const B64U = (n: number) => new RegExp(`^[A-Za-z0-9_-]{${n}}$`);
const ID_RE = B64U(22);
const NONCE_RE = B64U(22);
const SIG_RE = B64U(43);

export function canonicalRequest(method: string, path: string, deviceId: string, ts: string, nonce: string, body: Uint8Array): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return ["jaay-auth-v1", method.toUpperCase(), path, deviceId, ts, nonce, bodyHash].join("\n");
}

export interface AuthInput {
  method: string;
  path: string;
  header: (name: string) => string | undefined;
  body: Uint8Array;
}

export async function verifyDeviceRequest(req: AuthInput, d: { repo: Repo; sales: SaleService; now: () => number }): Promise<DeviceRow | null> {
  const deviceId = req.header("x-jaay-device") ?? "";
  const ts = req.header("x-jaay-ts") ?? "";
  const nonce = req.header("x-jaay-nonce") ?? "";
  const sig = req.header("x-jaay-sig") ?? "";
  if (!ID_RE.test(deviceId) || !/^\d{1,16}$/.test(ts) || !NONCE_RE.test(nonce) || !SIG_RE.test(sig)) return null;
  const now = d.now();
  const t = Number(ts);
  if (Math.abs(now - t) > AUTH_WINDOW_MS) return null;

  const device = d.repo.getDevice(deviceId);
  const keys = await d.sales.keysOrDecoy(device);
  const data = new TextEncoder().encode(canonicalRequest(req.method, req.path, deviceId, ts, nonce, req.body));
  const expected = Buffer.from(await crypto.subtle.sign("HMAC", keys.auth, data));
  const given = Buffer.from(sig, "base64url");
  const ok = given.length === expected.length && timingSafeEqual(given, expected);
  if (!ok || !device) return null;
  // Only a valid MAC may consume a nonce, so nobody can burn a device's nonces.
  if (!d.repo.useNonce(device.id, nonce, t + AUTH_WINDOW_MS, now)) return null;
  return device;
}
