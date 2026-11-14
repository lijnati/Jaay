import { expect, test } from "vitest";
import { EVENTS, STATUSES, transition, type LedgerStatus } from "./ledger";

// The complete allowed table. Every pair not listed must be refused (null).
const ALLOWED: Record<string, LedgerStatus> = {
  "open/confirm": "confirmed",
  "open/fail": "open",
  "open/lock": "locked",
  "open/cancel": "cancelled",
  "open/expire": "expired",
  "open/srv_paid": "paid",
  "open/srv_paid_late": "paid_late",
  "open/srv_pending": "open",
  "open/srv_expired": "unpaid",
  "open/srv_unknown": "open",
  "open/srv_mismatch": "mismatch",

  "confirmed/srv_paid": "paid",
  "confirmed/srv_paid_late": "paid_late",
  "confirmed/srv_pending": "confirmed",
  "confirmed/srv_expired": "mismatch",
  "confirmed/srv_unknown": "mismatch",
  "confirmed/srv_mismatch": "mismatch",

  "locked/cancel": "cancelled",
  "locked/srv_paid": "paid",
  "locked/srv_paid_late": "paid_late",
  "locked/srv_pending": "locked",
  "locked/srv_expired": "unpaid",
  "locked/srv_unknown": "unpaid",
  "locked/srv_mismatch": "mismatch",

  "cancelled/srv_paid": "mismatch",
  "cancelled/srv_paid_late": "mismatch",
  "cancelled/srv_pending": "cancelled",
  "cancelled/srv_expired": "cancelled",
  "cancelled/srv_unknown": "cancelled",
  "cancelled/srv_mismatch": "mismatch",

  "expired/confirm": "confirmed",
  "expired/fail": "expired",
  "expired/lock": "locked",
  "expired/cancel": "cancelled",
  "expired/srv_paid": "paid",
  "expired/srv_paid_late": "paid_late",
  "expired/srv_pending": "expired",
  "expired/srv_expired": "unpaid",
  "expired/srv_unknown": "unpaid",
  "expired/srv_mismatch": "mismatch",

  "paid/srv_paid": "paid",
  "paid_late/srv_paid_late": "paid_late",

  "unpaid/srv_paid": "paid",
  "unpaid/srv_paid_late": "paid_late",
  "unpaid/srv_pending": "unpaid",
  "unpaid/srv_expired": "unpaid",
  "unpaid/srv_unknown": "unpaid",
  "unpaid/srv_mismatch": "mismatch",

  "mismatch/srv_mismatch": "mismatch",
};

test("the table covers 9 statuses and 11 events", () => {
  expect(STATUSES).toHaveLength(9);
  expect(EVENTS).toHaveLength(11);
});

test.each(STATUSES.flatMap((s) => EVENTS.map((e) => [s, e] as const)))("%s --%s-->", (s, e) => {
  expect(transition(s, e)).toBe(ALLOWED[`${s}/${e}`] ?? null);
});

test("a locked, cancelled, unpaid or mismatched sale can never become confirmed", () => {
  for (const s of ["locked", "cancelled", "unpaid", "mismatch", "paid", "paid_late", "confirmed"] as const) {
    expect(transition(s, "confirm")).toBeNull();
  }
});

test("only the server can move a sale to paid, paid_late, unpaid or mismatch", () => {
  for (const s of STATUSES)
    for (const e of ["confirm", "fail", "lock", "cancel", "expire"] as const) {
      expect(["paid", "paid_late", "unpaid", "mismatch"]).not.toContain(transition(s, e));
    }
});
