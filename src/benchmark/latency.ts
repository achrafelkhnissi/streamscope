import type { JsonValue } from '../events/model';

export interface LatencySummary {
  count: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export class LatencyHistogram {
  private readonly buckets: Uint32Array;
  private total = 0;
  private largest = 0;

  constructor(private readonly limitMs = 10_000) {
    this.buckets = new Uint32Array(limitMs + 1);
  }

  get count(): number {
    return this.total;
  }

  get maxMs(): number {
    return this.largest;
  }

  record(ms: number): void {
    const clamped = Math.max(0, ms);
    const bucket = Math.min(this.limitMs, Math.floor(clamped));
    this.buckets[bucket] = (this.buckets[bucket] ?? 0) + 1;
    this.total += 1;
    this.largest = Math.max(this.largest, clamped);
  }

  percentile(fraction: number): number {
    const target = Math.ceil(this.total * fraction);
    let seen = 0;
    for (const [bucket, count] of this.buckets.entries()) {
      seen += count;
      if (count > 0 && seen >= target) {
        return bucket;
      }
    }
    return 0;
  }

  summary(): LatencySummary {
    return {
      count: this.total,
      p50Ms: this.percentile(0.5),
      p95Ms: this.percentile(0.95),
      p99Ms: this.percentile(0.99),
      maxMs: this.largest,
    };
  }
}

export function sentAtOf(value: JsonValue | undefined): number | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const sentAt = (value as { readonly [key: string]: JsonValue }).sentAt;
  return typeof sentAt === 'number' ? sentAt : undefined;
}
