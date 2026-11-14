import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CaptureRegistry,
  CaptureWaitError,
  type CaptureEntry,
} from '../../../src/capture/registry';
import type { CaptureResult } from '../../../src/capture/tracker';

const startKey = 'file:///agent.http\n@startRun';
const continueKey = 'file:///agent.http\n@continue';
const summaryKey = 'file:///agent.http\n@summary';

interface Run {
  id: number;
  key: string;
  label: string;
  startedAt: number;
}

function run(id: number, key: string, label: string, startedAt = id * 10): Run {
  return { id, key, label, startedAt };
}

function resolved(text: string, runId: number, secret = false): CaptureResult {
  return {
    state: 'resolved',
    text,
    secret,
    sensitive: [],
    provenance: { runId, event: 1, path: 'threadId', time: 0 },
  };
}

function failed(reason: string): CaptureResult {
  return { state: 'failed', reason };
}

const pending: CaptureResult = { state: 'pending' };
const threadId = [{ name: 'threadId', secret: false }];
const messageId = [{ name: 'messageId', secret: false }];
const everyRequest = (): boolean => true;
const thirtySeconds = { timeoutMs: 30_000 };

function waitOptions(signal = new AbortController().signal): {
  timeoutMs: number;
  signal: AbortSignal;
} {
  return { ...thirtySeconds, signal };
}

async function rejection(promise: Promise<unknown>): Promise<CaptureWaitError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof CaptureWaitError)) {
    throw new Error(`expected a CaptureWaitError, got ${String(error)}`);
  }
  return error;
}

function settledState(promise: Promise<unknown>): { settled: boolean } {
  const state = { settled: false };
  promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

describe('CaptureRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a new run resets its request captures to pending', () => {
    const registry = new CaptureRegistry();
    const definitions = [
      { name: 'threadId', secret: false },
      { name: 'token', secret: true },
    ];
    registry.begin(run(1, startKey, 'startRun', 100), definitions);
    registry.update(1, 'threadId', resolved('thread-1', 1));
    registry.update(1, 'token', resolved('token-1', 1, true));

    registry.begin(run(2, startKey, 'startRun', 200), definitions);

    expect(registry.forRequest(startKey)).toStrictEqual<CaptureEntry[]>([
      {
        request: startKey,
        label: 'startRun',
        name: 'threadId',
        secret: false,
        runId: 2,
        runStartedAt: 200,
        result: pending,
      },
      {
        request: startKey,
        label: 'startRun',
        name: 'token',
        secret: true,
        runId: 2,
        runStartedAt: 200,
        result: pending,
      },
    ]);
    expect(registry.get(startKey, 'threadId')?.result).toStrictEqual(pending);
  });

  it('a new run without captures drops the request earlier captures', () => {
    const registry = new CaptureRegistry();
    registry.begin(run(1, startKey, 'startRun'), threadId);
    registry.update(1, 'threadId', resolved('thread-1', 1));

    registry.begin(run(2, startKey, 'startRun'), []);

    expect(registry.forRequest(startKey)).toStrictEqual([]);
    expect(registry.get(startKey, 'threadId')).toBeUndefined();
    expect(registry.latest('threadId', everyRequest)).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  it('get, forRequest and latest know nothing of a request that never ran', () => {
    const registry = new CaptureRegistry();

    expect(registry.get(startKey, 'threadId')).toBeUndefined();
    expect(registry.forRequest(startKey)).toStrictEqual([]);
    expect(registry.latest('threadId', everyRequest)).toBeUndefined();
  });

  it('latest(name) is the capture whose run started last', () => {
    const registry = new CaptureRegistry();
    registry.begin(run(1, startKey, 'startRun', 300), threadId);
    registry.begin(run(2, continueKey, 'continue', 100), threadId);
    registry.update(1, 'threadId', resolved('thread-1', 1));
    registry.update(2, 'threadId', resolved('thread-2', 2));

    expect(registry.latest('threadId', everyRequest)).toMatchObject({
      runId: 1,
      request: startKey,
    });

    registry.begin(run(3, continueKey, 'continue', 400), threadId);
    expect(registry.latest('threadId', everyRequest)).toMatchObject({
      runId: 3,
      request: continueKey,
      result: pending,
    });

    registry.begin(run(4, continueKey, 'continue', 500), messageId);
    expect(registry.latest('threadId', everyRequest)).toMatchObject({
      runId: 1,
      request: startKey,
    });
    expect(registry.latest('messageId', everyRequest)).toMatchObject({
      runId: 4,
      request: continueKey,
    });
  });

  it('latest(name, include) leaves out the requests include rejects', () => {
    const registry = new CaptureRegistry();
    registry.begin(run(1, startKey, 'startRun', 100), threadId);
    registry.begin(run(2, summaryKey, 'summary', 200), threadId);
    registry.begin(run(3, continueKey, 'continue', 300), threadId);

    expect(registry.latest('threadId', (request) => request !== continueKey)).toMatchObject({
      runId: 2,
      request: summaryKey,
    });
    expect(registry.latest('threadId', (request) => request !== summaryKey)).toMatchObject({
      runId: 3,
    });
    expect(registry.latest('messageId', (request) => request !== continueKey)).toBeUndefined();
  });

  it('an update from a superseded run is ignored', () => {
    const registry = new CaptureRegistry();
    const changes: string[] = [];
    registry.begin(run(1, startKey, 'startRun'), threadId);
    registry.begin(run(2, startKey, 'startRun'), threadId);
    registry.onDidChange((request, name) => {
      changes.push(`${request} ${name}`);
    });

    registry.update(1, 'threadId', resolved('thread-old', 1));
    registry.update(2, 'unknown', resolved('thread-2', 2));

    expect(registry.get(startKey, 'threadId')).toMatchObject({ runId: 2, result: pending });
    expect(changes).toStrictEqual([]);
  });

  it('an update replaces the entry instead of changing the one handed out', () => {
    const registry = new CaptureRegistry();
    registry.begin(run(1, startKey, 'startRun'), threadId);
    const before = registry.get(startKey, 'threadId');

    registry.update(1, 'threadId', resolved('thread-1', 1));

    expect(before?.result).toStrictEqual(pending);
    expect(registry.get(startKey, 'threadId')?.result).toStrictEqual(resolved('thread-1', 1));
  });

  it('clear drops every value, failure and pending entry and tells listeners', () => {
    const registry = new CaptureRegistry();
    registry.begin(run(1, startKey, 'startRun'), threadId);
    registry.begin(run(2, continueKey, 'continue'), [...threadId, ...messageId]);
    registry.begin(run(3, summaryKey, 'summary'), messageId);
    registry.update(1, 'threadId', resolved('thread-1', 1));
    registry.update(2, 'threadId', failed('the body has no threadId'));
    const changes: string[] = [];
    registry.onDidChange((request, name) => {
      changes.push(`${name} ${request} ${registry.get(request, name)?.result.state ?? 'removed'}`);
    });

    registry.clear();

    expect(registry.size).toBe(0);
    for (const key of [startKey, continueKey, summaryKey]) {
      expect(registry.forRequest(key)).toStrictEqual([]);
    }
    expect(registry.latest('threadId', everyRequest)).toBeUndefined();
    expect(registry.latest('messageId', everyRequest)).toBeUndefined();
    expect(changes.sort()).toEqual(
      [
        `threadId ${startKey} removed`,
        `threadId ${continueKey} removed`,
        `messageId ${continueKey} removed`,
        `messageId ${summaryKey} removed`,
      ].sort(),
    );
  });

  it('clear ignores later results of runs that began before it', () => {
    const registry = new CaptureRegistry();
    registry.begin(run(1, startKey, 'startRun'), threadId);
    registry.clear();
    const changes: string[] = [];
    registry.onDidChange((request, name) => {
      changes.push(`${name} ${request}`);
    });

    registry.update(1, 'threadId', resolved('thread-restricted', 1));

    expect(registry.get(startKey, 'threadId')).toBeUndefined();
    expect(registry.latest('threadId', everyRequest)).toBeUndefined();
    expect(changes).toEqual([]);

    registry.begin(run(2, startKey, 'startRun'), threadId);
    registry.update(2, 'threadId', resolved('thread-trusted', 2));
    expect(registry.get(startKey, 'threadId')?.result).toStrictEqual(resolved('thread-trusted', 2));
  });

  it('clear releases every wait without a value, and leaves no timer or listener', async () => {
    const registry = new CaptureRegistry();
    registry.begin(run(1, startKey, 'startRun'), threadId);
    const signal = new AbortController().signal;
    const waiting = registry.wait(startKey, 'threadId', 9, waitOptions(signal));
    const early = registry.wait(summaryKey, 'summaryId', 9, waitOptions(signal));
    expect(registry.waitCount).toBe(2);

    registry.clear();

    await expect(waiting).resolves.toBeUndefined();
    await expect(early).resolves.toBeUndefined();
    expect(registry.waitCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
  });

  it('wait resolves when the capture resolves, and at once when it already has', async () => {
    const registry = new CaptureRegistry();
    registry.begin(run(1, startKey, 'startRun'), threadId);
    const signal = new AbortController().signal;

    const waiting = registry.wait(startKey, 'threadId', 9, waitOptions(signal));
    const state = settledState(waiting);
    await Promise.resolve();
    expect(state.settled).toBe(false);
    expect(registry.waitCount).toBe(1);

    registry.update(1, 'threadId', resolved('thread-1', 1));

    await expect(waiting).resolves.toMatchObject({
      runId: 1,
      result: resolved('thread-1', 1),
    });
    expect(registry.waitCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    await expect(registry.wait(startKey, 'threadId', 10, waitOptions())).resolves.toMatchObject({
      result: resolved('thread-1', 1),
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('wait resolves with a failed capture, which the caller reports', async () => {
    const registry = new CaptureRegistry();
    registry.begin(run(1, startKey, 'startRun'), threadId);

    const waiting = registry.wait(startKey, 'threadId', 9, waitOptions());
    registry.update(1, 'threadId', failed('no event matched first(type == "RUN_STARTED")'));

    await expect(waiting).resolves.toMatchObject({
      result: failed('no event matched first(type == "RUN_STARTED")'),
    });
  });

  it('a re-run producer resolves its waiting consumer with the new run value', async () => {
    const registry = new CaptureRegistry();
    registry.begin(run(1, startKey, 'startRun'), threadId);
    const waiting = registry.wait(startKey, 'threadId', 9, waitOptions());
    const state = settledState(waiting);

    registry.begin(run(2, startKey, 'startRun'), threadId);
    registry.update(1, 'threadId', resolved('thread-old', 1));
    await Promise.resolve();
    expect(state.settled).toBe(false);

    registry.update(2, 'threadId', resolved('thread-new', 2));

    await expect(waiting).resolves.toMatchObject({
      runId: 2,
      result: resolved('thread-new', 2),
    });
  });

  it('a wait for a request that has not begun resolves once it runs and resolves', async () => {
    const registry = new CaptureRegistry();
    const waiting = registry.wait(startKey, 'threadId', 9, waitOptions());

    registry.begin(run(1, startKey, 'startRun'), threadId);
    registry.update(1, 'threadId', resolved('thread-1', 1));

    await expect(waiting).resolves.toMatchObject({ runId: 1 });
  });

  it('wait times out with the decision 10 message and leaves nothing behind', async () => {
    const registry = new CaptureRegistry();
    registry.begin(run(1, startKey, 'startRun'), threadId);
    const signal = new AbortController().signal;

    const waiting = registry.wait(startKey, 'threadId', 9, { timeoutMs: 30_000, signal });
    const error = rejection(waiting);
    expect(vi.getTimerCount()).toBe(1);
    expect(getEventListeners(signal, 'abort')).toHaveLength(1);
    vi.advanceTimersByTime(29_999);
    expect(registry.waitCount).toBe(1);
    vi.advanceTimersByTime(1);

    expect(await error).toMatchObject({
      kind: 'timeout',
      message: 'startRun › threadId did not arrive within 30 s.',
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    expect(registry.waitCount).toBe(0);
    registry.update(1, 'threadId', resolved('thread-1', 1));
  });

  it('names a timeout that is not whole seconds in milliseconds', async () => {
    const registry = new CaptureRegistry();
    registry.begin(run(1, startKey, 'startRun'), threadId);

    const error = rejection(
      registry.wait(startKey, 'threadId', 9, { ...waitOptions(), timeoutMs: 1_500 }),
    );
    vi.advanceTimersByTime(1_500);

    expect((await error).message).toBe('startRun › threadId did not arrive within 1500 ms.');
  });

  it('an aborted signal cancels the wait and leaves nothing registered', async () => {
    const registry = new CaptureRegistry();
    registry.begin(run(1, startKey, 'startRun'), threadId);
    registry.begin(run(2, continueKey, 'continue'), messageId);
    const controller = new AbortController();

    const error = rejection(registry.wait(startKey, 'threadId', 2, waitOptions(controller.signal)));
    controller.abort();

    expect(await error).toMatchObject({
      kind: 'cancelled',
      message: 'Waiting for startRun › threadId was cancelled.',
    });
    expect(registry.waitCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    const reverse = registry.wait(continueKey, 'messageId', 1, waitOptions());
    registry.update(2, 'messageId', resolved('message-1', 2));
    await expect(reverse).resolves.toMatchObject({ runId: 2 });
  });

  it('a signal aborted before the wait rejects at once and registers nothing', async () => {
    const registry = new CaptureRegistry();
    registry.begin(run(1, startKey, 'startRun'), threadId);
    const controller = new AbortController();
    controller.abort();

    const error = await rejection(
      registry.wait(startKey, 'threadId', 9, waitOptions(controller.signal)),
    );

    expect(error.kind).toBe('cancelled');
    expect(registry.waitCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('a request waiting for its own capture is refused at once', async () => {
    const registry = new CaptureRegistry();
    registry.begin(run(1, startKey, 'startRun'), threadId);
    const signal = new AbortController().signal;

    const error = await rejection(registry.wait(startKey, 'threadId', 1, waitOptions(signal)));

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      kind: 'self',
      message: 'startRun cannot use its own capture threadId.',
    });
    expect(registry.waitCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
  });

  it('a cycle of waits is blocked at once', async () => {
    const registry = new CaptureRegistry();
    registry.begin(run(1, startKey, 'startRun'), threadId);
    registry.begin(run(2, continueKey, 'continue'), messageId);
    const first = registry.wait(startKey, 'threadId', 2, waitOptions());
    const signal = new AbortController().signal;

    const error = await rejection(registry.wait(continueKey, 'messageId', 1, waitOptions(signal)));

    expect(error).toMatchObject({
      kind: 'cycle',
      message: "startRun and continue wait for each other's captures.",
    });
    expect(registry.waitCount).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    registry.update(1, 'threadId', resolved('thread-1', 1));
    await expect(first).resolves.toMatchObject({ runId: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a cycle through three requests names each of them, starting with the waiter', async () => {
    const registry = new CaptureRegistry();
    registry.begin(run(1, startKey, 'startRun'), threadId);
    registry.begin(run(2, continueKey, 'continue'), messageId);
    registry.begin(run(3, summaryKey, 'summary'), [{ name: 'summaryId', secret: false }]);
    void rejection(registry.wait(continueKey, 'messageId', 1, waitOptions()));
    void rejection(registry.wait(summaryKey, 'summaryId', 2, waitOptions()));

    const error = await rejection(registry.wait(startKey, 'threadId', 3, waitOptions()));

    expect(error).toMatchObject({
      kind: 'cycle',
      message: "summary, startRun and continue wait for each other's captures.",
    });
  });

  it('a cycle check follows a producer to its latest run', async () => {
    const registry = new CaptureRegistry();
    registry.begin(run(1, startKey, 'startRun'), threadId);
    registry.begin(run(2, continueKey, 'continue'), messageId);
    void rejection(registry.wait(startKey, 'threadId', 2, waitOptions()));
    registry.begin(run(3, startKey, 'startRun'), threadId);

    const error = await rejection(registry.wait(continueKey, 'messageId', 3, waitOptions()));
    const stale = registry.wait(continueKey, 'messageId', 1, waitOptions());
    registry.update(2, 'messageId', resolved('message-1', 2));

    expect(error.kind).toBe('cycle');
    await expect(stale).resolves.toMatchObject({ runId: 2 });
  });

  it('waits that do not form a cycle all proceed', async () => {
    const registry = new CaptureRegistry();
    registry.begin(run(1, startKey, 'startRun'), threadId);
    registry.begin(run(2, continueKey, 'continue'), messageId);
    registry.begin(run(3, summaryKey, 'summary'), [{ name: 'summaryId', secret: false }]);

    const second = registry.wait(startKey, 'threadId', 2, waitOptions());
    const third = registry.wait(continueKey, 'messageId', 3, waitOptions());
    const again = registry.wait(startKey, 'threadId', 3, waitOptions());
    expect(registry.waitCount).toBe(3);
    registry.update(1, 'threadId', resolved('thread-1', 1));
    registry.update(2, 'messageId', resolved('message-1', 2));

    await expect(Promise.all([second, third, again])).resolves.toHaveLength(3);
    expect(registry.waitCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps at most 500 requests, evicting the one whose run started longest ago', () => {
    const registry = new CaptureRegistry();
    const key = (at: number): string => `file:///many.http\n#${String(at)} GET /`;
    registry.begin(run(1_000, key(0), 'first', 10_000), threadId);
    for (let at = 1; at < 500; at += 1) {
      registry.begin(run(at, key(at), `request ${String(at)}`, at), threadId);
    }
    registry.begin(run(2_000, key(5), 'request 5', 20_000), threadId);
    expect(registry.size).toBe(500);

    registry.begin(run(3_000, key(500), 'request 500', 30_000), threadId);
    registry.begin(run(3_001, key(501), 'request 501', 30_001), threadId);

    expect(registry.size).toBe(500);
    expect(registry.get(key(1), 'threadId')).toBeUndefined();
    expect(registry.get(key(2), 'threadId')).toBeUndefined();
    expect(registry.get(key(3), 'threadId')).toBeDefined();
    expect(registry.get(key(0), 'threadId')).toBeDefined();
    expect(registry.get(key(5), 'threadId')).toMatchObject({ runId: 2_000 });
    registry.update(1, 'threadId', resolved('thread-1', 1));
    expect(registry.size).toBe(500);
  });

  it('takes a smaller bound', () => {
    const registry = new CaptureRegistry(2);
    registry.begin(run(1, startKey, 'startRun'), threadId);
    registry.begin(run(2, continueKey, 'continue'), threadId);
    registry.begin(run(3, summaryKey, 'summary'), threadId);

    expect(registry.size).toBe(2);
    expect(registry.forRequest(startKey)).toStrictEqual([]);
    expect(registry.latest('threadId', everyRequest)).toMatchObject({ runId: 3 });
  });

  it('tells listeners about each reset and update, and the returned function removes one', () => {
    const registry = new CaptureRegistry();
    const first: string[] = [];
    const second: string[] = [];
    const state = (request: string, name: string): string =>
      `${name}:${registry.get(request, name)?.result.state ?? 'removed'}`;
    const removeFirst = registry.onDidChange((request, name) => {
      first.push(state(request, name));
    });
    registry.onDidChange((request, name) => {
      second.push(state(request, name));
    });

    registry.begin(run(1, startKey, 'startRun'), [...threadId, ...messageId]);
    registry.update(1, 'threadId', resolved('thread-1', 1));
    removeFirst();
    registry.update(1, 'messageId', failed('the response has no headers'));

    expect(first).toStrictEqual(['threadId:pending', 'messageId:pending', 'threadId:resolved']);
    expect(second).toStrictEqual([
      'threadId:pending',
      'messageId:pending',
      'threadId:resolved',
      'messageId:failed',
    ]);
  });

  it('tells listeners which request and name lost its captures when they are removed', () => {
    const registry = new CaptureRegistry(2);
    const changes: string[] = [];
    registry.begin(run(1, startKey, 'startRun'), [...threadId, ...messageId]);
    registry.begin(run(2, continueKey, 'continue'), messageId);
    registry.onDidChange((request, name) => {
      changes.push(`${request} ${name}:${registry.get(request, name)?.result.state ?? 'removed'}`);
    });

    registry.begin(run(3, startKey, 'startRun'), threadId);
    registry.begin(run(4, continueKey, 'continue'), []);
    registry.begin(run(5, summaryKey, 'summary'), threadId);
    registry.begin(run(6, continueKey, 'continue'), messageId);

    expect(changes).toStrictEqual([
      `${startKey} threadId:removed`,
      `${startKey} messageId:removed`,
      `${startKey} threadId:pending`,
      `${continueKey} messageId:removed`,
      `${summaryKey} threadId:pending`,
      `${startKey} threadId:removed`,
      `${continueKey} messageId:pending`,
    ]);
  });

  it('CaptureWaitError is an Error with a kind', () => {
    const error = new CaptureWaitError(
      'timeout',
      'startRun › threadId did not arrive within 30 s.',
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.kind).toBe('timeout');
    expect(error.message).toBe('startRun › threadId did not arrive within 30 s.');
  });
});
