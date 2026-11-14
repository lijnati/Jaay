// Wires the server from a Config plus injectable edges (fetch, clock, NWC client, log sink, client IP).
import { serve } from "@hono/node-server";
import type { Context } from "hono";
import { createApp, type AppDeps } from "./app";
import { Backends } from "./backends";
import { sdkNwcFactory, type NwcFactory } from "./backends/nwc";
import { SandboxBackend } from "./backends/sandbox";
import type { Config } from "./config";
import { FxService } from "./fx";
import { createLogger, type LogSink } from "./log";
import { SettlementPoller } from "./poller";
import { SqliteRepo } from "./repo";
import { SaleService, type SaleDeps } from "./sales";
import { createSealer } from "./seal";

export const name = "@jaay/server";

/** Node HTTP limits: headers over 8 KB get 431, slow requests are cut off. */
export const SERVER_OPTIONS = { maxHeaderSize: 8192, requestTimeout: 15_000, headersTimeout: 10_000 };
export function listen(fetchHandler: (req: Request) => Response | Promise<Response>, port: number, hostname = "0.0.0.0") {
  return serve({ fetch: fetchHandler, port, hostname, serverOptions: SERVER_OPTIONS });
}

export interface Edges {
  fetch?: typeof fetch;
  now?: () => number;
  nwcFactory?: NwcFactory;
  logSink?: LogSink;
  clientIp?: (c: Context) => string;
  limits?: AppDeps["limits"];
  backendTimeoutMs?: number;
  decode?: SaleDeps["decode"];
}

export function buildServer(cfg: Config, edges: Edges = {}) {
  const now = edges.now ?? Date.now;
  const fetchFn = edges.fetch ?? fetch;
  const log = createLogger(edges.logSink, now);
  const repo = new SqliteRepo(cfg.dbPath);
  const sealer = createSealer(cfg.masterKey);
  const fx = new FxService({ fetch: fetchFn, now, log });
  const sandbox = cfg.sandbox ? new SandboxBackend(now) : null;
  const backends = new Backends({
    sealer,
    nwcFactory: edges.nwcFactory ?? sdkNwcFactory,
    fetch: fetchFn,
    now,
    sandbox,
    allowMixed: cfg.allowMixed,
    lnbitsAllowedHosts: cfg.lnbitsAllowedHosts,
    nwcAllowedRelays: cfg.nwcAllowedRelays,
    timeoutMs: edges.backendTimeoutMs,
  });
  const sales = new SaleService({ repo, sealer, fx, backends, sandbox, now, log, baseUrl: cfg.baseUrl, decode: edges.decode });
  const poller = new SettlementPoller(repo, sales, now, log);
  const app = createApp({
    repo,
    sealer,
    sales,
    backends,
    fx,
    log,
    now,
    baseUrl: cfg.baseUrl,
    sandbox: cfg.sandbox,
    enrollToken: cfg.enrollToken,
    clientIp: edges.clientIp ?? (() => "unknown"),
    limits: edges.limits,
  });
  return {
    app,
    repo,
    sales,
    fx,
    poller,
    sandbox,
    backends,
    log,
    close() {
      poller.stop();
      fx.stop();
      backends.closeAll();
      repo.close();
    },
  };
}
