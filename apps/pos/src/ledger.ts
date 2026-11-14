// The one place sale statuses change. Pure transition table; every caller goes through transition().
//
// Device events: confirm (right code), fail (wrong code, attempts left), lock (third wrong code),
// cancel (merchant), expire (local sale window over). Server events come from reconcile (srv_*).
// paid, paid_late, unpaid and mismatch are reachable only from server events.

export const STATUSES = ["open", "confirmed", "locked", "cancelled", "expired", "paid", "paid_late", "unpaid", "mismatch"] as const;
export const EVENTS = [
  "confirm",
  "fail",
  "lock",
  "cancel",
  "expire",
  "srv_paid",
  "srv_paid_late",
  "srv_pending",
  "srv_expired",
  "srv_unknown",
  "srv_mismatch",
] as const;
export type LedgerStatus = (typeof STATUSES)[number];
export type LedgerEvent = (typeof EVENTS)[number];

type Row = Partial<Record<LedgerEvent, LedgerStatus>>;
const SERVER_ROUTE = (pending: LedgerStatus, expired: LedgerStatus, unknown: LedgerStatus, paid: LedgerStatus = "paid", late: LedgerStatus = "paid_late"): Row => ({
  srv_paid: paid,
  srv_paid_late: late,
  srv_pending: pending,
  srv_expired: expired,
  srv_unknown: unknown,
  srv_mismatch: "mismatch",
});

const TABLE: Record<LedgerStatus, Row> = {
  open: { confirm: "confirmed", fail: "open", lock: "locked", cancel: "cancelled", expire: "expired", ...SERVER_ROUTE("open", "unpaid", "open") },
  // Confirmed but the server never saw a payment: someone had a code without paying. Flag it.
  confirmed: SERVER_ROUTE("confirmed", "mismatch", "mismatch"),
  locked: { cancel: "cancelled", ...SERVER_ROUTE("locked", "unpaid", "unpaid") },
  // Paid after the merchant cancelled: money arrived for a sale that was called off (refund needed).
  cancelled: SERVER_ROUTE("cancelled", "cancelled", "cancelled", "mismatch", "mismatch"),
  expired: { confirm: "confirmed", fail: "expired", lock: "locked", cancel: "cancelled", ...SERVER_ROUTE("expired", "unpaid", "unpaid") },
  paid: { srv_paid: "paid" },
  paid_late: { srv_paid_late: "paid_late" },
  unpaid: SERVER_ROUTE("unpaid", "unpaid", "unpaid"),
  mismatch: { srv_mismatch: "mismatch" },
};

export function transition(from: LedgerStatus, event: LedgerEvent): LedgerStatus | null {
  return TABLE[from][event] ?? null;
}

/** Statuses the merchant can still type a code for. */
export const confirmable = (s: LedgerStatus) => transition(s, "confirm") !== null;
/** Final statuses: nothing left to ask the server. */
export const isFinal = (s: LedgerStatus) => s === "paid" || s === "paid_late" || s === "mismatch";
