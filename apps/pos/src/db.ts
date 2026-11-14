// IndexedDB storage. Stores: "kv" (config, device keys as non-extractable CryptoKeys, cached wallet summary)
// and "sales" (the ledger). The raw device secret is never written here (see enroll.ts).
import type { DeviceKeys } from "@jaay/protocol";
import type { LedgerStatus } from "./ledger";

export interface DeviceConfig {
  deviceId: string;
  baseUrl: string;
  minXof: number;
  maxXof: number;
  label: string;
  sandbox: boolean;
  /** Minutes a sale QR stays valid on the device. */
  saleWindowMin: number;
  enrolledAt: number;
}

export interface ServerView {
  status: "paid" | "paid_late" | "pending" | "expired" | "unknown";
  amountXof: number | null;
  settledAt: string | null;
  mismatch: boolean;
  at: number;
}

export interface SaleRec {
  sid: string;
  amountXof: number;
  createdAt: number;
  windowEndsAt: number;
  status: LedgerStatus;
  /** Confirm-code attempts, persisted before each attempt is evaluated. */
  attempts: number;
  confirmedAt?: number;
  /** The QR content (public: the token is encrypted). Kept so an open sale survives a reload. */
  qr: string;
  server?: ServerView;
  /** SANDBOX demo data (Settings > Load demo data); removable in one tap. */
  demo?: boolean;
  demoLabel?: string;
}

const DB_NAME = "jaay-pos";
let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("kv");
      r.result.createObjectStore("sales", { keyPath: "sid" }).createIndex("createdAt", "createdAt");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

async function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    // Resolve on commit, not on request success, so a write is durable before we act on it.
    tx.oncomplete = () => resolve(req.result as T);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const getConfig = () => run<DeviceConfig | undefined>("kv", "readonly", (s) => s.get("config"));
export const putConfig = (c: DeviceConfig) => run("kv", "readwrite", (s) => s.put(c, "config"));
export const getKeys = () => run<DeviceKeys | undefined>("kv", "readonly", (s) => s.get("keys"));
export const putKeys = (k: DeviceKeys) => run("kv", "readwrite", (s) => s.put(k, "keys"));
export const getKv = <T>(key: string) => run<T | undefined>("kv", "readonly", (s) => s.get(key));
export const putKv = (key: string, v: unknown) => run("kv", "readwrite", (s) => s.put(v, key));

export const getSale = (sid: string) => run<SaleRec | undefined>("sales", "readonly", (s) => s.get(sid));
export const putSale = (r: SaleRec) => run("sales", "readwrite", (s) => s.put(r));
export const deleteSale = (sid: string) => run("sales", "readwrite", (s) => s.delete(sid));
export const allSales = async () => (await run<SaleRec[]>("sales", "readonly", (s) => s.getAll())).sort((a, b) => b.createdAt - a.createdAt);

/** Wipe device: removes keys, config, cached data and the whole ledger. */
export async function wipe(): Promise<void> {
  await run("kv", "readwrite", (s) => s.clear());
  await run("sales", "readwrite", (s) => s.clear());
}

/** Tests only: forget the cached connection so a fresh IDBFactory is used. */
export function resetConnection(): void {
  dbp = null;
}
