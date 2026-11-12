import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runSoak } from '../benchmark/soak';
import { measureThroughput } from '../benchmark/throughput';

describe('benchmark harness', () => {
  it('measures parser throughput', () => {
    for (const format of ['ndjson', 'sse'] as const) {
      const result = measureThroughput({
        format,
        events: 10_000,
        eventBytes: 1024,
        chunkBytes: 16 * 1024,
      });

      expect(result.format).toBe(format);
      expect(result.events).toBe(10_000);
      expect(result.eventBytes).toBe(1024);
      expect(result.seconds).toBeGreaterThan(0);
      expect(result.eventsPerSecond).toBeGreaterThan(0);
    }
  });

  it('runs a short soak and reports memory and lag', async () => {
    const result = await runSoak({
      format: 'ndjson',
      rate: 200,
      seconds: 1,
      eventBytes: 256,
      sampleMs: 250,
    });

    expect(result.events).toBeGreaterThanOrEqual(150);
    expect(result.maxHeapBytes).toBeGreaterThan(0);
    expect(result.maxRssBytes).toBeGreaterThan(0);
    expect(Number.isFinite(result.lagP95Ms)).toBe(true);
    expect(result.lagMaxMs).toBeGreaterThanOrEqual(result.lagP95Ms);
    expect(result.spillBytes).toBeGreaterThan(0);
    expect(existsSync(result.spillDirectory)).toBe(false);
  });
});
