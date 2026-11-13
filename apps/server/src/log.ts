// Structured logging that cannot carry secrets (Hard rule 8).
// Field values are limited to short scalars and pass through scrub(); device ids and sids are logged only as hashes.
import { createHash } from "node:crypto";

export type LogSink = (line: string) => void;
type Field = string | number | boolean | null;
export interface Logger {
  info(event: string, fields?: Record<string, Field>): void;
  warn(event: string, fields?: Record<string, Field>): void;
  error(event: string, fields?: Record<string, Field>): void;
}

/** Short, non-reversible label for a device id or sid in logs. */
export function hashId(id: string): string {
  return createHash("sha256").update(`jaay-log:${id}`).digest("hex").slice(0, 8);
}

/** Removes anything that looks like a connection string, invoice, token, key or long identifier. */
export function scrub(text: string): string {
  return text
    .replace(/nostr\+walletconnect:\S*/gi, "[conn]")
    .replace(/\bln(?:bcrt|tbs|tb|bc)[0-9a-z]{8,}/gi, "[invoice]")
    .replace(/\b[a-z]+:\/\/\S*/gi, "[url]")
    .replace(/[A-Za-z0-9_+/=-]{16,}/g, "[redacted]")
    .slice(0, 200);
}

export function createLogger(sink: LogSink = (l) => process.stdout.write(`${l}\n`), now: () => number = Date.now): Logger {
  const write = (level: string, event: string, fields: Record<string, Field> = {}) => {
    const safe: Record<string, Field> = {};
    for (const [k, v] of Object.entries(fields)) safe[k] = typeof v === "string" ? scrub(v) : v;
    sink(JSON.stringify({ t: new Date(now()).toISOString(), level, event: scrub(event), ...safe }));
  };
  return {
    info: (e, f) => write("info", e, f),
    warn: (e, f) => write("warn", e, f),
    error: (e, f) => write("error", e, f),
  };
}

/** Name of an error without its message (messages from libraries may contain secrets). */
export function errName(e: unknown): string {
  const n = (e as { constructor?: { name?: string } })?.constructor?.name;
  return typeof n === "string" && /^[A-Za-z0-9_]{1,40}$/.test(n) ? n : "Error";
}

/**
 * Third-party code (notably @getalby/sdk) writes straight to console.* with error objects and event data.
 * Route every console call through the scrubbing logger, keeping only a scrubbed first string argument.
 */
export function installConsoleGuard(log: Logger): () => void {
  const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const saved = methods.map((m) => console[m]);
  for (const m of methods) {
    console[m] = (...args: unknown[]) => {
      const first = typeof args[0] === "string" ? args[0] : errName(args[0]);
      log.warn("lib_console", { method: m, msg: first.slice(0, 80) });
    };
  }
  return () => methods.forEach((m, i) => (console[m] = saved[i]!));
}
