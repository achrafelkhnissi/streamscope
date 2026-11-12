export interface LongTaskSummary {
  count: number;
  maxMs: number;
  totalMs: number;
}

export class LongTaskRecorder {
  private previous: number | undefined;
  private readonly totals: LongTaskSummary = { count: 0, maxMs: 0, totalMs: 0 };

  constructor(private readonly options: { thresholdMs: number; intervalMs: number }) {}

  tick(now: number): void {
    if (this.previous !== undefined) {
      const blocked = now - this.previous - this.options.intervalMs;
      if (blocked > this.options.thresholdMs) {
        this.totals.count += 1;
        this.totals.maxMs = Math.max(this.totals.maxMs, blocked);
        this.totals.totalMs += blocked;
      }
    }
    this.previous = now;
  }

  summary(): LongTaskSummary {
    return { ...this.totals };
  }
}
