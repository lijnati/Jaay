// Reconcile: ask the server (POST /v1/sales/reconcile, device-signed) about every non-final sale and merge the
// answer through the ledger state machine. A batch is applied only after its whole response validates, so a
// failure leaves the ledger exactly as it was; retrying is always safe (server and merge are idempotent).
import type { DeviceKeys } from "@jaay/protocol";
import { devicePost } from "./auth";
import { allSales, putSale, type DeviceConfig, type SaleRec, type ServerView } from "./db";
import { isFinal, transition, type LedgerEvent } from "./ledger";

export const BATCH = 200;
const WINDOW_MS = 7 * 86_400_000;
const SERVER_STATUSES = new Set(["paid", "paid_late", "pending", "expired", "unknown"]);

export interface ServerResult {
  sid: string;
  status: ServerView["status"];
  amountXof: number | null;
  settledAt: string | null;
  mismatch: boolean;
}

/** Non-final sales from the last 7 days. */
export function toReconcile(sales: SaleRec[], now: number): SaleRec[] {
  return sales.filter((s) => !isFinal(s.status) && now - s.createdAt <= WINDOW_MS);
}

/** An amount the server disagrees with always wins; otherwise the server status decides. */
export function serverEvent(sale: SaleRec, r: ServerResult): LedgerEvent {
  if (r.amountXof !== null && r.amountXof !== sale.amountXof) return "srv_mismatch";
  return `srv_${r.status}` as LedgerEvent;
}

function valid(r: unknown, sid: string): r is ServerResult {
  const x = r as Record<string, unknown>;
  return (
    typeof x === "object" && x !== null && x.sid === sid && SERVER_STATUSES.has(x.status as string) &&
    (x.amountXof === null || Number.isSafeInteger(x.amountXof)) && (x.settledAt === null || typeof x.settledAt === "string") &&
    typeof x.mismatch === "boolean"
  );
}

/** Pure merge. Throws (and applies nothing) unless every result matches its sale, in order. */
export function applyResults(batch: SaleRec[], results: unknown, now: number): SaleRec[] {
  if (!Array.isArray(results) || results.length !== batch.length) throw new Error("bad reconcile response");
  batch.forEach((s, i) => {
    if (!valid(results[i], s.sid)) throw new Error("bad reconcile response");
  });
  return batch.map((s, i) => {
    const r = results[i] as ServerResult;
    const next = transition(s.status, serverEvent(s, r)) ?? s.status;
    return { ...s, status: next, server: { status: r.status, amountXof: r.amountXof, settledAt: r.settledAt, mismatch: r.mismatch, at: now } };
  });
}

export async function runReconcile(d: { fetchFn: typeof fetch; config: DeviceConfig; keys: DeviceKeys; now: number }): Promise<{ sent: number; updated: number }> {
  const pending = toReconcile(await allSales(), d.now);
  let updated = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const body = { sales: batch.map((s) => ({ sid: s.sid, amountXof: s.amountXof, claimedAt: s.createdAt, confirmed: s.status === "confirmed" })) };
    const res = await devicePost<{ results: unknown }>(d.fetchFn, d.config.baseUrl, d.config.deviceId, d.keys.auth, "/v1/sales/reconcile", body, d.now);
    const merged = applyResults(batch, res.results, d.now);
    for (const m of merged) await putSale(m);
    updated += merged.length;
  }
  return { sent: pending.length, updated };
}
