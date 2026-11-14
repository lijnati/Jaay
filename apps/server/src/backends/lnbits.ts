// LNbits fallback with an INVOICE key (receive-only by LNbits design). Connection string:
//   https://lnbits.example/?api-key=<invoice key>    (http allowed only for localhost)
// Tested against a mocked HTTP server only; a real LNbits instance was NOT RUN.
import { BackendUnavailable, isTestNetworkInvoice, withTimeout, type BackendInfo, type Invoice, type InvoiceBackend, type InvoiceRequest, type Lookup } from "./types";

export interface LnbitsConn {
  url: string;
  key: string;
}

export function parseLnbitsConnection(text: string): LnbitsConn | null {
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  const key = u.searchParams.get("api-key");
  if (!(u.protocol === "https:" || (u.protocol === "http:" && local)) || !key || !/^[0-9a-f]{32}$/.test(key) || u.hash) return null;
  u.search = "";
  return { url: u.toString().replace(/\/+$/, ""), key };
}

export class LnbitsBackend implements InvoiceBackend {
  constructor(
    private conn: LnbitsConn,
    private fetchFn: typeof fetch,
    private now: () => number,
    private timeoutMs = 8000,
  ) {}

  private async req(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    try {
      const res = await withTimeout(
        this.fetchFn(`${this.conn.url}${path}`, {
          method,
          headers: { "X-Api-Key": this.conn.key, "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
          redirect: "manual", // a redirect could point at an internal host; 3xx is treated as a failure
        }),
        this.timeoutMs,
      );
      if (!res.ok) throw new BackendUnavailable();
      return (await res.json()) as Record<string, unknown>;
    } catch {
      throw new BackendUnavailable();
    }
  }

  /** Enrollment probe: the key must open the wallet. */
  async check(): Promise<void> {
    await this.req("GET", "/api/v1/wallet");
  }

  async makeInvoice(r: InvoiceRequest): Promise<Invoice> {
    if (r.msat % 1000n !== 0n) throw new BackendUnavailable();
    const j = await this.req("POST", "/api/v1/payments", {
      out: false,
      amount: Number(r.msat / 1000n),
      unit: "sat",
      memo: "",
      description_hash: r.descriptionHashHex,
      expiry: r.expirySec,
    });
    const invoice = (j.bolt11 ?? j.payment_request) as unknown;
    const paymentHash = j.payment_hash as unknown;
    if (typeof invoice !== "string" || typeof paymentHash !== "string" || !/^[0-9a-f]{64}$/.test(paymentHash)) throw new BackendUnavailable();
    if (!isTestNetworkInvoice(invoice)) throw new BackendUnavailable();
    return { invoice, paymentHash, expiresAt: this.now() + r.expirySec * 1000 };
  }

  /** An LNbits invoice key cannot pay by design; its permissions cannot be introspected beyond that. */
  async describe(): Promise<BackendInfo> {
    return { label: "LNbits (invoice key)", methods: ["make_invoice", "lookup_invoice"], balanceMsat: null };
  }

  async lookupInvoice(paymentHash: string): Promise<Lookup> {
    const j = await this.req("GET", `/api/v1/payments/${paymentHash}`);
    return j.paid === true ? { state: "settled" } : { state: "pending" };
  }
}
