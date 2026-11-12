import { describe, expect, it } from 'vitest';
import { RenderTracker } from '../../../src/benchmark/render-tracker';

function sentAtFrom(times: Record<number, number>): (index: number) => number | undefined {
  return (index) => times[index];
}

describe('RenderTracker', () => {
  it('starts with nothing visible and no latencies', () => {
    const tracker = new RenderTracker(sentAtFrom({}));

    expect(tracker.visible).toBe(0);
    expect(tracker.latency().count).toBe(0);
  });

  it('times every event a render newly shows against the time it was sent', () => {
    const tracker = new RenderTracker(sentAtFrom({ 1: 1000, 2: 1010, 3: 1020 }));

    tracker.rendered(3, 1050);

    expect(tracker.visible).toBe(3);
    expect(tracker.latency()).toMatchObject({ count: 3, maxMs: 50, p50Ms: 40 });
  });

  it('times only the events beyond what an earlier render showed', () => {
    const tracker = new RenderTracker(sentAtFrom({ 1: 1000, 2: 1000, 3: 1000, 4: 1000 }));

    tracker.rendered(2, 1030);
    tracker.rendered(4, 1100);

    expect(tracker.visible).toBe(4);
    expect(tracker.latency()).toMatchObject({ count: 4, maxMs: 100 });
  });

  it('ignores a render that shows nothing new', () => {
    const tracker = new RenderTracker(sentAtFrom({ 1: 1000, 2: 1000 }));

    tracker.rendered(2, 1020);
    tracker.rendered(2, 5000);
    tracker.rendered(1, 5000);

    expect(tracker.visible).toBe(2);
    expect(tracker.latency()).toMatchObject({ count: 2, maxMs: 20 });
  });

  it('counts an event as visible even when it has no send time', () => {
    const tracker = new RenderTracker(sentAtFrom({ 1: 1000, 3: 1000 }));

    tracker.rendered(3, 1010);

    expect(tracker.visible).toBe(3);
    expect(tracker.latency().count).toBe(2);
  });
});
