// NWC (NIP-47) backend over @getalby/sdk 9.0.0, chosen in spike S1.
// Resilience: every call has a short timeout; a network or timeout failure drops the client, and the next call
// builds a fresh one (reconnect). All failures surface as BackendUnavailable with no detail.
import { NWCClient } from "@getalby/sdk/nwc";
import { BackendUnavailable, isTestNetworkInvoice, withTimeout, type Invoice, type InvoiceBackend, type InvoiceRequest, type Lookup } from "./types";

/** The subset of NWCClient Jaay uses; tests provide fakes. */
export interface NwcClientLike {
  getInfo(): Promise<{ methods: string[]; network?: string }>;
  makeInvoice(r: { amount: number; description_hash: string; expiry: number }): Promise<{ invoice: string; payment_hash: string; expires_at?: number }>;
  lookupInvoice(r: { payment_hash: string }): Promise<{ state?: string; settled_at?: number }>;
  close(): void;
}
export type NwcFactory = (url: string) => NwcClientLike;

// The SDK's logger option only covers debug output; its console.* calls are handled by installConsoleGuard.
const silent = { debug: () => {} };
export const sdkNwcFactory: NwcFactory = (url) => new NWCClient({ nostrWalletConnectUrl: url, logger: silent }) as unknown as NwcClientLike;

const SPEND_METHODS = ["pay_invoice", "multi_pay_invoice", "pay_keysend", "multi_pay_keysend"];
const TEST_NETWORKS = new Set(["regtest", "signet", "testnet", "mutinynet"]);

/**
 * Enrollment rule from S1: must offer make_invoice and lookup_invoice; must offer no spend method
 * (the known four, or anything with "pay" in its name). Extra non-spend methods are fine.
 * Hard rule 1: the wallet must report a test network.
 */
export function nwcInfoAcceptable(info: { methods?: unknown; network?: unknown }): boolean {
  const methods = Array.isArray(info.methods) ? info.methods.filter((m): m is string => typeof m === "string") : [];
  if (!methods.includes("make_invoice") || !methods.includes("lookup_invoice")) return false;
  if (methods.some((m) => SPEND_METHODS.includes(m) || /pay/i.test(m))) return false;
  return typeof info.network === "string" && TEST_NETWORKS.has(info.network.toLowerCase());
}

export function looksLikeNwcUrl(text: string): boolean {
  return /^nostr\+walletconnect:\/\/[0-9a-f]{64}\?/.test(text) && text.length <= 1024;
}

export class NwcBackend implements InvoiceBackend {
  private client: NwcClientLike | undefined;

  constructor(
    private url: string,
    private factory: NwcFactory,
    private now: () => number,
    private timeoutMs = 8000,
  ) {}

  private async call<T>(fn: (c: NwcClientLike) => Promise<T>): Promise<T> {
    let c: NwcClientLike;
    try {
      c = this.client ??= this.factory(this.url);
    } catch {
      throw new BackendUnavailable();
    }
    try {
      return await withTimeout(fn(c), this.timeoutMs);
    } catch (e) {
      // Wallet errors (a NIP-47 error code in a reply) mean the connection works; anything else drops it.
      if ((e as { constructor?: { name?: string } })?.constructor?.name !== "Nip47WalletError") {
        if (this.client === c) this.client = undefined;
        try {
          c.close();
        } catch {
          /* closing a broken client may throw */
        }
      }
      throw new BackendUnavailable();
    }
  }

  async check(): Promise<void> {
    const info = await this.call((c) => c.getInfo());
    if (!nwcInfoAcceptable(info)) throw new BackendUnavailable();
  }

  async makeInvoice(r: InvoiceRequest): Promise<Invoice> {
    const tx = await this.call((c) => c.makeInvoice({ amount: Number(r.msat), description_hash: r.descriptionHashHex, expiry: r.expirySec }));
    if (typeof tx.invoice !== "string" || !isTestNetworkInvoice(tx.invoice) || !/^[0-9a-f]{64}$/.test(tx.payment_hash)) throw new BackendUnavailable();
    return { invoice: tx.invoice, paymentHash: tx.payment_hash, expiresAt: this.now() + r.expirySec * 1000 };
  }

  async lookupInvoice(paymentHash: string): Promise<Lookup> {
    const tx = await this.call((c) => c.lookupInvoice({ payment_hash: paymentHash }));
    return tx.state === "settled" || (typeof tx.settled_at === "number" && tx.settled_at > 0) ? { state: "settled" } : { state: "pending" };
  }

  close(): void {
    try {
      this.client?.close();
    } catch {
      /* ignore */
    }
    this.client = undefined;
  }
}
