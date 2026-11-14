// Sale service: LNURL-pay request and callback, receipts, settlement checks.
// Every verification failure becomes the same SaleRejected, which the HTTP layer maps to one generic body (Hard rule 7).
import { createHash, randomBytes } from "node:crypto";
import {
  decodeSale,
  deriveConfirmCode,
  deriveKeys,
  MAX_TOKEN_CHARS,
  peekDeviceId,
  secretFromString,
  type DeviceKeys,
  type LimitOptions,
  type Sale,
} from "@jaay/protocol";
import type { Backends } from "./backends";
import { spendMethods } from "./backends/nwc";
import type { SandboxBackend } from "./backends/sandbox";
import { invoiceMatches, type Network } from "./bolt11";
import type { FxService } from "./fx";
import { errName, hashId, type Logger } from "./log";
import type { DeviceRow, Repo, SaleRow } from "./repo";
import type { Sealer } from "./seal";
import { transition } from "./state";

export const SALE_WINDOW_MS = 15 * 60_000;
export const INVOICE_EXPIRY_SEC = 600;
/** Unpaid invoices are declared expired this long after their expiry, to absorb in-flight HTLCs. */
export const EXPIRY_GRACE_MS = 30_000;
/** Expired invoices are still checked this long, so late payments become paid_late. */
export const LATE_WATCH_MS = 24 * 3600_000;
const FIRST_CHECK_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;
const LATE_CHECK_MS = 5 * 60_000;

export class SaleRejected extends Error {
  constructor() {
    super("rejected");
  }
}

export const secretPurpose = (deviceId: string) => `device-secret:${deviceId}`;
const receiptPurpose = (deviceId: string, sid: string) => `receipt:${deviceId}:${sid}`;
export const receiptHash = (rt: string) => createHash("sha256").update(rt).digest("hex");
const RECEIPT_RE = /^[A-Za-z0-9_-]{22}$/;

export interface PayRequest {
  tag: "payRequest";
  callback: string;
  minSendable: number;
  maxSendable: number;
  metadata: string;
  commentAllowed: 0;
}
export interface CallbackResponse {
  pr: string;
  routes: [];
  successAction: { tag: "url"; url: string; description: string };
}
export type ReceiptView =
  | { kind: "generic" }
  | { kind: "pending"; label: string }
  | { kind: "paid"; amountXof: number; paidAt: number; code: string; late: boolean; label: string; msat: string; fixedRate: boolean };

export interface ReconcileEntry {
  sid: string;
  amountXof: number;
  /** Device clock, advisory only (Hard rule 9). */
  claimedAt: number;
  /** The merchant typed a correct code on the device. */
  confirmed: boolean;
}
export interface ReconcileResult {
  sid: string;
  status: "paid" | "paid_late" | "pending" | "expired" | "unknown";
  amountXof: number | null;
  settledAt: string | null;
  mismatch: boolean;
}

export interface SaleDeps {
  repo: Repo;
  sealer: Sealer;
  fx: FxService;
  backends: Backends;
  sandbox: SandboxBackend | null;
  now: () => number;
  log: Logger;
  baseUrl: string;
  network: Network;
  /** Injected so tests can prove an over-long token never reaches the decoder. */
  decode?: (token: string, keys: DeviceKeys, opts: LimitOptions) => Promise<Sale>;
}

export class SaleService {
  private keyCache = new Map<string, Promise<DeviceKeys>>();
  private locks = new Map<string, Promise<unknown>>();
  // Keys for unknown devices, so that path also runs a full decrypt (similar timing, Hard rule 7).
  private decoyKeys = deriveKeys(randomBytes(32));
  private decode: NonNullable<SaleDeps["decode"]>;

  constructor(private d: SaleDeps) {
    this.decode = d.decode ?? decodeSale;
  }

  keys(device: DeviceRow): Promise<DeviceKeys> {
    let k = this.keyCache.get(device.id);
    if (!k) {
      k = deriveKeys(secretFromString(this.d.sealer.open(device.secretSealed, secretPurpose(device.id))));
      this.keyCache.set(device.id, k);
    }
    return k;
  }

  /** Device keys, or decoy keys for an unknown device so both paths do the same crypto work. */
  keysOrDecoy(device: DeviceRow | undefined): Promise<DeviceKeys> {
    return device ? this.keys(device) : this.decoyKeys;
  }

  /** Serializes work per sale inside this process (single-instance deployment, documented). */
  private async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  private async resolve(token: unknown): Promise<{ device: DeviceRow; sale: Sale }> {
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_CHARS) throw new SaleRejected();
    const id = peekDeviceId(token);
    const device = id ? this.d.repo.getDevice(id) : undefined;
    const keys = await this.keysOrDecoy(device);
    let sale: Sale;
    try {
      sale = await this.decode(token, keys, device ? { minAmountXof: device.minXof, maxAmountXof: device.maxXof } : {});
    } catch {
      throw new SaleRejected();
    }
    if (!device) throw new SaleRejected();
    return { device, sale };
  }

  private receiptToken(row: SaleRow): string {
    return this.d.sealer.open(row.receiptSealed, receiptPurpose(row.deviceId, row.sid));
  }

  private receiptUrl(row: SaleRow): string {
    return `${this.d.baseUrl}/r/${this.receiptToken(row)}`;
  }

  /** LUD-06 metadata. The text/plain entry is never empty and carries the receipt URL (S5 fallback). */
  metadata(row: SaleRow, device: DeviceRow): string {
    const tag = device.backend === "sandbox" ? "[SANDBOX] " : "";
    const rate = row.quoteSource === "fixed-demo" ? " Taux de demo fixe / fixed demo rate." : "";
    return JSON.stringify([["text/plain", `${tag}Jaay: ${row.amountXof} XOF.${rate} Recu / receipt: ${this.receiptUrl(row)}`]]);
  }

  private payRequest(token: string, row: SaleRow, device: DeviceRow): PayRequest {
    const msat = Number(row.quoteMsat);
    return {
      tag: "payRequest",
      callback: `${this.d.baseUrl}/lnurlp/cb?p=${encodeURIComponent(token)}`,
      minSendable: msat,
      maxSendable: msat,
      metadata: this.metadata(row, device),
      commentAllowed: 0,
    };
  }

  private callbackResponse(row: SaleRow, device: DeviceRow): CallbackResponse {
    const tag = device.backend === "sandbox" ? " [SANDBOX]" : "";
    return {
      pr: row.invoice!,
      routes: [],
      successAction: { tag: "url", url: this.receiptUrl(row), description: `Recu Jaay / Jaay receipt${tag}` },
    };
  }

  private newSale(device: DeviceRow, sale: Sale, now: number): SaleRow {
    const rt = randomBytes(16).toString("base64url"); // 128-bit, independent of the sid
    return {
      deviceId: device.id,
      sid: sale.sid,
      amountXof: sale.amountXof,
      status: "created",
      firstSeenAt: now,
      receiptHash: receiptHash(rt),
      receiptSealed: this.d.sealer.seal(rt, receiptPurpose(device.id, sale.sid)),
      quoteMsat: null,
      quoteRateMicro: null,
      quoteSource: null,
      quoteFetchedAt: null,
      quotedAt: null,
      quoteExpiresAt: null,
      invoice: null,
      paymentHash: null,
      invoiceExpiresAt: null,
      paidAt: null,
      nextCheckAt: null,
      checkFailures: 0,
      demo: 0,
    };
  }

  /** GET /lnurlp. */
  async handlePayRequest(token: unknown): Promise<PayRequest> {
    const { device, sale } = await this.resolve(token);
    const t = token as string;
    return this.locked(`${device.id}:${sale.sid}`, async () => {
      const now = this.d.now();
      let row = this.d.repo.getSale(device.id, sale.sid);
      if (!row) {
        row = this.newSale(device, sale, now);
        this.d.repo.insertSale(row);
      }
      if (row.status === "invoiced") {
        if (now >= row.invoiceExpiresAt!) throw new SaleRejected();
        return this.payRequest(t, row, device); // same amount as the pending invoice
      }
      if (row.status === "quoted" && now < row.quoteExpiresAt!) return this.payRequest(t, row, device);
      if (row.status !== "created" && row.status !== "quoted") throw new SaleRejected(); // paid, paid_late, expired
      if (now > row.firstSeenAt + SALE_WINDOW_MS) {
        this.d.repo.updateSale(device.id, sale.sid, row.status, { status: transition(row.status, "expire")! });
        throw new SaleRejected();
      }
      const q = this.d.fx.quote(row.amountXof);
      if (!q) {
        this.d.log.warn("quote_refused_fx", { dev: hashId(device.id) });
        throw new SaleRejected();
      }
      const patch: Partial<SaleRow> = {
        status: transition(row.status, "quote")!,
        quoteMsat: q.msat,
        quoteRateMicro: q.eurPerBtcMicro,
        quoteSource: q.source,
        quoteFetchedAt: q.fetchedAt,
        quotedAt: q.quotedAt,
        quoteExpiresAt: q.expiresAt,
      };
      if (!this.d.repo.updateSale(device.id, sale.sid, row.status, patch)) throw new SaleRejected();
      this.d.log.info("sale_quoted", { dev: hashId(device.id), sale: hashId(sale.sid), source: q.source });
      return this.payRequest(t, { ...row, ...patch }, device);
    });
  }

  /** GET /lnurlp/cb. The amount must equal the locked quote exactly. */
  async handleCallback(token: unknown, amount: unknown): Promise<CallbackResponse> {
    const { device, sale } = await this.resolve(token);
    if (typeof amount !== "string" || !/^[1-9]\d{0,15}$/.test(amount)) throw new SaleRejected();
    const msat = BigInt(amount);
    return this.locked(`${device.id}:${sale.sid}`, async () => {
      const now = this.d.now();
      const row = this.d.repo.getSale(device.id, sale.sid);
      if (!row || row.quoteMsat === null || msat !== row.quoteMsat) throw new SaleRejected();
      if (row.status === "invoiced") {
        if (now >= row.invoiceExpiresAt!) throw new SaleRejected();
        return this.callbackResponse(row, device); // idempotent: same invoice
      }
      if (row.status !== "quoted" || now >= row.quoteExpiresAt!) throw new SaleRejected();
      let inv;
      const descriptionHashHex = createHash("sha256").update(this.metadata(row, device)).digest("hex");
      try {
        inv = await this.d.backends.forDevice(device).makeInvoice({ msat, descriptionHashHex, expirySec: INVOICE_EXPIRY_SEC });
      } catch (e) {
        this.d.log.warn("invoice_failed", { dev: hashId(device.id), err: errName(e) });
        throw new SaleRejected();
      }
      // A5: the wallet must return exactly what was asked for, on our network, not already expired.
      if (!invoiceMatches(inv.invoice, { network: this.d.network, msat, paymentHash: inv.paymentHash, descriptionHashHex, now })) {
        this.d.log.warn("invoice_rejected", { dev: hashId(device.id) });
        throw new SaleRejected();
      }
      const patch: Partial<SaleRow> = {
        status: transition("quoted", "invoice")!,
        invoice: inv.invoice,
        paymentHash: inv.paymentHash,
        invoiceExpiresAt: inv.expiresAt,
        nextCheckAt: now + FIRST_CHECK_MS,
        checkFailures: 0,
      };
      if (!this.d.repo.updateSale(device.id, sale.sid, "quoted", patch)) throw new SaleRejected();
      this.d.log.info("invoice_created", { dev: hashId(device.id), sale: hashId(sale.sid) });
      return this.callbackResponse({ ...row, ...patch }, device);
    });
  }

  /** One settlement check for a sale with an invoice. Never throws. */
  async check(row: SaleRow): Promise<SaleRow> {
    const device = this.d.repo.getDevice(row.deviceId);
    if (!device || !row.paymentHash) return row;
    return this.locked(`${row.deviceId}:${row.sid}`, async () => {
      const cur = this.d.repo.getSale(row.deviceId, row.sid) ?? row;
      if (cur.status !== "invoiced" && cur.status !== "expired") return cur;
      const now = this.d.now();
      let state: "pending" | "settled";
      try {
        state = (await this.d.backends.forDevice(device).lookupInvoice(cur.paymentHash!)).state;
      } catch (e) {
        const failures = cur.checkFailures + 1;
        this.d.repo.updateSale(cur.deviceId, cur.sid, cur.status, { checkFailures: failures, nextCheckAt: now + Math.min(FIRST_CHECK_MS * 2 ** failures, MAX_BACKOFF_MS) });
        this.d.log.warn("lookup_failed", { dev: hashId(device.id), err: errName(e) });
        return cur;
      }
      let patch: Partial<SaleRow>;
      if (state === "settled") {
        patch = { status: transition(cur.status, "settle")!, paidAt: now, nextCheckAt: null };
        this.d.log.info(cur.status === "expired" ? "sale_paid_late" : "sale_paid", { dev: hashId(device.id), sale: hashId(cur.sid) });
      } else if (cur.status === "invoiced" && now > cur.invoiceExpiresAt! + EXPIRY_GRACE_MS) {
        patch = { status: "expired", nextCheckAt: now + LATE_CHECK_MS, checkFailures: 0 };
      } else if (cur.status === "expired") {
        patch = { nextCheckAt: now + LATE_CHECK_MS };
      } else {
        const n = cur.checkFailures + 1;
        patch = { checkFailures: n, nextCheckAt: now + Math.min(FIRST_CHECK_MS * 2 ** Math.min(n, 4), MAX_BACKOFF_MS) };
      }
      this.d.repo.updateSale(cur.deviceId, cur.sid, cur.status, patch);
      return { ...cur, ...patch };
    });
  }

  /** GET /r/:rt and its JSON twin. The confirm code exists only in the "paid" view. */
  async receipt(rt: unknown): Promise<ReceiptView> {
    if (typeof rt !== "string" || !RECEIPT_RE.test(rt)) return { kind: "generic" };
    let row = this.d.repo.getSaleByReceiptHash(receiptHash(rt));
    if (!row) return { kind: "generic" };
    if (row.status === "invoiced" && row.nextCheckAt !== null && this.d.now() >= row.nextCheckAt) row = await this.check(row);
    const device = this.d.repo.getDevice(row.deviceId)!;
    if (row.status === "paid" || row.status === "paid_late") {
      const code = await deriveConfirmCode(await this.keys(device), row.sid);
      return {
        kind: "paid",
        amountXof: row.amountXof,
        paidAt: row.paidAt!,
        code,
        late: row.status === "paid_late",
        label: device.label,
        msat: String(row.quoteMsat ?? 0n),
        fixedRate: row.quoteSource === "fixed-demo",
      };
    }
    if (row.status === "expired") return { kind: "generic" };
    return { kind: "pending", label: device.label };
  }

  /**
   * A2: what the server knows about a device's sales. Only this device's rows are visible; anything else is
   * "unknown". Never returns codes or receipt tokens. A due settlement check runs first, so answers are fresh.
   */
  async reconcile(device: DeviceRow, entries: ReconcileEntry[]): Promise<ReconcileResult[]> {
    const out: ReconcileResult[] = [];
    for (const e of entries) {
      let row = this.d.repo.getSale(device.id, e.sid);
      if (row?.status === "invoiced" && row.nextCheckAt !== null && this.d.now() >= row.nextCheckAt) row = await this.check(row);
      if (!row) {
        out.push({ sid: e.sid, status: "unknown", amountXof: null, settledAt: null, mismatch: e.confirmed });
        continue;
      }
      const settled = row.status === "paid" || row.status === "paid_late";
      const status = settled || row.status === "expired" ? row.status : "pending";
      out.push({
        sid: e.sid,
        status: status as ReconcileResult["status"],
        amountXof: row.amountXof,
        settledAt: settled && row.paidAt !== null ? new Date(row.paidAt).toISOString() : null,
        mismatch: row.amountXof !== e.amountXof || (e.confirmed && !settled),
      });
    }
    return out;
  }

  /**
   * SANDBOX demo data: paid sales for this device only, idempotent per sid, marked demo so unseed removes them.
   * Quoted at the current (fixed demo) rate. Returns how many were created and how many already existed.
   */
  seedDemo(device: DeviceRow, entries: { sid: string; amountXof: number; paidAt: number }[]): { created: number; existing: number } | null {
    let created = 0;
    let existing = 0;
    for (const e of entries) {
      if (this.d.repo.getSale(device.id, e.sid)) {
        existing++;
        continue;
      }
      const q = this.d.fx.quote(e.amountXof);
      if (!q) return null;
      const row = this.newSale(device, { deviceId: device.id, sid: e.sid, amountXof: e.amountXof }, e.paidAt);
      this.d.repo.insertSale({
        ...row,
        status: "paid",
        quoteMsat: q.msat,
        quoteRateMicro: q.eurPerBtcMicro,
        quoteSource: q.source,
        quoteFetchedAt: q.fetchedAt,
        quotedAt: e.paidAt,
        quoteExpiresAt: e.paidAt,
        paidAt: e.paidAt,
        demo: 1,
      });
      created++;
    }
    this.d.log.info("demo_seeded", { dev: hashId(device.id), created });
    return { created, existing };
  }

  /** A3: receive-only wallet view. Totals are server computed; the backend part degrades to "unavailable". */
  async walletSummary(device: DeviceRow) {
    const now = this.d.now();
    const dayStart = now - (now % 86_400_000); // UTC day; Dakar is UTC+0
    const paid = this.d.repo.paidSales(device.id);
    const total = (rows: SaleRow[]) => ({
      xof: rows.reduce((a, r) => a + r.amountXof, 0),
      msat: String(rows.reduce((a, r) => a + (r.quoteMsat ?? 0n), 0n)),
      count: rows.length,
    });
    let backend: { kind: string; label: string; available: boolean; spendMethods: string[] | null; balanceMsat: string | null; balanceNote: string | null };
    try {
      const info = await this.d.backends.forDevice(device).describe();
      const spend = spendMethods(info.methods);
      if (spend.length > 0) this.d.log.error("spend_method_detected", { dev: hashId(device.id), n: spend.length });
      backend = {
        kind: device.backend,
        label: info.label,
        available: true,
        spendMethods: spend,
        balanceMsat: info.balanceMsat === null ? null : String(info.balanceMsat),
        balanceNote: info.balanceMsat === null ? null : "Balance as reported by the backend wallet, not computed by Jaay",
      };
    } catch (e) {
      this.d.log.warn("describe_failed", { dev: hashId(device.id), err: errName(e) });
      backend = { kind: device.backend, label: device.backend, available: false, spendMethods: null, balanceMsat: null, balanceNote: null };
    }
    return {
      receiveOnly: backend.spendMethods === null || backend.spendMethods.length === 0,
      backend,
      totals: { today: total(paid.filter((r) => (r.paidAt ?? 0) >= dayStart)), allTime: total(paid) },
      recent: paid.slice(0, 50).map((r) => ({ sid: r.sid.slice(0, 6), amountXof: r.amountXof, paidAt: new Date(r.paidAt!).toISOString(), status: r.status })),
      generatedAt: new Date(now).toISOString(),
    };
  }

  /**
   * SANDBOX only: mark the fake invoice of an invoiced sale as paid, then check it. `ref` is a sid (11 chars)
   * or a payment hash (64 hex), so the customer simulator can pay from the invoice alone, holding no secret.
   */
  async sandboxPay(ref: string): Promise<boolean> {
    if (!this.d.sandbox) return false;
    const rows = /^[0-9a-f]{64}$/.test(ref) ? [this.d.repo.getSaleByPaymentHash(ref)].filter((r): r is SaleRow => !!r) : this.d.repo.getSalesBySid(ref);
    for (const row of rows) {
      const device = this.d.repo.getDevice(row.deviceId);
      if (device?.backend !== "sandbox" || row.status !== "invoiced" || !row.paymentHash) continue;
      if (!this.d.sandbox.markPaid(row.paymentHash)) continue;
      const after = await this.check(row);
      return after.status === "paid" || after.status === "paid_late";
    }
    return false;
  }
}
