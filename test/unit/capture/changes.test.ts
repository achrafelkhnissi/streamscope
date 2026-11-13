import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureChanges } from '../../../src/capture/changes';
import { CaptureRegistry } from '../../../src/capture/registry';
import type { CaptureResult } from '../../../src/capture/tracker';

const startKey = 'file:///agent.http\n@startRun';
const continueKey = 'file:///agent.http\n@continue';
const summaryKey = 'file:///summary.http\n@summary';
const threadId = [{ name: 'threadId', secret: false }];
const both = [...threadId, { name: 'messageId', secret: false }];

interface Refresh {
  at: number;
  requests: string[];
  names: string[];
}

function resolved(text: string, runId: number): CaptureResult {
  return {
    state: 'resolved',
    text,
    secret: false,
    sensitive: [],
    provenance: { runId, event: 1, path: 'threadId', time: 0 },
  };
}

function watch(registry: CaptureRegistry): { refreshes: Refresh[]; changes: CaptureChanges } {
  const refreshes: Refresh[] = [];
  const changes = new CaptureChanges(registry, (requests, names) => {
    refreshes.push({ at: Date.now(), requests: [...requests], names: [...names] });
  });
  return { refreshes, changes };
}

describe('CaptureChanges', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a burst of updates refreshes at most once per 200 ms', () => {
    const registry = new CaptureRegistry();
    const { refreshes } = watch(registry);

    registry.begin({ id: 1, key: startKey, label: 'startRun', startedAt: 0 }, both);
    for (let at = 0; at < 1_000; at += 5) {
      registry.update(1, at % 2 === 0 ? 'threadId' : 'messageId', resolved(String(at), 1));
      vi.advanceTimersByTime(5);
    }
    vi.advanceTimersByTime(200);

    expect(refreshes.length).toBe(5);
    expect(refreshes[0]).toEqual({
      at: 200,
      requests: [startKey],
      names: ['threadId', 'messageId'],
    });
    for (const [index, refresh] of refreshes.entries()) {
      const previous = refreshes[index - 1];
      if (previous !== undefined) {
        expect(refresh.at - previous.at).toBeGreaterThanOrEqual(200);
      }
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refreshes once with only what changed since the last refresh', () => {
    const registry = new CaptureRegistry();
    const { refreshes } = watch(registry);
    registry.begin({ id: 1, key: startKey, label: 'startRun', startedAt: 0 }, threadId);
    vi.advanceTimersByTime(200);

    registry.begin({ id: 2, key: summaryKey, label: 'summary', startedAt: 1 }, both);
    registry.update(2, 'messageId', resolved('message-1', 2));
    vi.advanceTimersByTime(199);
    expect(refreshes.length).toBe(1);
    vi.advanceTimersByTime(1);

    expect(refreshes).toEqual([
      { at: 200, requests: [startKey], names: ['threadId'] },
      { at: 400, requests: [summaryKey], names: ['threadId', 'messageId'] },
    ]);
  });

  it('refreshes when a re-run declares no captures and removes them', () => {
    const registry = new CaptureRegistry();
    const { refreshes } = watch(registry);
    registry.begin({ id: 1, key: startKey, label: 'startRun', startedAt: 0 }, both);
    vi.advanceTimersByTime(200);

    registry.begin({ id: 2, key: startKey, label: 'startRun', startedAt: 1 }, []);
    vi.advanceTimersByTime(200);

    expect(refreshes[1]).toEqual({
      at: 400,
      requests: [startKey],
      names: ['threadId', 'messageId'],
    });
  });

  it('refreshes when the registry evicts a request', () => {
    const registry = new CaptureRegistry(1);
    const { refreshes } = watch(registry);
    registry.begin({ id: 1, key: startKey, label: 'startRun', startedAt: 0 }, threadId);
    vi.advanceTimersByTime(200);

    registry.begin({ id: 2, key: continueKey, label: 'continue', startedAt: 1 }, [
      { name: 'messageId', secret: false },
    ]);
    vi.advanceTimersByTime(200);

    expect(registry.get(startKey, 'threadId')).toBeUndefined();
    expect(refreshes[1]).toEqual({
      at: 400,
      requests: [startKey, continueKey],
      names: ['threadId', 'messageId'],
    });
  });

  it('refreshes when a re-run drops a capture', () => {
    const registry = new CaptureRegistry();
    const { refreshes } = watch(registry);
    registry.begin({ id: 1, key: startKey, label: 'startRun', startedAt: 0 }, both);
    vi.advanceTimersByTime(200);

    registry.begin({ id: 2, key: startKey, label: 'startRun', startedAt: 1 }, threadId);
    vi.advanceTimersByTime(200);

    expect(registry.get(startKey, 'messageId')).toBeUndefined();
    expect(refreshes[1]).toEqual({
      at: 400,
      requests: [startKey],
      names: ['threadId', 'messageId'],
    });
  });

  it('dispose removes the registry listener and cancels a pending refresh', () => {
    const registry = new CaptureRegistry();
    const { refreshes, changes } = watch(registry);
    registry.begin({ id: 1, key: startKey, label: 'startRun', startedAt: 0 }, threadId);
    expect(vi.getTimerCount()).toBe(1);

    changes.dispose();
    registry.update(1, 'threadId', resolved('thread-1', 1));
    vi.advanceTimersByTime(1_000);

    expect(vi.getTimerCount()).toBe(0);
    expect(refreshes).toEqual([]);
  });
});
