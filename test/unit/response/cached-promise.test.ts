import { describe, expect, it, vi } from 'vitest';
import { CachedPromise } from '../../../src/response/cached-promise';

describe('CachedPromise', () => {
  it('computes once and hands every caller the same promise', async () => {
    const cache = new CachedPromise<number>();
    const make = vi.fn(() => Promise.resolve(7));

    const first = cache.get(make);
    const second = cache.get(make);

    expect(second).toBe(first);
    expect(await first).toBe(7);
    expect(make).toHaveBeenCalledTimes(1);
  });

  it('keeps a result that is undefined', async () => {
    const cache = new CachedPromise<undefined>();
    const make = vi.fn(() => Promise.resolve(undefined));

    await cache.get(make);
    await cache.get(make);

    expect(make).toHaveBeenCalledTimes(1);
  });

  it('gives the rejection to the caller and does not keep it', async () => {
    const cache = new CachedPromise<number>();
    const failing = vi.fn(() => Promise.reject(new Error('synthetic read failure')));
    const working = vi.fn(() => Promise.resolve(3));

    await expect(cache.get(failing)).rejects.toThrow('synthetic read failure');
    const retried = await cache.get(working);

    expect(retried).toBe(3);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(working).toHaveBeenCalledTimes(1);
    expect(await cache.get(working)).toBe(3);
    expect(working).toHaveBeenCalledTimes(1);
  });

  it('computes again after it was cleared', async () => {
    const cache = new CachedPromise<number>();
    const make = vi.fn(() => Promise.resolve(1));
    await cache.get(make);

    cache.clear();
    await cache.get(make);

    expect(make).toHaveBeenCalledTimes(2);
  });

  it('does not drop a newer result when an older computation fails after a clear', async () => {
    const cache = new CachedPromise<number>();
    let fail: (error: Error) => void = () => undefined;
    const older = cache.get(
      () =>
        new Promise<number>((_resolve, reject) => {
          fail = reject;
        }),
    );
    older.catch(() => undefined);
    cache.clear();
    const newer = vi.fn(() => Promise.resolve(9));
    await cache.get(newer);

    fail(new Error('late failure'));
    await older.catch(() => undefined);
    await cache.get(newer);

    expect(newer).toHaveBeenCalledTimes(1);
  });
});
