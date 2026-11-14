// Enrollment. The payload carries the raw device secret once. We derive the three keys as NON-EXTRACTABLE
// CryptoKeys, store only those and the non-secret config, and zero the secret bytes. The secret string itself
// cannot be wiped from JS memory; we drop every reference to it and never write it anywhere.
import { buildSaleLnurl, deriveKeys, secretFromString } from "@jaay/protocol";
import { putConfig, putKeys, type DeviceConfig } from "./db";

export interface EnrollPayload {
  deviceId: string;
  deviceSecretB64u: string;
  baseUrl: string;
  minXof: number;
  maxXof: number;
  label: string;
  sandbox: boolean;
}

const KEYS = ["deviceId", "deviceSecretB64u", "baseUrl", "minXof", "maxXof", "label", "sandbox"].sort().join(",");
const MAX_INPUT = 2048;
export const DEFAULT_WINDOW_MIN = 15;

function decodeMaybeB64u(text: string): string {
  const t = text.trim();
  if (t.startsWith("{")) return t;
  if (!/^[A-Za-z0-9_-]+$/.test(t)) return "";
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(t.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
  } catch {
    return "";
  }
}

/** Strict: exact key set, exact formats. Accepts raw JSON or base64url(JSON) (the #enroll= fragment form). */
export function parseEnrollPayload(text: string): EnrollPayload | null {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_INPUT) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(decodeMaybeB64u(text));
  } catch {
    return null;
  }
  if (typeof o !== "object" || o === null || Array.isArray(o) || Object.keys(o).sort().join(",") !== KEYS) return null;
  const { deviceId, deviceSecretB64u, baseUrl, minXof, maxXof, label, sandbox } = o;
  if (typeof deviceId !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(deviceId)) return null;
  if (typeof deviceSecretB64u !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(deviceSecretB64u)) return null;
  if (typeof baseUrl !== "string") return null;
  try {
    buildSaleLnurl(baseUrl, "A"); // same rule as the protocol: https, or http only on localhost; no query
  } catch {
    return null;
  }
  const okInt = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 1 && (n as number) <= 0xffffffff;
  if (!okInt(minXof) || !okInt(maxXof) || (minXof as number) > (maxXof as number)) return null;
  if (typeof label !== "string" || !/^[\p{L}\p{N} ._'-]{1,64}$/u.test(label)) return null;
  if (typeof sandbox !== "boolean") return null;
  return { deviceId, deviceSecretB64u, baseUrl: baseUrl.replace(/\/+$/, ""), minXof: minXof as number, maxXof: maxXof as number, label, sandbox };
}

/** Reads #enroll=... once and removes it from the address bar and history before anything else happens. */
export function readEnrollFragment(loc: { hash: string; pathname: string; search: string }, replace: (url: string) => void): string | null {
  if (!loc.hash.startsWith("#enroll=")) return null;
  const value = loc.hash.slice("#enroll=".length);
  replace(loc.pathname + loc.search);
  return value;
}

/** The server must be this app's own origin: the PWA only talks to the server that served it (QR swap guard). */
export async function enrollDevice(p: EnrollPayload, expectedOrigin: string, now: number): Promise<DeviceConfig> {
  if (new URL(p.baseUrl).origin !== expectedOrigin) throw new Error("server mismatch");
  const secret = secretFromString(p.deviceSecretB64u);
  const keys = await deriveKeys(secret); // non-extractable
  secret.fill(0);
  const config: DeviceConfig = {
    deviceId: p.deviceId,
    baseUrl: p.baseUrl,
    minXof: p.minXof,
    maxXof: p.maxXof,
    label: p.label,
    sandbox: p.sandbox,
    saleWindowMin: DEFAULT_WINDOW_MIN,
    enrolledAt: now,
  };
  await putKeys(keys);
  await putConfig(config);
  return config;
}
