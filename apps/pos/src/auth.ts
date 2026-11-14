// Device-authenticated requests (server A1). Canonical string, one element per line:
//   jaay-auth-v1, METHOD, path, deviceId, ts (ms), nonce, hex(sha256(body))
// MAC = HMAC-SHA256 under the device auth key, base64url. The server checks ts against its own clock (120 s).
// The protocol package keeps its base64url helpers internal, so this file has its own encoder.
export const b64uEncode = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

export async function signedHeaders(authKey: CryptoKey, deviceId: string, path: string, body: string, now: number) {
  const ts = String(now);
  const nonce = b64uEncode(crypto.getRandomValues(new Uint8Array(16)));
  const bodyHash = hex(await crypto.subtle.digest("SHA-256", enc.encode(body)));
  const canonical = ["jaay-auth-v1", "POST", path, deviceId, ts, nonce, bodyHash].join("\n");
  const sig = b64uEncode(new Uint8Array(await crypto.subtle.sign("HMAC", authKey, enc.encode(canonical))));
  return { "content-type": "application/json", "x-jaay-device": deviceId, "x-jaay-ts": ts, "x-jaay-nonce": nonce, "x-jaay-sig": sig };
}

/** POST a JSON body to a device-authenticated endpoint. Throws on network failure or any non-200. */
export async function devicePost<T>(fetchFn: typeof fetch, baseUrl: string, deviceId: string, authKey: CryptoKey, path: string, payload: unknown, now: number): Promise<T> {
  const body = JSON.stringify(payload);
  const res = await fetchFn(`${baseUrl}${path}`, { method: "POST", headers: await signedHeaders(authKey, deviceId, path, body, now), body });
  if (res.status !== 200) throw new Error(`http ${res.status}`);
  return (await res.json()) as T;
}
