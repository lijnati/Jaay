// Sale state machine. Pure; the repo applies transitions with a compare-and-set on the previous status.
//
//   created --quote--> quoted --quote--> quoted (re-quote after the 120 s lock lapses, inside the sale window)
//   quoted --invoice--> invoiced --settle--> paid
//   created|quoted --expire--> expired          (sale window passed with no invoice)
//   invoiced --expire--> expired                (invoice expiry plus grace passed, unpaid)
//   expired --settle--> paid_late               (payment seen after expiry: accepted and flagged, never rejected)
//   paid, paid_late: terminal
import type { SaleStatus } from "./repo";

export type SaleEvent = "quote" | "invoice" | "settle" | "expire";

const TABLE: Record<SaleStatus, Partial<Record<SaleEvent, SaleStatus>>> = {
  created: { quote: "quoted", expire: "expired" },
  quoted: { quote: "quoted", invoice: "invoiced", expire: "expired" },
  invoiced: { settle: "paid", expire: "expired" },
  expired: { settle: "paid_late" },
  paid: {},
  paid_late: {},
};

export function transition(from: SaleStatus, event: SaleEvent): SaleStatus | null {
  return TABLE[from][event] ?? null;
}

export const isSettled = (s: SaleStatus) => s === "paid" || s === "paid_late";
