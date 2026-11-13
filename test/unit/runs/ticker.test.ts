import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveTicker } from '../../../src/runs/ticker';

describe('LiveTicker', () => {
  let active = false;
  let ticks = 0;
  let ticker: LiveTicker;

  beforeEach(() => {
    vi.useFakeTimers();
    active = false;
    ticks = 0;
    ticker = new LiveTicker(
      () => active,
      () => {
        ticks += 1;
      },
    );
  });

  afterEach(() => {
    ticker.dispose();
    vi.useRealTimers();
  });

  it('ticks at once on a poke and starts no timer while nothing is active', () => {
    ticker.poke();
    vi.advanceTimersByTime(5000);

    expect(ticks).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ticks once a second while active, however often it is poked', () => {
    active = true;
    ticker.poke();
    ticker.poke();
    ticker.poke();
    const afterPokes = ticks;
    vi.advanceTimersByTime(3000);

    expect(ticks - afterPokes).toBe(3);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('stops its timer after one last tick once nothing is active', () => {
    active = true;
    ticker.poke();
    vi.advanceTimersByTime(1000);
    active = false;
    const before = ticks;
    vi.advanceTimersByTime(1000);

    expect(ticks - before).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(ticks - before).toBe(1);
  });

  it('starts again when poked after it stopped', () => {
    active = true;
    ticker.poke();
    active = false;
    vi.advanceTimersByTime(1000);
    active = true;
    ticker.poke();
    const before = ticks;
    vi.advanceTimersByTime(2000);

    expect(ticks - before).toBe(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('dispose stops the timer', () => {
    active = true;
    ticker.poke();
    ticker.dispose();
    const before = ticks;
    vi.advanceTimersByTime(5000);

    expect(ticks).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });
});
