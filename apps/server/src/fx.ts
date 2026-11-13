// FX: EUR per BTC from two exchanges, XOF via the fixed euro peg. No floats anywhere in the money path.
import { errName, type Logger } from "./log";

/** 655.957 XOF per EUR, in thousandths. Fixed peg since 1 January 1999. Source: BCEAO, https://www.bceao.int/en/content/history-cfa-franc */
export const XOF_PER_EUR_MILLI = 655_957n;
export const POLL_MS = 60_000;
export const STALE_MS = 10 * 60_000;
export const QUOTE_LOCK_MS = 120_000;
/** Refuse quotes when the two sources differ by more than this (as 1/n): 50 means 2 percent. */
const DIVERGENCE_DIVISOR = 50n;
// Sanity bounds on EUR per BTC, in micro-EUR: 1,000 EUR to 10,000,000 EUR.
const MIN_RATE_MICRO = 1_000n * 1_000_000n;
const MAX_RATE_MICRO = 10_000_000n * 1_000_000n;

export type FxSource = "kraken" | "coinbase";
export interface Rate {
  eurPerBtcMicro: bigint;
  source: FxSource;
  fetchedAt: number;
}
export interface Quote extends Rate {
  msat: bigint;
  quotedAt: number;
  expiresAt: number;
}

/** "62347.80000" -> 62347800000n (micro-EUR). Digits beyond 6 decimals are truncated. Strict format. */
export function parseDecimalMicro(text: unknown): bigint | null {
  if (typeof text !== "string" || !/^\d{1,12}(\.\d{1,18})?$/.test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  return BigInt(whole!) * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
}

/**
 * msat for an XOF amount, rounded UP to a whole sat.
 * XOF per BTC = (eurMicro / 1e6) * (655957 / 1e3), so sats = amountXof * 1e8 / that = amountXof * 1e17 / (eurMicro * 655957).
 */
export function msatForXof(amountXof: number, eurPerBtcMicro: bigint): bigint {
  if (!Number.isSafeInteger(amountXof) || amountXof <= 0) throw new RangeError("amount");
  if (eurPerBtcMicro <= 0n) throw new RangeError("rate");
  const num = BigInt(amountXof) * 10n ** 17n;
  const den = eurPerBtcMicro * XOF_PER_EUR_MILLI;
  const sats = (num + den - 1n) / den;
  return sats * 1000n;
}

export function diverges(a: bigint, b: bigint): boolean {
  const lo = a < b ? a : b;
  const diff = a > b ? a - b : b - a;
  return diff * DIVERGENCE_DIVISOR > lo;
}

export interface FxDeps {
  fetch: typeof fetch;
  now: () => number;
  log: Logger;
  timeoutMs?: number;
}

export class FxService {
  private last: Rate | null = null;
  private divergent = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private deps: FxDeps) {}

  private async getJson(url: string): Promise<unknown> {
    const res = await this.deps.fetch(url, { signal: AbortSignal.timeout(this.deps.timeoutMs ?? 5000), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return res.json();
  }

  private async kraken(): Promise<bigint | null> {
    const j = (await this.getJson("https://api.kraken.com/0/public/Ticker?pair=XBTEUR")) as {
      error?: unknown[];
      result?: { XXBTZEUR?: { c?: unknown[] } };
    };
    if (j.error && j.error.length > 0) return null;
    return parseDecimalMicro(j.result?.XXBTZEUR?.c?.[0]);
  }

  private async coinbase(): Promise<bigint | null> {
    const j = (await this.getJson("https://api.exchange.coinbase.com/products/BTC-EUR/ticker")) as { price?: unknown };
    return parseDecimalMicro(j.price);
  }

  private async attempt(name: FxSource, fn: () => Promise<bigint | null>): Promise<bigint | null> {
    try {
      const v = await fn();
      if (v === null || v < MIN_RATE_MICRO || v > MAX_RATE_MICRO) {
        this.deps.log.warn("fx_bad_value", { source: name });
        return null;
      }
      return v;
    } catch (e) {
      this.deps.log.warn("fx_fetch_failed", { source: name, err: errName(e) });
      return null;
    }
  }

  /** One poll: both sources in parallel. Primary Kraken, fallback Coinbase, refuse on divergence. */
  async poll(): Promise<void> {
    const [k, c] = await Promise.all([this.attempt("kraken", () => this.kraken()), this.attempt("coinbase", () => this.coinbase())]);
    const now = this.deps.now();
    if (k !== null && c !== null && diverges(k, c)) {
      this.divergent = true;
      this.deps.log.warn("fx_divergent", {});
      return;
    }
    if (k !== null) this.last = { eurPerBtcMicro: k, source: "kraken", fetchedAt: now };
    else if (c !== null) this.last = { eurPerBtcMicro: c, source: "coinbase", fetchedAt: now };
    else return; // keep the last good rate; staleness is checked at quote time
    this.divergent = false;
  }

  /** Usable rate, or null when divergent, never fetched, or older than 10 minutes. */
  current(): Rate | null {
    if (this.divergent || !this.last) return null;
    if (this.deps.now() - this.last.fetchedAt > STALE_MS) return null;
    return this.last;
  }

  status(): "ok" | "unavailable" {
    return this.current() ? "ok" : "unavailable";
  }

  quote(amountXof: number): Quote | null {
    const r = this.current();
    if (!r) return null;
    const now = this.deps.now();
    return { ...r, msat: msatForXof(amountXof, r.eurPerBtcMicro), quotedAt: now, expiresAt: now + QUOTE_LOCK_MS };
  }

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
