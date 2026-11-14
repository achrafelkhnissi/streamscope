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
