import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildSaleLnurl } from "@jaay/protocol";
import type { Network } from "./bolt11";

export interface Config {
  port: number;
  baseUrl: string;
  dbPath: string;
  production: boolean;
  /** SANDBOX=1: the fake backend and /sandbox routes are enabled, and every page carries a SANDBOX label. */
  sandbox: boolean;
  /** JAAY_ALLOW_MIXED=1: a sandbox server may also enroll real (regtest or signet) backends. */
  allowMixed: boolean;
  masterKey: Uint8Array;
  ephemeralMasterKey: boolean;
  /** TRUST_PROXY=1: take the client IP from the first X-Forwarded-For entry (only behind a proxy you run). */
  trustProxy: boolean;
  /**
   * Enrollment is open, so the hosts the server will contact on a merchant's behalf are an operator allowlist
   * (no SSRF to internal services). LNbits: empty means LNbits enrollment is off. NWC: relay URLs.
   */
  lnbitsAllowedHosts: string[];
  nwcAllowedRelays: string[];
  /** A4: JAAY_ENROLL_TOKEN, required as a Bearer token for every non-sandbox enrollment. */
  enrollToken: string | null;
  /** JAAY_NETWORK: the only network whose invoices are accepted (A5, Hard rule 1). */
  network: Network;
  /** A6: JAAY_POS_DIR, the apps/pos build output served at /app/; null disables it. */
  posDir: string | null;
  /** JAAY_SIM_DIR: the customer simulator build served at /sim/; null disables it. */
  simDir: string | null;
  /** JAAY_FX_FIXED_XOF_PER_BTC: a fixed demo rate, allowed only with SANDBOX=1, labeled everywhere. */
  fxFixedXofPerBtc: bigint | null;
}

export const DEFAULT_NWC_RELAYS = ["wss://relay.getalby.com/v1", "wss://relay2.getalby.com/v1"];
const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export class ConfigError extends Error {}

/** Strict base64 (standard or url alphabet) of exactly 32 bytes. */
export function parseMasterKey(text: string | undefined): Uint8Array | null {
  if (!text || !/^[A-Za-z0-9+/_-]{43}=?$/.test(text)) return null;
  const bytes = Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return bytes.length === 32 ? new Uint8Array(bytes) : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === "production";
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError("PORT must be 1..65535");

  const baseUrl = (env.BASE_URL ?? (production ? "" : `http://localhost:${port}`)).replace(/\/+$/, "");
  try {
    // Same rules the device uses: https, or http only for localhost, 127.0.0.1 and .onion.
    buildSaleLnurl(baseUrl, "A");
  } catch {
    throw new ConfigError("BASE_URL must be https (or http on localhost) with no query or fragment");
  }

  let masterKey = parseMasterKey(env.JAAY_MASTER_KEY);
  let ephemeralMasterKey = false;
  if (!masterKey) {
    if (production || env.JAAY_MASTER_KEY) throw new ConfigError("JAAY_MASTER_KEY must be 32 bytes, base64");
    // Dev only: secrets sealed with this key are unreadable after a restart.
    masterKey = new Uint8Array(randomBytes(32));
    ephemeralMasterKey = true;
  }

  const enrollToken = env.JAAY_ENROLL_TOKEN || null;
  if (enrollToken !== null && enrollToken.length < 32) throw new ConfigError("JAAY_ENROLL_TOKEN must be at least 32 characters");
  const sandbox = env.SANDBOX === "1";
  const allowMixed = env.JAAY_ALLOW_MIXED === "1";
  if (production && (!sandbox || allowMixed) && !enrollToken) {
    throw new ConfigError("JAAY_ENROLL_TOKEN is required in production when a non-sandbox backend can be enrolled");
  }

  const network = (env.JAAY_NETWORK ?? "regtest") as Network;
  if (!["regtest", "signet", "testnet"].includes(network)) throw new ConfigError("JAAY_NETWORK must be regtest, signet or testnet");

  const simDir = env.JAAY_SIM_DIR || null;
  if (simDir && !existsSync(join(simDir, "index.html"))) throw new ConfigError("JAAY_SIM_DIR must contain index.html");
  const fixedText = env.JAAY_FX_FIXED_XOF_PER_BTC || null;
  if (fixedText !== null && !sandbox) throw new ConfigError("JAAY_FX_FIXED_XOF_PER_BTC is allowed only with SANDBOX=1");
  if (fixedText !== null && !/^[1-9]\d{3,12}$/.test(fixedText)) throw new ConfigError("JAAY_FX_FIXED_XOF_PER_BTC must be a positive integer");
  const posDir = env.JAAY_POS_DIR || null;
  if (posDir && !existsSync(join(posDir, "index.html"))) throw new ConfigError("JAAY_POS_DIR must contain index.html");

  return {
    port,
    baseUrl,
    dbPath: env.DB_PATH ?? (production ? "/data/jaay.sqlite" : ":memory:"),
    production,
    sandbox,
    allowMixed,
    masterKey,
    ephemeralMasterKey,
    trustProxy: env.TRUST_PROXY === "1",
    lnbitsAllowedHosts: list(env.LNBITS_ALLOWED_HOSTS).map((h) => h.toLowerCase()),
    nwcAllowedRelays: env.NWC_ALLOWED_RELAYS ? list(env.NWC_ALLOWED_RELAYS) : DEFAULT_NWC_RELAYS,
    enrollToken,
    network,
    posDir,
    simDir,
    fxFixedXofPerBtc: fixedText === null ? null : BigInt(fixedText),
  };
}
