import { generateDeviceSecret, newDeviceId, secretToString } from "@jaay/protocol";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { connPurpose, type Backends } from "./backends";
import type { FxService } from "./fx";
import { errName, hashId, type Logger } from "./log";
import { RateLimiter } from "./ratelimit";
import { pickLang, RECEIPT_CSP, renderReceipt } from "./receipt";
import type { Backend, Repo } from "./repo";
import { verifyDeviceRequest } from "./deviceauth";
import { secretPurpose, type ReconcileEntry, type SaleService } from "./sales";
import type { Sealer } from "./seal";

/** The one LNURL error body for every verification failure (Hard rule 7). */
export const GENERIC_LNURL_ERROR = { status: "ERROR", reason: "Invalid or expired sale" } as const;
export const LNURL_ERROR_STATUS = 400;
const MAX_URL = 2048;
const MAX_LABEL = 64;

export interface AppDeps {
  repo: Repo;
  sealer: Sealer;
  sales: SaleService;
  backends: Backends;
  fx: FxService;
  log: Logger;
  now: () => number;
  baseUrl: string;
  sandbox: boolean;
  /** Client IP for rate limiting. Defaults to the socket address (see main.ts). */
  clientIp: (c: Context) => string;
  limits?: Partial<Record<Bucket, [number, number]>>;
}
type Bucket = "lnurlp" | "cb" | "enroll" | "receipt" | "sandbox" | "device";
// [requests, window ms] per IP.
const DEFAULT_LIMITS: Record<Bucket, [number, number]> = {
  lnurlp: [60, 60_000],
  cb: [30, 60_000],
  enroll: [10, 3600_000],
  receipt: [60, 60_000],
  sandbox: [30, 60_000],
  device: [120, 60_000],
};
const MAX_RECONCILE = 200;
const SID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Strict shape check for a reconcile batch; null when anything is off. */
export function parseReconcile(body: unknown): ReconcileEntry[] | null {
  const sales = (body as { sales?: unknown } | null)?.sales;
  if (!Array.isArray(sales) || sales.length > MAX_RECONCILE) return null;
  const out: ReconcileEntry[] = [];
  for (const e of sales as Record<string, unknown>[]) {
    if (typeof e !== "object" || e === null) return null;
    const { sid, amountXof, claimedAt, confirmed } = e;
    if (typeof sid !== "string" || !SID_RE.test(sid)) return null;
    if (!Number.isSafeInteger(amountXof) || (amountXof as number) < 1 || (amountXof as number) > 0xffffffff) return null;
    if (!Number.isSafeInteger(claimedAt) || (claimedAt as number) < 0) return null;
    if (typeof confirmed !== "boolean") return null;
    out.push({ sid, amountXof: amountXof as number, claimedAt: claimedAt as number, confirmed });
  }
  return out;
}

export function createApp(d: AppDeps) {
  const app = new Hono();
  const limiters = Object.fromEntries(
    (Object.keys(DEFAULT_LIMITS) as Bucket[]).map((b) => {
      const [n, w] = d.limits?.[b] ?? DEFAULT_LIMITS[b];
      return [b, new RateLimiter(n, w, d.now)];
    }),
  ) as Record<Bucket, RateLimiter>;
  const allowed = (c: Context, b: Bucket) => limiters[b].allow(`${b}|${d.clientIp(c)}`);
  const sb = d.sandbox ? { sandbox: true } : {};

  app.use("*", async (c, next) => {
    if (c.req.url.length > MAX_URL) return c.text("URI too long", 414);
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    if (!c.res.headers.get("Cache-Control")) c.header("Cache-Control", "no-store");
    if (d.sandbox) c.header("X-Jaay-Sandbox", "1");
  });

  app.get("/healthz", (c) => c.json({ status: "ok", fx: d.fx.status(), ...sb }));

  // ---------- LNURL-pay (LUD-06): CORS * as wallets may call from web contexts ----------
  const lnurlCors = async (c: Context, next: () => Promise<void>) => {
    await next();
    c.header("Access-Control-Allow-Origin", "*");
  };
  app.options("/lnurlp", lnurlCors, (c) => c.body(null, 204));
  app.options("/lnurlp/cb", lnurlCors, (c) => c.body(null, 204));
  const lnurlFail = (c: Context, e?: unknown) => {
    if (e !== undefined && errName(e) !== "SaleRejected") d.log.warn("lnurl_error", { err: errName(e) });
    else d.log.info("sale_rejected", { route: c.req.path });
    return c.json({ ...GENERIC_LNURL_ERROR, ...sb }, LNURL_ERROR_STATUS);
  };
  const tooMany = (c: Context) => c.json({ status: "ERROR", reason: "Too many requests", ...sb }, 429);

  app.get("/lnurlp", lnurlCors, async (c) => {
    if (!allowed(c, "lnurlp")) return tooMany(c);
    try {
      return c.json({ ...(await d.sales.handlePayRequest(c.req.query("p"))), ...sb });
    } catch (e) {
      return lnurlFail(c, e);
    }
  });

  app.get("/lnurlp/cb", lnurlCors, async (c) => {
    if (!allowed(c, "cb")) return tooMany(c);
    try {
      return c.json({ ...(await d.sales.handleCallback(c.req.query("p"), c.req.query("amount"))), ...sb });
    } catch (e) {
      return lnurlFail(c, e);
    }
  });

  // ---------- Receipts: same generic answer for unknown, malformed and expired-unpaid ----------
  app.get("/r/:rt", async (c) => {
    c.header("Content-Security-Policy", RECEIPT_CSP);
    const lang = pickLang(c.req.header("accept-language"));
    if (!allowed(c, "receipt")) return c.html(renderReceipt({ kind: "generic" }, lang, d.sandbox), 429);
    const view = await d.sales.receipt(c.req.param("rt")).catch((e) => {
      d.log.warn("receipt_error", { err: errName(e) });
      return { kind: "generic" } as const;
    });
    return c.html(renderReceipt(view, lang, d.sandbox), view.kind === "generic" ? 404 : 200);
  });

  app.get("/api/receipt/:rt/status", async (c) => {
    if (!allowed(c, "receipt")) return c.json({ status: "ERROR", reason: "Too many requests", ...sb }, 429);
    const view = await d.sales.receipt(c.req.param("rt")).catch(() => ({ kind: "generic" }) as const);
    if (view.kind === "paid")
      return c.json({ status: "paid", amountXof: view.amountXof, paidAt: new Date(view.paidAt).toISOString(), code: view.code, late: view.late, ...sb });
    if (view.kind === "pending") return c.json({ status: "pending", ...sb });
    return c.json({ status: "expired", ...sb }, 404);
  });

  // ---------- Enrollment ----------
  app.post("/api/enroll", bodyLimit({ maxSize: 4096, onError: (c) => c.json({ error: "enrollment rejected", ...sb }, 413) }), async (c) => {
    if (!allowed(c, "enroll")) return c.json({ error: "too many requests", ...sb }, 429);
    const reject = () => c.json({ error: "enrollment rejected", ...sb }, 400);
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return reject();
    }
    const { label, backend, connection, minXof, maxXof } = body ?? {};
    const okLabel = typeof label === "string" && label.length >= 1 && label.length <= MAX_LABEL && /^[\p{L}\p{N} ._'-]+$/u.test(label);
    const okBackend = backend === "nwc" || backend === "lnbits" || backend === "sandbox";
    const okConn = typeof connection === "string" && connection.length <= 1024;
    const okLimits =
      Number.isSafeInteger(minXof) && Number.isSafeInteger(maxXof) && (minXof as number) >= 1 && (minXof as number) <= (maxXof as number) && (maxXof as number) <= 0xffffffff;
    if (!okLabel || !okBackend || !okConn || !okLimits) return reject();
    if (!(await d.backends.acceptable(backend as Backend, connection as string))) {
      d.log.info("enroll_rejected", { backend: backend as string });
      return reject();
    }
    const id = newDeviceId();
    const secret = secretToString(generateDeviceSecret());
    d.repo.insertDevice({
      id,
      label: label as string,
      backend: backend as Backend,
      connSealed: d.sealer.seal(backend === "sandbox" ? "" : (connection as string), connPurpose(id)),
      secretSealed: d.sealer.seal(secret, secretPurpose(id)),
      minXof: minXof as number,
      maxXof: maxXof as number,
      createdAt: d.now(),
    });
    d.log.info("device_enrolled", { dev: hashId(id), backend: backend as string });
    return c.json({ deviceId: id, deviceSecretB64u: secret, baseUrl: d.baseUrl, ...sb });
  });

  // ---------- Device-authenticated API (A1) ----------
  const unauthorized = (c: Context) => c.json({ error: "unauthorized", ...sb }, 401);
  const badRequest = (c: Context) => c.json({ error: "bad request", ...sb }, 400);
  /** Verifies the device signature over the raw body; returns the device and the parsed JSON body, or null. */
  const deviceRequest = async (c: Context) => {
    const body = new Uint8Array(await c.req.arrayBuffer());
    const device = await verifyDeviceRequest({ method: c.req.method, path: c.req.path, header: (n) => c.req.header(n), body }, d);
    if (!device) return null;
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(body));
    } catch {
      json = undefined;
    }
    return { device, json };
  };
  const deviceLimit = bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "bad request", ...sb }, 413) });

  app.post("/v1/sales/reconcile", deviceLimit, async (c) => {
    if (!allowed(c, "device")) return c.json({ error: "too many requests", ...sb }, 429);
    const r = await deviceRequest(c);
    if (!r) {
      d.log.info("device_auth_failed", { route: c.req.path });
      return unauthorized(c);
    }
    const entries = parseReconcile(r.json);
    if (!entries) return badRequest(c);
    const results = await d.sales.reconcile(r.device, entries);
    d.log.info("reconciled", { dev: hashId(r.device.id), n: entries.length });
    return c.json({ results, ...sb });
  });

  app.post("/v1/wallet/summary", deviceLimit, async (c) => {
    if (!allowed(c, "device")) return c.json({ error: "too many requests", ...sb }, 429);
    const r = await deviceRequest(c);
    if (!r) {
      d.log.info("device_auth_failed", { route: c.req.path });
      return unauthorized(c);
    }
    return c.json({ ...(await d.sales.walletSummary(r.device)), ...sb });
  });

  // ---------- SANDBOX only ----------
  if (d.sandbox) {
    app.post("/sandbox/pay/:sid", async (c) => {
      if (!allowed(c, "sandbox")) return c.json({ sandbox: true, status: "ERROR" }, 429);
      const ok = await d.sales.sandboxPay(c.req.param("sid"));
      return c.json({ sandbox: true, status: ok ? "paid" : "ERROR" }, ok ? 200 : 404);
    });
  }

  app.notFound((c) => c.json({ error: "not found", ...sb }, 404));
  app.onError((e, c) => {
    d.log.error("unhandled", { err: errName(e) });
    return c.json({ error: "internal error", ...sb }, 500);
  });
  return app;
}
