import { describe, expect, it } from 'vitest';
import { LongTaskRecorder } from '../../benchmark/view/long-tasks';

function run(ticks: number[]): ReturnType<LongTaskRecorder['summary']> {
  const recorder = new LongTaskRecorder({ thresholdMs: 50, intervalMs: 10 });
  for (const tick of ticks) {
    recorder.tick(tick);
  }
  return recorder.summary();
}

describe('LongTaskRecorder', () => {
  it('uses the first tick as the baseline', () => {
    expect(run([500])).toEqual({ count: 0, maxMs: 0, totalMs: 0 });
  });

  it('ignores ticks that arrive on time', () => {
    expect(run([0, 10, 20, 31])).toEqual({ count: 0, maxMs: 0, totalMs: 0 });
  });

  it('records the blocked time of a late tick', () => {
    expect(run([0, 10, 80])).toEqual({ count: 1, maxMs: 60, totalMs: 60 });
  });

  it('does not count a block of exactly the threshold', () => {
    expect(run([0, 10, 70]).count).toBe(0);
  });

  it('sums several long tasks', () => {
    expect(run([0, 100, 110, 300])).toEqual({ count: 2, maxMs: 180, totalMs: 270 });
  });
});
