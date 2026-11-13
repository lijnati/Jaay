// Entry point: `tsx src/main.ts` in dev, `node dist/server.mjs` in production.
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { ConfigError, loadConfig } from "./config";
import { buildServer, listen } from "./index";
import { createLogger, installConsoleGuard } from "./log";

const boot = createLogger();
let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  boot.error("config_invalid", { msg: e instanceof ConfigError ? e.message : "invalid configuration" });
  process.exit(1);
}

const clientIp = (c: Context): string => {
  if (cfg.trustProxy) {
    const xff = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (xff) return xff;
  }
  return getConnInfo(c).remote.address ?? "unknown";
};

const s = buildServer(cfg, { clientIp });
installConsoleGuard(s.log);
if (cfg.ephemeralMasterKey) s.log.warn("ephemeral_master_key", { note: "dev only, sealed secrets are lost on restart" });
s.fx.start();
s.poller.start();

const server = listen(s.app.fetch, cfg.port);
s.log.info("listening", { port: cfg.port, sandbox: cfg.sandbox, production: cfg.production });

const stop = () => {
  s.log.info("stopping", {});
  server.close();
  s.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
