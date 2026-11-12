import { describe, expect, it } from 'vitest';
import { LatencyHistogram, sentAtOf } from '../../../src/benchmark/latency';

describe('LatencyHistogram', () => {
  it('reports zeros when nothing was recorded', () => {
    expect(new LatencyHistogram().summary()).toEqual({
      count: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
    });
  });

  it('uses nearest-rank percentiles over whole milliseconds', () => {
    const histogram = new LatencyHistogram();
    for (let ms = 1; ms <= 100; ms += 1) {
      histogram.record(ms);
    }

    expect(histogram.summary()).toEqual({
      count: 100,
      p50Ms: 50,
      p95Ms: 95,
      p99Ms: 99,
      maxMs: 100,
    });
  });

  it('floors fractions and clamps negative latencies to zero', () => {
    const histogram = new LatencyHistogram();
    histogram.record(-3);
    histogram.record(2.9);

    expect(histogram.count).toBe(2);
    expect(histogram.percentile(0.5)).toBe(0);
    expect(histogram.percentile(1)).toBe(2);
    expect(histogram.maxMs).toBe(2.9);
  });

  it('keeps the exact maximum beyond the histogram limit', () => {
    const histogram = new LatencyHistogram(100);
    histogram.record(250);

    expect(histogram.percentile(1)).toBe(100);
    expect(histogram.maxMs).toBe(250);
  });
});

describe('sentAtOf', () => {
  it.each([
    [{ sentAt: 1700000000000.5 }, 1700000000000.5],
    [{ sentAt: '1' }, undefined],
    [[1], undefined],
    [null, undefined],
    [undefined, undefined],
  ])('reads the server stamp of %j', (value, expected) => {
    expect(sentAtOf(value)).toBe(expected);
  });
});
