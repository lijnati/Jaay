// Test helpers (not part of the bundle). Deterministic clock, fake FX fetch, fake NWC client, log capture.
import { createHash } from "node:crypto";
import { deriveKeys, encodeSale, secretFromString, type DeviceKeys } from "@jaay/protocol";
import type { Config } from "./config";
import { encodeBolt11 } from "./bolt11";
import type { NwcClientLike } from "./backends/nwc";
import { buildServer, type Edges } from "./index";

export const T0 = Date.UTC(2026, 10, 14, 9, 0, 0);
export const MASTER_KEY = new Uint8Array(32).map((_, i) => i + 1);
export const ENROLL_TOKEN = "test-operator-enroll-token-0123456789";

export function testConfig(over: Partial<Config> = {}): Config {
  return {
    port: 8787,
    baseUrl: "http://localhost:8787",
    dbPath: ":memory:",
    production: false,
    sandbox: true,
    allowMixed: false,
    masterKey: MASTER_KEY,
    ephemeralMasterKey: false,
    trustProxy: false,
    lnbitsAllowedHosts: [],
    nwcAllowedRelays: ["ws://127.0.0.1:10547"],
    enrollToken: ENROLL_TOKEN,
    network: "regtest",
    posDir: null,
    simDir: null,
    fxFixedXofPerBtc: null,
    ...over,
  };
}

export class Clock {
  t = T0;
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

/** Fake exchange APIs. Set a rate string to null to make that source fail. */
export class FakeFx {
  kraken: string | null = "62347.80000";
  coinbase: string | null = "62350.00";
  calls = 0;
  fetch = (async (input: string | URL | Request) => {
    this.calls++;
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("kraken")) {
      if (this.kraken === null) return new Response("down", { status: 503 });
      return Response.json({ error: [], result: { XXBTZEUR: { c: [this.kraken, "0.1"] } } });
    }
    if (url.includes("coinbase")) {
      if (this.coinbase === null) return new Response("down", { status: 503 });
      return Response.json({ price: this.coinbase });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

export const ALBY_HUB_METHODS = ["get_info", "make_invoice", "make_hold_invoice", "settle_hold_invoice", "cancel_hold_invoice", "lookup_invoice", "get_budget"];

/** In-memory NWC wallet. `mode` simulates relay trouble: "down" rejects like a lost relay, "hang" never answers. */
export class FakeNwcWallet {
  methods = [...ALBY_HUB_METHODS];
  network = "regtest";
  balanceMsat = 123_456_000;
  now: () => number = Date.now;
  /** A5: make the wallet return a subtly wrong invoice. */
  tamper: null | "network" | "amount" | "descriptionHash" | "noDescriptionHash" | "expired" | "paymentHash" = null;
  mode: "ok" | "down" | "hang" = "ok";
  clientsCreated = 0;
  invoices = new Map<string, { invoice: string; settled: boolean; descriptionHash: string; amount: number; expiry: number }>();
  /** Extra text a misbehaving library might put in errors and console output (used by the log-scrubber test). */
  leak = "";
  private n = 0;

  factory = (url: string): NwcClientLike => {
    this.clientsCreated++;
    let closed = false;
    const gate = async () => {
      if (closed || this.mode === "down") {
        console.error("failed to connect to any relay", new Error(`relay down ${url} ${this.leak}`));
        const e = new Error(`Failed to connect ${url} ${this.leak}`);
        Object.defineProperty(e, "constructor", { value: { name: "Nip47NetworkError" } });
        throw e;
      }
      if (this.mode === "hang") await new Promise(() => {});
    };
    return {
      getInfo: async () => {
        await gate();
        return { methods: this.methods, network: this.network };
      },
      makeInvoice: async (r) => {
        await gate();
        const hash = (++this.n).toString(16).padStart(64, "0");
        const t = this.tamper;
        const invoice = encodeBolt11({
          network: t === "network" ? "signet" : "regtest",
          msat: BigInt(r.amount) + (t === "amount" ? 1000n : 0n),
          paymentHash: t === "paymentHash" ? "f".repeat(64) : hash,
          descriptionHash: t === "noDescriptionHash" ? null : t === "descriptionHash" ? "e".repeat(64) : r.description_hash,
          timestampSec: Math.floor(this.now() / 1000) - (t === "expired" ? 2 * r.expiry : 0),
          expirySec: r.expiry,
        });
        this.invoices.set(hash, { invoice, settled: false, descriptionHash: r.description_hash, amount: r.amount, expiry: r.expiry });
        return { invoice, payment_hash: hash };
      },
      getBalance: async () => {
        await gate();
        return { balance: this.balanceMsat };
      },
      lookupInvoice: async (r) => {
        await gate();
        const inv = this.invoices.get(r.payment_hash);
        return inv?.settled ? { state: "settled", settled_at: 1 } : { state: "pending" };
      },
      close: () => {
        closed = true;
      },
    };
  };

  settleAll() {
    for (const v of this.invoices.values()) v.settled = true;
  }
}

export function makeServer(opts: { cfg?: Partial<Config>; edges?: Edges } = {}) {
  const clock = new Clock();
  const fx = new FakeFx();
  const logs: string[] = [];
  const nwc = new FakeNwcWallet();
  nwc.now = clock.now;
  const s = buildServer(testConfig(opts.cfg), {
    fetch: fx.fetch,
    now: clock.now,
    nwcFactory: nwc.factory,
    logSink: (l) => logs.push(l),
    clientIp: (c) => c.req.header("x-test-ip") ?? "203.0.113.1",
    backendTimeoutMs: 200,
    ...opts.edges,
  });
  const req = async (path: string, init: RequestInit & { ip?: string } = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (init.ip) headers.set("x-test-ip", init.ip);
    return s.app.request(path, { ...init, headers });
  };
  return { ...s, clock, fxApi: fx, logs, nwc, req };
}

export interface Device {
  deviceId: string;
  secret: string;
  keys: DeviceKeys;
}

export async function enroll(
  srv: ReturnType<typeof makeServer>,
  body: Partial<{ label: string; backend: string; connection: string; minXof: number; maxXof: number }> = {},
): Promise<Device> {
  const res = await srv.req("/api/enroll", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ENROLL_TOKEN}` },
    body: JSON.stringify({ label: "Boutique Test", backend: "sandbox", connection: "", minXof: 50, maxXof: 5_000_000, ...body }),
  });
  if (res.status !== 200) throw new Error(`enroll failed ${res.status}`);
  const j = (await res.json()) as { deviceId: string; deviceSecretB64u: string };
  return { deviceId: j.deviceId, secret: j.deviceSecretB64u, keys: await deriveKeys(secretFromString(j.deviceSecretB64u)) };
}

/** Device side: what the merchant PWA does offline. Uses the real protocol. */
export async function sell(dev: Device, amountXof: number) {
  return encodeSale(dev.keys, dev.deviceId, { amountXof }, { minAmountXof: 1, maxAmountXof: 0xffffffff });
}

export const q = (token: string) => encodeURIComponent(token);

/**
 * Reference client for device-authenticated requests (A1). The PWA implements the same canonical string.
 * Overrides let tests break one element at a time.
 */
export async function signedPost(
  srv: ReturnType<typeof makeServer>,
  dev: Device,
  path: string,
  body: unknown,
  o: Partial<{ ts: number; nonce: string; deviceId: string; signPath: string; signBody: string; keys: DeviceKeys; omit: string; ip: string }> = {},
) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const ts = o.ts ?? srv.clock.t;
  const nonce = o.nonce ?? Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
  const deviceId = o.deviceId ?? dev.deviceId;
  const bodyHash = createHash("sha256").update(o.signBody ?? text).digest("hex");
  const canonical = ["jaay-auth-v1", "POST", o.signPath ?? path, deviceId, String(ts), nonce, bodyHash].join("\n");
  const mac = await crypto.subtle.sign("HMAC", (o.keys ?? dev.keys).auth, new TextEncoder().encode(canonical));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-jaay-device": deviceId,
    "x-jaay-ts": String(ts),
    "x-jaay-nonce": nonce,
    "x-jaay-sig": Buffer.from(mac).toString("base64url"),
  };
  if (o.omit) delete headers[o.omit];
  return srv.req(path, { method: "POST", headers, body: text, ip: o.ip });
}
