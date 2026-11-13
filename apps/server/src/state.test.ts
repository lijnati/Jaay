import { expect, test } from "vitest";
import type { SaleStatus } from "./repo";
import { transition, type SaleEvent } from "./state";

const STATUSES: SaleStatus[] = ["created", "quoted", "invoiced", "paid", "expired", "paid_late"];
const EVENTS: SaleEvent[] = ["quote", "invoice", "settle", "expire"];

// Every (status, event) pair; anything not listed must be refused.
const ALLOWED: Record<string, SaleStatus> = {
  "created/quote": "quoted",
  "created/expire": "expired",
  "quoted/quote": "quoted",
  "quoted/invoice": "invoiced",
  "quoted/expire": "expired",
  "invoiced/settle": "paid",
  "invoiced/expire": "expired",
  "expired/settle": "paid_late",
};

test.each(STATUSES.flatMap((s) => EVENTS.map((e) => [s, e] as const)))("%s --%s-->", (s, e) => {
  expect(transition(s, e)).toBe(ALLOWED[`${s}/${e}`] ?? null);
});

test("paid and paid_late are terminal; a settled sale can never be invoiced again", () => {
  for (const s of ["paid", "paid_late"] as const) for (const e of EVENTS) expect(transition(s, e)).toBeNull();
});
