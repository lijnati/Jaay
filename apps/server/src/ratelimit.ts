// Fixed-window rate limiter, per key (route bucket + client IP), in memory.
// shortcut: state is per process and resets on restart; move to a shared store if Jaay ever runs more than one instance.
export class RateLimiter {
  private hits = new Map<string, { start: number; n: number }>();

  constructor(
    private limit: number,
    private windowMs: number,
    private now: () => number,
    private maxKeys = 50_000,
  ) {}

  /** True when the request is allowed. */
  allow(key: string): boolean {
    const now = this.now();
    const h = this.hits.get(key);
    if (!h || now - h.start >= this.windowMs) {
      if (this.hits.size >= this.maxKeys) this.sweep(now);
      this.hits.set(key, { start: now, n: 1 });
      return true;
    }
    h.n++;
    return h.n <= this.limit;
  }

  private sweep(now: number) {
    for (const [k, h] of this.hits) if (now - h.start >= this.windowMs) this.hits.delete(k);
    // Still full: drop the oldest entries rather than grow without bound.
    if (this.hits.size >= this.maxKeys) [...this.hits.keys()].slice(0, this.maxKeys / 10).forEach((k) => this.hits.delete(k));
  }
}
