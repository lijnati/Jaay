// SANDBOX customer wallet (simulator, not a real wallet). Behaves like an LNURL-pay wallet: decodes the LNURL with
// the protocol's LUD-01 function, fetches the payRequest, checks it, calls the callback, decodes the invoice, and
// shows the success action the way Phoenix does. It holds no secret: the sandbox invoice is "paid" by its payment hash.
import { lnurlDecode } from "@jaay/protocol";
import { decode } from "light-bolt11-decoder";

/** The only error the UI shows. Its message is an LNURL error reason from the server, or a generic word. */
export class WalletError extends Error {}
const GENERIC = "Error";

/** https everywhere; http only on localhost and 127.0.0.1 (same rule as the protocol's base URL check). */
export function allowedUrl(u: URL): boolean {
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
}

export function parseInput(text: string): URL {
  const t = (text ?? "").trim().replace(/^lightning:/i, "");
  if (!/^lnurl1[0-9a-z]+$/i.test(t)) throw new WalletError(GENERIC);
  let url: URL;
  try {
    url = new URL(lnurlDecode(t)); // rejects mixed case and bad checksums
  } catch {
    throw new WalletError(GENERIC);
  }
  if (!allowedUrl(url)) throw new WalletError(GENERIC);
  return url;
}

async function getJson(fetchFn: typeof fetch, url: string): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    const res = await fetchFn(url, { headers: { accept: "application/json" } });
    body = await res.json();
  } catch {
    throw new WalletError(GENERIC);
  }
  const o = body as Record<string, unknown>;
  if (typeof o !== "object" || o === null) throw new WalletError(GENERIC);
  // LUD-06 error: show the reason string and nothing else.
  if (o.status === "ERROR") throw new WalletError(typeof o.reason === "string" && o.reason.length <= 200 ? o.reason : GENERIC);
  return o;
}

export interface PayRequest {
  callback: URL;
  amountMsat: number;
  metadata: string;
  description: string;
  /** The XOF amount as printed in the description, if any. */
  xof: string | null;
  /** The fallback receipt URL printed in the description (S5), if any. */
  receiptUrl: string | null;
  raw: Record<string, unknown>;
}

export async function fetchPayRequest(fetchFn: typeof fetch, url: URL): Promise<PayRequest> {
  const o = await getJson(fetchFn, url.toString());
  const { tag, callback, minSendable, maxSendable, metadata } = o;
  if (tag !== "payRequest" || typeof callback !== "string" || typeof metadata !== "string") throw new WalletError(GENERIC);
  if (!Number.isSafeInteger(minSendable) || (minSendable as number) <= 0 || minSendable !== maxSendable) throw new WalletError(GENERIC);
  let cb: URL;
  let entries: unknown;
  try {
    cb = new URL(callback);
    entries = JSON.parse(metadata);
  } catch {
    throw new WalletError(GENERIC);
  }
  if (!allowedUrl(cb) || !Array.isArray(entries)) throw new WalletError(GENERIC);
  const text = (entries as unknown[]).find((e): e is [string, string] => Array.isArray(e) && e[0] === "text/plain" && typeof e[1] === "string");
  if (!text || text[1].trim() === "") throw new WalletError(GENERIC);
  const description = text[1];
  return {
    callback: cb,
    amountMsat: minSendable as number,
    metadata,
    description,
    xof: /(\d[\d ]*) XOF/.exec(description)?.[0] ?? null,
    receiptUrl: /https?:\/\/[^\s]+\/r\/[A-Za-z0-9_-]{22}/.exec(description)?.[0] ?? null,
    raw: o,
  };
}

export interface InvoiceResponse {
  pr: string;
  successAction: unknown;
  raw: Record<string, unknown>;
}

export async function requestInvoice(fetchFn: typeof fetch, pay: Pick<PayRequest, "callback" | "amountMsat">): Promise<InvoiceResponse> {
  const u = new URL(pay.callback);
  u.searchParams.set("amount", String(pay.amountMsat));
  const o = await getJson(fetchFn, u.toString());
  if (typeof o.pr !== "string") throw new WalletError(GENERIC);
  return { pr: o.pr, successAction: o.successAction, raw: o };
}

export interface InvoiceSummary {
  network: string;
  msat: string;
  paymentHash: string;
  descriptionHashOk: boolean;
  expirySec: number;
}

/** Decode only (a simulator does not verify signatures). Checks the description hash like a LUD-06 wallet. */
export async function invoiceSummary(pr: string, metadata: string): Promise<InvoiceSummary> {
  const want = await sha256Hex(metadata);
  try {
    const d = decode(pr);
    const sec = (n: string) => d.sections.find((s) => s.name === n) as { letters?: string; value?: unknown } | undefined;
    const paymentHash = sec("payment_hash")?.value;
    if (typeof paymentHash !== "string") throw new Error();
    return {
      network: sec("coin_network")?.letters ?? "?",
      msat: String(sec("amount")?.value ?? "0"),
      paymentHash,
      descriptionHashOk: sec("description_hash")?.value === want,
      expirySec: d.expiry,
    };
  } catch {
    throw new WalletError(GENERIC);
  }
}

/** Phoenix rule: a url success action becomes a link only on the callback's own host; otherwise text only. */
export function successLink(action: unknown, callback: URL): { description: string; url: string | null } | null {
  const a = action as Record<string, unknown> | undefined;
  if (!a || typeof a !== "object") return null;
  if (a.tag === "message" && typeof a.message === "string") return { description: a.message, url: null };
  if (a.tag !== "url" || typeof a.description !== "string") return null;
  let u: URL | null = null;
  try {
    u = new URL(String(a.url));
  } catch {
    u = null;
  }
  const ok = u !== null && allowedUrl(u) && u.host === callback.host;
  return { description: a.description, url: ok ? u!.toString() : null };
}

/** SANDBOX only: ask the server to mark the fake invoice paid, by payment hash. */
export async function sandboxPay(fetchFn: typeof fetch, origin: string, paymentHash: string): Promise<boolean> {
  try {
    const res = await fetchFn(`${origin}/sandbox/pay/${paymentHash}`, { method: "POST" });
    return res.ok && ((await res.json()) as { status?: string }).status === "paid";
  } catch {
    return false;
  }
}

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
}
