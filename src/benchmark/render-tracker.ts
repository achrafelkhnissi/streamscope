import { LatencyHistogram, type LatencySummary } from './latency';

export class RenderTracker {
  private readonly histogram = new LatencyHistogram();
  private shown = 0;

  constructor(private readonly sentAt: (index: number) => number | undefined) {}

  get visible(): number {
    return this.shown;
  }

  rendered(newest: number, now: number): void {
    for (let index = this.shown + 1; index <= newest; index += 1) {
      const sentAt = this.sentAt(index);
      if (sentAt !== undefined) {
        this.histogram.record(now - sentAt);
      }
    }
    this.shown = Math.max(this.shown, newest);
  }

  latency(): LatencySummary {
    return this.histogram.summary();
  }
}
