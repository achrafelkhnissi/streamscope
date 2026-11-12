import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateBatcher } from '../../../src/events/batcher';

describe('UpdateBatcher', () => {
  let flushes: number;
  let batcher: UpdateBatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    flushes = 0;
    batcher = new UpdateBatcher(
      () => {
        flushes += 1;
      },
      { intervalMs: 50, now: () => Date.now() },
    );
  });

  afterEach(() => {
    batcher.dispose();
    vi.useRealTimers();
  });

  it('flushes the first update immediately', () => {
    batcher.schedule();

    expect(flushes).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesces updates within 50 ms into one', () => {
    batcher.schedule();
    for (let call = 0; call < 10; call += 1) {
      vi.advanceTimersByTime(2);
      batcher.schedule();
    }

    expect(flushes).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(29);
    expect(flushes).toBe(1);

    vi.advanceTimersByTime(1);
    expect(flushes).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('flushes immediately again after a quiet period', () => {
    batcher.schedule();
    vi.advanceTimersByTime(80);
    batcher.schedule();

    expect(flushes).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('flushNow flushes and cancels the timer', () => {
    batcher.schedule();
    vi.advanceTimersByTime(10);
    batcher.schedule();
    expect(vi.getTimerCount()).toBe(1);

    batcher.flushNow();

    expect(flushes).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(100);
    expect(flushes).toBe(2);
  });

  it('never flushes after dispose', () => {
    batcher.schedule();
    vi.advanceTimersByTime(10);
    batcher.schedule();

    batcher.dispose();

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(100);
    batcher.schedule();
    batcher.flushNow();
    expect(flushes).toBe(1);
  });
});
