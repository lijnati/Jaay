// SANDBOX: a fake invoice backend. Invoices are not real and cannot be paid by any wallet;
// POST /sandbox/pay/:sid marks one paid. Labeled as fake everywhere it surfaces (Hard rule 2).
import { randomBytes } from "node:crypto";
import type { BackendInfo, Invoice, InvoiceBackend, InvoiceRequest, Lookup } from "./types";

export class SandboxBackend implements InvoiceBackend {
  private invoices = new Map<string, { paid: boolean }>();

  constructor(private now: () => number) {}

  async makeInvoice(r: InvoiceRequest): Promise<Invoice> {
    const paymentHash = randomBytes(32).toString("hex");
    this.invoices.set(paymentHash, { paid: false });
    // Fake, clearly marked, regtest-prefixed so the mainnet guard still applies.
    return { invoice: `lnbcrt1sandboxfake${paymentHash}`, paymentHash, expiresAt: this.now() + r.expirySec * 1000 };
  }

  async lookupInvoice(paymentHash: string): Promise<Lookup> {
    return this.invoices.get(paymentHash)?.paid ? { state: "settled" } : { state: "pending" };
  }

  async describe(): Promise<BackendInfo> {
    return { label: "SANDBOX (simulated payments, no real bitcoin)", methods: ["make_invoice", "lookup_invoice"], balanceMsat: null };
  }

  /** Returns false for unknown invoices. */
  markPaid(paymentHash: string): boolean {
    const inv = this.invoices.get(paymentHash);
    if (!inv) return false;
    inv.paid = true;
    return true;
  }
}
