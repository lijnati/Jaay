// Spike S1 probe. Proves, against a local regtest stack, that a receive-only NWC connection can
// create LNURL-pay-compatible invoices and see them settle, and cannot spend.
// Runs the same checks through two clients: @getalby/sdk NWCClient and a thin nostr-tools client.
// Never prints connection strings, secrets or macaroons.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import https from "node:https";
import { NWCClient } from "@getalby/sdk/nwc";
import { decode } from "light-bolt11-decoder";
import * as nip04 from "nostr-tools/nip04";
import * as nip44 from "nostr-tools/nip44";
import { finalizeEvent } from "nostr-tools/pure";
import { Relay } from "nostr-tools/relay";
import { hexToBytes } from "nostr-tools/utils";

process.loadEnvFile(new URL(".env", import.meta.url));
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing ${k} in .env`);
  return v;
};
const NWC_URL = env("NWC_URL");
const LND2_REST = env("LND2_REST"); // host:port of the payer node REST API
const LND2_MACAROON_HEX = env("LND2_MACAROON_HEX");
const LND2_TLS_CERT = readFileSync(new URL(env("LND2_TLS_CERT"), import.meta.url));

const AMOUNT_SAT = 1000;
const EXPIRY_S = 600;
// Sample LUD-06 metadata, as the M2 server will build it per sale.
const METADATA = JSON.stringify([["text/plain", "jaay: vente 1000 XOF"]]);
const DESC_HASH = createHash("sha256").update(METADATA).digest("hex");
const SPEND_METHODS = ["pay_invoice", "multi_pay_invoice", "pay_keysend", "multi_pay_keysend"];

// ---------- common client shape ----------
type Tx = { invoice: string; payment_hash: string; state?: string; settled_at?: number };
interface Nwc {
  name: string;
  getInfo(): Promise<{ methods: string[]; network?: string }>;
  makeInvoice(r: { amount: number; description_hash: string; expiry: number }): Promise<Tx>;
  lookupInvoice(paymentHash: string): Promise<Tx>;
  payInvoice(invoice: string): Promise<unknown>;
  close(): void;
}

function sdkClient(url: string): Nwc {
  const c = new NWCClient({ nostrWalletConnectUrl: url });
  return {
    name: "@getalby/sdk",
    getInfo: () => c.getInfo(),
    makeInvoice: (r) => c.makeInvoice(r),
    lookupInvoice: (payment_hash) => c.lookupInvoice({ payment_hash }),
    payInvoice: (invoice) => c.payInvoice({ invoice }),
    close: () => c.close(),
  };
}

class NwcError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

// Thin NIP-47 client: one relay, request/response only, nip44_v2 when the wallet advertises it.
function handClient(url: string, timeoutMs = 10_000): Nwc {
  const u = new URL(url.replace(/^nostr\+walletconnect:\/\//, "http://"));
  const walletPubkey = u.hostname;
  const relayUrl = u.searchParams.get("relay");
  const secret = u.searchParams.get("secret");
  if (!/^[0-9a-f]{64}$/.test(walletPubkey) || !relayUrl || !secret) throw new NwcError("BAD_URI");
  const sk = hexToBytes(secret);
  let relay: Relay | undefined;
  let enc: "nip44_v2" | "nip04" | undefined;

  const withTimeout = <T>(p: Promise<T>, what: string) =>
    Promise.race([
      p,
      new Promise<never>((_, rej) => setTimeout(() => rej(new NwcError(`TIMEOUT_${what}`)), timeoutMs)),
    ]);

  async function conn() {
    if (relay?.connected) return relay;
    relay = await withTimeout(Relay.connect(relayUrl!), "CONNECT");
    return relay;
  }
  async function encryption(r: Relay) {
    if (enc) return enc;
    const info = await withTimeout(
      new Promise<string[]>((resolve) => {
        let tags: string[] = [];
        const sub = r.subscribe([{ kinds: [13194], authors: [walletPubkey], limit: 1 }], {
          onevent: (e) => (tags = e.tags.find((t) => t[0] === "encryption")?.[1]?.split(" ") ?? []),
          oneose: () => (sub.close(), resolve(tags)),
        });
      }),
      "INFO",
    );
    enc = info.includes("nip44_v2") ? "nip44_v2" : "nip04";
    return enc;
  }
  async function request<T>(method: string, params: object): Promise<T> {
    const r = await conn();
    const e = await encryption(r);
    const body = JSON.stringify({ method, params });
    const ck = nip44.getConversationKey(sk, walletPubkey);
    const content = e === "nip44_v2" ? nip44.encrypt(body, ck) : await nip04.encrypt(sk, walletPubkey, body);
    const ev = finalizeEvent(
      { kind: 23194, created_at: Math.floor(Date.now() / 1000), tags: [["p", walletPubkey], ["encryption", e]], content },
      sk,
    );
    return withTimeout(
      new Promise<T>((resolve, reject) => {
        const sub = r.subscribe([{ kinds: [23195], authors: [walletPubkey], "#e": [ev.id] }], {
          onevent: async (resp) => {
            sub.close();
            try {
              const plain = e === "nip44_v2" ? nip44.decrypt(resp.content, ck) : await nip04.decrypt(sk, walletPubkey, resp.content);
              const msg = JSON.parse(plain);
              if (msg.error) reject(new NwcError(String(msg.error.code)));
              else resolve(msg.result as T);
            } catch {
              reject(new NwcError("BAD_RESPONSE"));
            }
          },
        });
        r.publish(ev).catch(() => reject(new NwcError("PUBLISH_FAILED")));
      }),
      "REPLY",
    );
  }
  return {
    name: "nostr-tools (hand-rolled)",
    getInfo: () => request("get_info", {}),
    makeInvoice: (p) => request("make_invoice", p),
    lookupInvoice: (payment_hash) => request("lookup_invoice", { payment_hash }),
    payInvoice: (invoice) => request("pay_invoice", { invoice }),
    close: () => relay?.close(),
  };
}

// ---------- payer node (LND REST) ----------
function lnd<T>(method: string, path: string, body?: object): Promise<T> {
  const [host, port] = LND2_REST.split(":");
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host, port, path, method, ca: LND2_TLS_CERT, headers: { "Grpc-Metadata-macaroon": LND2_MACAROON_HEX } },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          // /v2/router/send streams one JSON object per line; keep the last one.
          const last = data.trim().split("\n").pop() ?? "{}";
          if ((res.statusCode ?? 500) >= 400) reject(new Error(`lnd ${path} http ${res.statusCode}`));
          else resolve(JSON.parse(last) as T);
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ---------- checks ----------
const results: { client: string; check: string; ok: boolean; detail: string }[] = [];
function check(client: string, name: string, ok: boolean, detail = "") {
  results.push({ client, check: name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  [${client}] ${name}${detail ? `  (${detail})` : ""}`);
}
const ms = (t0: number) => Math.round(performance.now() - t0);
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
const errCode = (e: unknown) =>
  (e as { code?: string }).code ?? (e as Error)?.constructor?.name ?? "unknown";

async function run(c: Nwc) {
  const n = c.name;
  console.log(`\n=== ${n} ===`);

  // 1. Enrollment check (M2 will reuse): receive methods present, every spend method absent.
  let t0 = performance.now();
  const info = await c.getInfo();
  console.log(`get_info ${ms(t0)} ms, network=${info.network}, methods=${info.methods.join(",")}`);
  check(n, "get_info lists make_invoice and lookup_invoice", ["make_invoice", "lookup_invoice"].every((m) => info.methods.includes(m)));
  check(n, "get_info lists no spend method", !SPEND_METHODS.some((m) => info.methods.includes(m)));

  // 2. make_invoice with description_hash and expiry.
  t0 = performance.now();
  const tx = await c.makeInvoice({ amount: AMOUNT_SAT * 1000, description_hash: DESC_HASH, expiry: EXPIRY_S });
  console.log(`make_invoice ${ms(t0)} ms`);

  // 3. Decode the BOLT11 independently.
  const sec = Object.fromEntries(decode(tx.invoice).sections.map((s) => [s.name, (s as { value?: unknown }).value]));
  check(n, "bolt11 description_hash == sha256(metadata)", sec.description_hash === DESC_HASH);
  check(n, "bolt11 has no plain description", sec.description === undefined);
  check(n, "bolt11 amount matches", String(sec.amount) === String(AMOUNT_SAT * 1000), `${sec.amount} msat`);
  check(n, "bolt11 expiry matches", Number(sec.expiry) === EXPIRY_S, `${sec.expiry} s`);
  check(n, "bolt11 is regtest (lnbcrt)", tx.invoice.startsWith("lnbcrt"));

  // 4. Pay from the second node, 5. poll lookup_invoice until settled.
  const tPay = performance.now();
  const pay = lnd<{ result?: { status: string } }>("POST", "/v2/router/send", {
    payment_request: tx.invoice,
    timeout_seconds: 30,
    fee_limit_sat: 10,
  });
  let settledAfter = -1;
  let polls = 0;
  while (performance.now() - tPay < 30_000) {
    polls++;
    const l = await c.lookupInvoice(tx.payment_hash);
    if (l.state === "settled" || l.settled_at) {
      settledAfter = ms(tPay);
      break;
    }
    await sleep(250);
  }
  const payRes = await pay;
  console.log(`payer status=${payRes.result?.status}, settled seen by lookup_invoice after ${settledAfter} ms (${polls} polls)`);
  check(n, "lookup_invoice shows settled", settledAfter >= 0, `${settledAfter} ms`);

  // 6. pay_invoice on the same connection must fail, and the target invoice must stay unpaid.
  const target = await lnd<{ payment_request: string; r_hash: string }>("POST", "/v1/invoices", { value: 10, memo: "s1 spend probe" });
  let spendErr: unknown = null;
  try {
    await c.payInvoice(target.payment_request);
  } catch (e) {
    spendErr = e;
  }
  console.log(`pay_invoice error code: ${spendErr ? errCode(spendErr) : "none (it succeeded!)"}`);
  check(n, "pay_invoice rejected", spendErr !== null);
  check(n, "pay_invoice error is RESTRICTED", spendErr !== null && errCode(spendErr) === "RESTRICTED", spendErr ? errCode(spendErr) : "");
  await sleep(1500);
  const rHashHex = Buffer.from(target.r_hash, "base64").toString("hex");
  const after = await lnd<{ state: string }>("GET", `/v1/invoice/${rHashHex}`);
  check(n, "spend target invoice still unpaid", after.state === "OPEN", after.state);

  // 7. make_invoice latency, 10 runs.
  const lat: number[] = [];
  for (let i = 0; i < 10; i++) {
    t0 = performance.now();
    await c.makeInvoice({ amount: AMOUNT_SAT * 1000, description_hash: DESC_HASH, expiry: EXPIRY_S });
    lat.push(ms(t0));
  }
  lat.sort((a, b) => a - b);
  const stats = { min: lat[0], median: (lat[4]! + lat[5]!) / 2, max: lat[9] };
  console.log(`make_invoice latency x10 (ms): ${JSON.stringify(stats)}`);
  c.close();
  return { client: n, settledAfter, ...stats };
}

// Relay down: point the same connection at a closed port and see how each client fails.
async function relayDown(make: (u: string) => Nwc) {
  const u = new URL(NWC_URL.replace(/^nostr\+walletconnect:\/\//, "http://"));
  u.searchParams.set("relay", "ws://127.0.0.1:1");
  const dead = make(u.toString().replace(/^http:\/\//, "nostr+walletconnect://"));
  const t0 = performance.now();
  let out: string;
  try {
    await Promise.race([dead.getInfo(), sleep(30_000).then(() => Promise.reject(new NwcError("NO_ERROR_AFTER_30S")))]);
    out = "unexpected success";
  } catch (e) {
    out = errCode(e);
  }
  try {
    dead.close();
  } catch {
    /* ignore */
  }
  console.log(`relay down [${dead.name}]: failed with ${out} after ${ms(t0)} ms`);
  return { client: dead.name, error: out, after: ms(t0) };
}

const summary = [await run(sdkClient(NWC_URL)), await run(handClient(NWC_URL))];
const down = [await relayDown(sdkClient), await relayDown((u) => handClient(u))];
console.log("\n=== summary ===");
console.table(summary);
console.table(down);
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `FAILED: ${failed.length} check(s)` : `ALL ${results.length} CHECKS PASSED`);
process.exit(failed.length ? 1 : 0);
