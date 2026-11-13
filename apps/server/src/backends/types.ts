export interface InvoiceRequest {
  msat: bigint;
  /** hex sha256 of the LNURL-pay metadata string (LUD-06). */
  descriptionHashHex: string;
  expirySec: number;
}
export interface Invoice {
  invoice: string;
  paymentHash: string;
  /** Server-clock ms. */
  expiresAt: number;
}
export type Lookup = { state: "pending" } | { state: "settled" };

export interface InvoiceBackend {
  makeInvoice(r: InvoiceRequest): Promise<Invoice>;
  lookupInvoice(paymentHash: string): Promise<Lookup>;
  close?(): void;
}

/** The only error a backend surfaces. No detail: callers fail closed and log the class name only. */
export class BackendUnavailable extends Error {
  constructor() {
    super("backend unavailable");
  }
}

/**
 * Hard rule 1: never accept a mainnet invoice. Allowed BOLT11 prefixes: lnbcrt (regtest), lntbs (signet), lntb (testnet).
 * Mainnet is "lnbc" followed by an amount or the separator.
 */
export function isTestNetworkInvoice(pr: string): boolean {
  // Only the network prefix matters here; mainnet's "lnbc" + digits can never match "lnbcrt".
  return /^ln(bcrt|tbs|tb)(\d+[munp]?)?1[0-9a-z]{20,}$/i.test(pr);
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<never>((_, rej) => {
      t = setTimeout(() => rej(new BackendUnavailable()), ms);
    }),
  ]);
}
