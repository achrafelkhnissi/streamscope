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

  it('flushes the first update in a microtask, after the caller returns', async () => {
    batcher.schedule();

    expect(flushes).toBe(0);
    await Promise.resolve();
    expect(flushes).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gathers synchronous updates into the first flush', async () => {
    for (let call = 0; call < 5; call += 1) {
      batcher.schedule();
    }
    await Promise.resolve();

    expect(flushes).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesces updates within 50 ms into one', async () => {
    batcher.schedule();
    await Promise.resolve();
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

  it('flushes again after a quiet period without waiting', async () => {
    batcher.schedule();
    await Promise.resolve();
    vi.advanceTimersByTime(80);
    batcher.schedule();
    await Promise.resolve();

    expect(flushes).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('flushNow flushes and cancels the timer and the pending microtask', async () => {
    batcher.schedule();
    await Promise.resolve();
    vi.advanceTimersByTime(10);
    batcher.schedule();
    expect(vi.getTimerCount()).toBe(1);

    batcher.flushNow();

    expect(flushes).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(100);
    expect(flushes).toBe(2);

    vi.advanceTimersByTime(100);
    batcher.schedule();
    batcher.flushNow();
    await Promise.resolve();
    expect(flushes).toBe(3);
  });

  it('never flushes after dispose', async () => {
    batcher.schedule();
    await Promise.resolve();
    vi.advanceTimersByTime(10);
    batcher.schedule();

    batcher.dispose();

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(100);
    batcher.schedule();
    batcher.flushNow();
    await Promise.resolve();
    expect(flushes).toBe(1);
  });
});
