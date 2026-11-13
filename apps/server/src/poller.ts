// Background settlement poller: finds sales whose invoice needs a check and runs SaleService.check with bounded
// concurrency. Per-sale backoff lives in the row (next_check_at), so a slow backend is not hammered.
import type { Logger } from "./log";
import { errName } from "./log";
import type { Repo } from "./repo";
import { LATE_WATCH_MS, type SaleService } from "./sales";

export class SettlementPoller {
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight = new Set<string>();
  private running = false;

  constructor(
    private repo: Repo,
    private sales: SaleService,
    private now: () => number,
    private log: Logger,
    private concurrency = 4,
    private batch = 32,
  ) {}

  /** One pass. Exposed for tests. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const now = this.now();
      const due = this.repo.dueChecks(now, now - LATE_WATCH_MS, this.batch).filter((s) => !this.inFlight.has(`${s.deviceId}:${s.sid}`));
      let i = 0;
      const worker = async () => {
        while (i < due.length) {
          const s = due[i++]!;
          const key = `${s.deviceId}:${s.sid}`;
          this.inFlight.add(key);
          try {
            await this.sales.check(s);
          } catch (e) {
            this.log.warn("poll_error", { err: errName(e) });
          } finally {
            this.inFlight.delete(key);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, due.length) }, worker));
      return due.length;
    } finally {
      this.running = false;
    }
  }

  start(intervalMs = 1000): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
