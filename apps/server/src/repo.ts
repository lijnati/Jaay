// Storage behind a small interface. SQLite via node:sqlite (built into Node 22.13+, no native build step).
import { DatabaseSync } from "node:sqlite";

export type Backend = "nwc" | "lnbits" | "sandbox";
export type SaleStatus = "created" | "quoted" | "invoiced" | "paid" | "expired" | "paid_late";

export interface DeviceRow {
  id: string;
  label: string;
  backend: Backend;
  connSealed: string;
  secretSealed: string;
  minXof: number;
  maxXof: number;
  createdAt: number;
}

export interface SaleRow {
  deviceId: string;
  sid: string;
  amountXof: number;
  status: SaleStatus;
  firstSeenAt: number;
  receiptHash: string;
  receiptSealed: string;
  quoteMsat: bigint | null;
  quoteRateMicro: bigint | null;
  quoteSource: string | null;
  quoteFetchedAt: number | null;
  quotedAt: number | null;
  quoteExpiresAt: number | null;
  invoice: string | null;
  paymentHash: string | null;
  invoiceExpiresAt: number | null;
  paidAt: number | null;
  nextCheckAt: number | null;
  checkFailures: number;
}

export interface Repo {
  insertDevice(d: DeviceRow): void;
  getDevice(id: string): DeviceRow | undefined;
  insertSale(s: SaleRow): void;
  getSale(deviceId: string, sid: string): SaleRow | undefined;
  getSaleByReceiptHash(hash: string): SaleRow | undefined;
  getSalesBySid(sid: string): SaleRow[];
  /** Compare-and-set on status: applies the patch only if the row is still in `from`. Returns whether it applied. */
  updateSale(deviceId: string, sid: string, from: SaleStatus, patch: Partial<SaleRow>): boolean;
  /** Sales whose invoice still needs a settlement check. */
  dueChecks(now: number, expiredSince: number, limit: number): SaleRow[];
  /** Settled sales of one device, newest first. */
  paidSales(deviceId: string): SaleRow[];
  /** Records a request nonce; false if this device already used it (replay). Expired nonces are purged. */
  useNonce(deviceId: string, nonce: string, expiresAt: number, now: number): boolean;
  close(): void;
}

const SALE_COLS: Record<keyof SaleRow, string> = {
  deviceId: "device_id",
  sid: "sid",
  amountXof: "amount_xof",
  status: "status",
  firstSeenAt: "first_seen_at",
  receiptHash: "receipt_hash",
  receiptSealed: "receipt_sealed",
  quoteMsat: "quote_msat",
  quoteRateMicro: "quote_rate_micro",
  quoteSource: "quote_source",
  quoteFetchedAt: "quote_fetched_at",
  quotedAt: "quoted_at",
  quoteExpiresAt: "quote_expires_at",
  invoice: "invoice",
  paymentHash: "payment_hash",
  invoiceExpiresAt: "invoice_expires_at",
  paidAt: "paid_at",
  nextCheckAt: "next_check_at",
  checkFailures: "check_failures",
};
const BIGINT_FIELDS = new Set<keyof SaleRow>(["quoteMsat", "quoteRateMicro"]);

type Sql = string | number | null;
const toSql = (k: keyof SaleRow, v: unknown): Sql => (v === null || v === undefined ? null : BIGINT_FIELDS.has(k) ? String(v) : (v as Sql));

function rowToSale(r: Record<string, unknown>): SaleRow {
  const out: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(SALE_COLS) as [keyof SaleRow, string][]) {
    const v = r[col];
    out[k] = BIGINT_FIELDS.has(k) ? (v === null ? null : BigInt(v as string)) : v;
  }
  return out as unknown as SaleRow;
}

export class SqliteRepo implements Repo {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, backend TEXT NOT NULL,
        conn_sealed TEXT NOT NULL, secret_sealed TEXT NOT NULL,
        min_xof INTEGER NOT NULL, max_xof INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sales (
        device_id TEXT NOT NULL REFERENCES devices(id), sid TEXT NOT NULL,
        amount_xof INTEGER NOT NULL, status TEXT NOT NULL, first_seen_at INTEGER NOT NULL,
        receipt_hash TEXT NOT NULL UNIQUE, receipt_sealed TEXT NOT NULL,
        quote_msat TEXT, quote_rate_micro TEXT, quote_source TEXT, quote_fetched_at INTEGER,
        quoted_at INTEGER, quote_expires_at INTEGER,
        invoice TEXT, payment_hash TEXT, invoice_expires_at INTEGER, paid_at INTEGER,
        next_check_at INTEGER, check_failures INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (device_id, sid)
      );
      CREATE INDEX IF NOT EXISTS sales_due ON sales (status, next_check_at);
      CREATE INDEX IF NOT EXISTS sales_sid ON sales (sid);
      CREATE TABLE IF NOT EXISTS nonces (
        device_id TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL,
        PRIMARY KEY (device_id, nonce)
      );
    `);
  }

  insertDevice(d: DeviceRow) {
    this.db
      .prepare(
        "INSERT INTO devices (id,label,backend,conn_sealed,secret_sealed,min_xof,max_xof,created_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(d.id, d.label, d.backend, d.connSealed, d.secretSealed, d.minXof, d.maxXof, d.createdAt);
  }

  getDevice(id: string): DeviceRow | undefined {
    const r = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as
      | { id: string; label: string; backend: Backend; conn_sealed: string; secret_sealed: string; min_xof: number; max_xof: number; created_at: number }
      | undefined;
    if (!r) return undefined;
    return {
      id: r.id,
      label: r.label,
      backend: r.backend,
      connSealed: r.conn_sealed,
      secretSealed: r.secret_sealed,
      minXof: r.min_xof,
      maxXof: r.max_xof,
      createdAt: r.created_at,
    };
  }

  insertSale(s: SaleRow) {
    const keys = Object.keys(SALE_COLS) as (keyof SaleRow)[];
    this.db
      .prepare(`INSERT INTO sales (${keys.map((k) => SALE_COLS[k]).join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
      .run(...keys.map((k) => toSql(k, s[k])));
  }

  getSale(deviceId: string, sid: string) {
    const r = this.db.prepare("SELECT * FROM sales WHERE device_id = ? AND sid = ?").get(deviceId, sid);
    return r ? rowToSale(r) : undefined;
  }

  getSaleByReceiptHash(hash: string) {
    const r = this.db.prepare("SELECT * FROM sales WHERE receipt_hash = ?").get(hash);
    return r ? rowToSale(r) : undefined;
  }

  getSalesBySid(sid: string) {
    return this.db.prepare("SELECT * FROM sales WHERE sid = ?").all(sid).map(rowToSale);
  }

  updateSale(deviceId: string, sid: string, from: SaleStatus, patch: Partial<SaleRow>): boolean {
    const keys = (Object.keys(patch) as (keyof SaleRow)[]).filter((k) => k !== "deviceId" && k !== "sid");
    if (keys.length === 0) return false;
    const r = this.db
      .prepare(`UPDATE sales SET ${keys.map((k) => `${SALE_COLS[k]} = ?`).join(",")} WHERE device_id = ? AND sid = ? AND status = ?`)
      .run(...keys.map((k) => toSql(k, patch[k])), deviceId, sid, from);
    return Number(r.changes) === 1;
  }

  dueChecks(now: number, expiredSince: number, limit: number) {
    return this.db
      .prepare(
        `SELECT * FROM sales WHERE payment_hash IS NOT NULL AND next_check_at <= ?
         AND (status = 'invoiced' OR (status = 'expired' AND invoice_expires_at >= ?))
         ORDER BY next_check_at LIMIT ?`,
      )
      .all(now, expiredSince, limit)
      .map(rowToSale);
  }

  paidSales(deviceId: string) {
    // shortcut: loads every settled row of the device; add SQL aggregation if a device ever has tens of thousands of sales
    return this.db
      .prepare("SELECT * FROM sales WHERE device_id = ? AND status IN ('paid','paid_late') ORDER BY paid_at DESC, sid")
      .all(deviceId)
      .map(rowToSale);
  }

  useNonce(deviceId: string, nonce: string, expiresAt: number, now: number): boolean {
    this.db.prepare("DELETE FROM nonces WHERE expires_at < ?").run(now);
    const r = this.db.prepare("INSERT OR IGNORE INTO nonces (device_id, nonce, expires_at) VALUES (?,?,?)").run(deviceId, nonce, expiresAt);
    return Number(r.changes) === 1;
  }

  close() {
    this.db.close();
  }
}
