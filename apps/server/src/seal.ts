// Secrets at rest: AES-256-GCM under the master key, random 96-bit IV per seal, versioned text format.
// Format: "v1." + base64url(iv 12 | ciphertext | tag 16). AAD = "jaay/seal/v1|" + purpose, so a sealed
// value cannot be moved to another row or field (purpose names the field and the row id).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class SealError extends Error {
  constructor() {
    super("sealed value rejected");
  }
}

export interface Sealer {
  seal(plain: string, purpose: string): string;
  open(sealed: string, purpose: string): string;
}

export function createSealer(masterKey: Uint8Array): Sealer {
  if (masterKey.length !== 32) throw new Error("master key must be 32 bytes");
  const key = Buffer.from(masterKey);
  const aad = (purpose: string) => Buffer.from(`jaay/seal/v1|${purpose}`, "utf8");
  return {
    seal(plain, purpose) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv).setAAD(aad(purpose));
      const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      return `v1.${Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64url")}`;
    },
    open(sealed, purpose) {
      try {
        if (!sealed.startsWith("v1.")) throw new SealError();
        const raw = Buffer.from(sealed.slice(3), "base64url");
        if (raw.length < 28) throw new SealError();
        const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12)).setAAD(aad(purpose));
        d.setAuthTag(raw.subarray(raw.length - 16));
        return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8");
      } catch {
        throw new SealError();
      }
    },
  };
}
