import type { Backend, DeviceRow } from "../repo";
import type { Sealer } from "../seal";
import { LnbitsBackend, parseLnbitsConnection } from "./lnbits";
import { looksLikeNwcUrl, NwcBackend, type NwcFactory } from "./nwc";
import { SandboxBackend } from "./sandbox";
import type { InvoiceBackend } from "./types";

export interface BackendDeps {
  sealer: Sealer;
  nwcFactory: NwcFactory;
  fetch: typeof fetch;
  now: () => number;
  /** Present only when the server runs with SANDBOX=1. */
  sandbox: SandboxBackend | null;
  allowMixed: boolean;
  /** Operator allowlists (anti-SSRF): LNbits host[:port] values and exact NWC relay URLs. */
  lnbitsAllowedHosts: string[];
  nwcAllowedRelays: string[];
  timeoutMs?: number;
}

const normRelay = (r: string) => r.trim().replace(/\/+$/, "").toLowerCase();

/** Every relay named in the connection must be on the allowlist. */
export function relaysAllowed(connection: string, allowed: string[]): boolean {
  // Parse only the query: the pubkey "host" is not a valid URL host when it is all digits.
  const qs = connection.indexOf("?");
  if (qs < 0) return false;
  const relays = new URLSearchParams(connection.slice(qs + 1)).getAll("relay");
  const ok = new Set(allowed.map(normRelay));
  return relays.length > 0 && relays.every((r) => ok.has(normRelay(r)));
}

export const connPurpose = (deviceId: string) => `connection:${deviceId}`;

/** One backend instance per device, built lazily from the sealed connection string. */
export class Backends {
  private cache = new Map<string, InvoiceBackend>();

  constructor(private deps: BackendDeps) {}

  forDevice(d: DeviceRow): InvoiceBackend {
    let b = this.cache.get(d.id);
    if (!b) {
      b = this.build(d.backend, d.backend === "sandbox" ? "" : this.deps.sealer.open(d.connSealed, connPurpose(d.id)));
      this.cache.set(d.id, b);
    }
    return b;
  }

  private build(kind: Backend, connection: string): InvoiceBackend {
    const { now, timeoutMs } = this.deps;
    if (kind === "sandbox") {
      if (!this.deps.sandbox) throw new Error("sandbox disabled");
      return this.deps.sandbox;
    }
    if (kind === "nwc") return new NwcBackend(connection, this.deps.nwcFactory, now, timeoutMs);
    const conn = parseLnbitsConnection(connection);
    if (!conn) throw new Error("bad lnbits connection");
    return new LnbitsBackend(conn, this.deps.fetch, now, timeoutMs);
  }

  /**
   * Enrollment check. Sandbox servers accept only sandbox devices unless JAAY_ALLOW_MIXED=1; real servers never
   * accept sandbox devices. NWC must pass the S1 permission rule; LNbits must open its wallet.
   */
  async acceptable(kind: Backend, connection: string): Promise<boolean> {
    const sandboxServer = this.deps.sandbox !== null;
    if (kind === "sandbox") return sandboxServer;
    if (sandboxServer && !this.deps.allowMixed) return false;
    try {
      if (kind === "nwc") {
        if (!looksLikeNwcUrl(connection) || !relaysAllowed(connection, this.deps.nwcAllowedRelays)) return false;
        const b = new NwcBackend(connection, this.deps.nwcFactory, this.deps.now, this.deps.timeoutMs);
        try {
          await b.check();
        } finally {
          b.close();
        }
        return true;
      }
      const conn = parseLnbitsConnection(connection);
      if (!conn || !this.deps.lnbitsAllowedHosts.includes(new URL(conn.url).host.toLowerCase())) return false;
      await new LnbitsBackend(conn, this.deps.fetch, this.deps.now, this.deps.timeoutMs).check();
      return true;
    } catch {
      return false;
    }
  }

  closeAll(): void {
    for (const b of this.cache.values()) b.close?.();
    this.cache.clear();
  }
}
