import { describe, expect, it } from 'vitest';
import { CheckRegistry } from '../../../src/checks/registry';

const two = [
  { text: 'status == 200', line: 2 },
  { text: 'count() > 1', line: 3 },
];

describe('CheckRegistry', () => {
  it('starts every check of a run pending, then keeps the latest run only', () => {
    const registry = new CheckRegistry();
    registry.begin({ id: 1, key: 'k', startedAt: 1 }, two);
    expect(registry.forRequest('k')).toEqual([
      { runId: 1, text: 'status == 200', line: 2, result: { state: 'pending' } },
      { runId: 1, text: 'count() > 1', line: 3, result: { state: 'pending' } },
    ]);
    registry.update(1, 0, { state: 'passed', settledAt: undefined });
    registry.update(1, 1, { state: 'failed', detail: 'got 0', settledAt: undefined });
    expect(registry.summary('k')).toEqual({ passed: 1, failed: 1, total: 2 });

    registry.begin({ id: 2, key: 'k', startedAt: 2 }, two.slice(0, 1));
    expect(registry.forRequest('k')).toEqual([
      { runId: 2, text: 'status == 200', line: 2, result: { state: 'pending' } },
    ]);
    expect(registry.summary('k')).toEqual({ passed: 0, failed: 0, total: 1 });
  });

  it('ignores results of an older run', () => {
    const registry = new CheckRegistry();
    registry.begin({ id: 1, key: 'k', startedAt: 1 }, two);
    registry.begin({ id: 2, key: 'k', startedAt: 2 }, two);
    registry.update(1, 0, { state: 'passed', settledAt: undefined });
    expect(registry.forRequest('k')[0]?.result).toEqual({ state: 'pending' });
  });

  it('forgets a request whose new run has no checks', () => {
    const registry = new CheckRegistry();
    registry.begin({ id: 1, key: 'k', startedAt: 1 }, two);
    registry.begin({ id: 2, key: 'k', startedAt: 2 }, []);
    expect(registry.forRequest('k')).toEqual([]);
    expect(registry.summary('k')).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  it('keeps at most 500 request keys, evicting the oldest run', () => {
    const registry = new CheckRegistry();
    for (let at = 1; at <= 501; at += 1) {
      registry.begin({ id: at, key: `k${String(at)}`, startedAt: at }, two);
    }
    expect(registry.size).toBe(500);
    expect(registry.forRequest('k1')).toEqual([]);
    expect(registry.forRequest('k501')).toHaveLength(2);
  });

  it('tells listeners which request changed', () => {
    const registry = new CheckRegistry();
    const changed: string[] = [];
    const stop = registry.onDidChange((key) => changed.push(key));
    registry.begin({ id: 1, key: 'k', startedAt: 1 }, two);
    registry.update(1, 1, { state: 'passed', settledAt: 4 });
    stop();
    registry.update(1, 0, { state: 'passed', settledAt: 4 });
    expect(changed).toEqual(['k', 'k']);
    expect(registry.listenerCount).toBe(0);
  });

  it('masks stored details again with secrets that resolved later', () => {
    const registry = new CheckRegistry();
    registry.begin({ id: 4, key: 'k', startedAt: 4 }, two);
    registry.update(4, 0, { state: 'failed', detail: 'got "late-secret-value"', settledAt: 2 });
    expect(registry.runOf('k')).toBe(4);
    expect(registry.runOf('other')).toBeUndefined();

    registry.remask('k', ['late-secret-value']);

    expect(registry.forRequest('k')[0]?.result).toEqual({
      state: 'failed',
      detail: 'got "••••••"',
      settledAt: 2,
    });
  });
});

describe('CheckRegistry.settled', () => {
  const passed = { state: 'passed', settledAt: undefined } as const;
  const failed = { state: 'failed', detail: 'got 0', settledAt: undefined } as const;

  it('resolves settled once every check of the run has settled', async () => {
    const registry = new CheckRegistry();
    registry.begin({ id: 1, key: 'k', startedAt: 1 }, two);
    const results: unknown[] = [];
    const settled = registry.settled('k', 1).then((entries) => {
      results.push(entries);
    });

    registry.update(1, 0, passed);
    await new Promise((resolve) => setImmediate(resolve));
    expect(results).toEqual([]);

    registry.update(1, 1, failed);
    await settled;
    expect(results).toEqual([
      [
        { runId: 1, text: 'status == 200', line: 2, result: passed },
        { runId: 1, text: 'count() > 1', line: 3, result: failed },
      ],
    ]);
    expect(registry.waiterCount).toBe(0);
  });

  it('resolves settled at once for a run that has settled already', async () => {
    const registry = new CheckRegistry();
    registry.begin({ id: 1, key: 'k', startedAt: 1 }, two);
    registry.update(1, 0, passed);
    registry.update(1, 1, passed);

    expect(await registry.settled('k', 1)).toHaveLength(2);
    expect(registry.waiterCount).toBe(0);
  });

  it('resolves undefined for a run whose checks were evicted or replaced by a run without checks', async () => {
    const evicting = new CheckRegistry(1);
    evicting.begin({ id: 1, key: 'a', startedAt: 1 }, two);
    evicting.begin({ id: 2, key: 'b', startedAt: 2 }, two);
    expect(await evicting.settled('a', 1)).toBeUndefined();

    const registry = new CheckRegistry();
    registry.begin({ id: 3, key: 'k', startedAt: 3 }, two);
    registry.begin({ id: 4, key: 'k', startedAt: 4 }, []);
    expect(await registry.settled('k', 3)).toBeUndefined();
    expect(await registry.settled('k', 4)).toBeUndefined();
    expect(await registry.settled('unknown', 9)).toBeUndefined();
    expect(registry.waiterCount).toBe(0);
  });

  it('resolves undefined when a newer run of the request begins', async () => {
    const registry = new CheckRegistry();
    registry.begin({ id: 1, key: 'k', startedAt: 1 }, two);
    const settled = registry.settled('k', 1);

    registry.begin({ id: 2, key: 'k', startedAt: 2 }, two);

    expect(await settled).toBeUndefined();
    expect(await registry.settled('k', 1)).toBeUndefined();
    expect(registry.waiterCount).toBe(0);
  });

  it('resolves undefined when the request is evicted', async () => {
    const registry = new CheckRegistry(1);
    registry.begin({ id: 1, key: 'k', startedAt: 1 }, two);
    const settled = registry.settled('k', 1);

    registry.begin({ id: 2, key: 'other', startedAt: 2 }, two);

    expect(await settled).toBeUndefined();
    expect(registry.waiterCount).toBe(0);
  });

  it('keeps no waiter once settled', async () => {
    const registry = new CheckRegistry();
    registry.begin({ id: 1, key: 'k', startedAt: 1 }, two);
    const waits = [registry.settled('k', 1), registry.settled('k', 1)];
    expect(registry.waiterCount).toBe(2);

    registry.update(1, 0, passed);
    registry.update(1, 1, passed);
    await Promise.all(waits);

    expect(registry.waiterCount).toBe(0);
  });
});
