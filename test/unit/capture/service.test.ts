import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptureRegistry } from '../../../src/capture/registry';
import { CaptureService, type ProducerRun } from '../../../src/capture/service';
import type { CaptureResult } from '../../../src/capture/tracker';
import { parseHttpFile } from '../../../src/http-file/parse';
import type { HttpFile } from '../../../src/http-file/model';
import { requestKey } from '../../../src/runs/run';
import type { ResponseHead } from '../../../src/transport/model';
import type { CaptureWait } from '../../../src/variables/resolve';
import { missingWorker } from './worker';

const documentUri = 'file:///agent.http';
const lines = [
  '# @name startRun',
  '# @capture threadId = first(type == "RUN_STARTED").threadId',
  '# @capture secret sessionToken = headers["x-session-token"]',
  'POST https://api.example.test/agent/run',
  '',
  '###',
  '# @name continue',
  '# @capture threadId = body.threadId',
  'POST https://api.example.test/agent/continue',
  'X-Thread: {{startRun.threadId}}',
  'X-Session: {{startRun.response.headers.X-Session}}',
  '',
  '###',
  '# @name plain',
  'GET https://api.example.test/plain',
];
const file = parseHttpFile(lines.join('\n'));
const startKey = keyOf(file, 0);
const continueKey = keyOf(file, 1);
const threadWait: CaptureWait = {
  kind: 'capture',
  request: startKey,
  name: 'threadId',
  label: 'startRun',
};
const sessionWait: CaptureWait = {
  kind: 'response',
  requestName: 'startRun',
  reference: 'response.headers.X-Session',
};

function keyOf(parsed: HttpFile, index: number): string {
  const request = parsed.requests[index];
  if (!request) {
    throw new Error(`expected request ${String(index)}`);
  }
  return requestKey(documentUri, request, index);
}

function service(
  registry: CaptureRegistry,
  index: number,
  runs: (key: string) => ProducerRun | undefined = () => undefined,
): CaptureService {
  const request = file.requests[index];
  if (!request) {
    throw new Error(`expected request ${String(index)}`);
  }
  return new CaptureService({
    registry,
    documentUri,
    file,
    request,
    workerFile: missingWorker,
    runs,
  });
}

function resolved(text: string, runId: number): CaptureResult {
  return {
    state: 'resolved',
    text,
    secret: false,
    provenance: { runId, event: 1, path: 'threadId', time: 0 },
  };
}

function head(headers: [string, string][]): ResponseHead {
  return { httpVersion: '1.1', status: 200, statusText: 'OK', headers };
}

interface FakeRun extends ProducerRun {
  arrive(next: ResponseHead): void;
  end(status: string, body?: string): void;
}

function producerRun(id: number, label = 'startRun'): FakeRun {
  let current: ResponseHead | undefined;
  let status = 'receiving';
  let body = new Uint8Array();
  let markHead = (): void => undefined;
  let markDone = (): void => undefined;
  const headArrived = new Promise<void>((resolve) => {
    markHead = resolve;
  });
  const done = new Promise<void>((resolve) => {
    markDone = resolve;
  });
  return {
    id,
    done,
    headArrived,
    snapshot: () => ({
      label,
      status,
      head: current,
      bodyLength: body.length,
      failure: undefined,
      problems: [],
      wallStartedAt: 1_700_000_000_000,
      elapsedMs: 250,
    }),
    readBody: (maxBytes) => Promise.resolve(body.subarray(0, maxBytes)),
    bodyFile: () => Promise.resolve(undefined),
    arrive: (next) => {
      current = next;
      markHead();
    },
    end: (ended, text = '') => {
      status = ended;
      body = new TextEncoder().encode(text);
      markDone();
    },
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CaptureService', () => {
  it("begin resets the request's captures to pending for the new run", () => {
    const registry = new CaptureRegistry();
    registry.begin({ id: 1, key: startKey, label: 'startRun', startedAt: 1 }, [
      { name: 'threadId', secret: false },
    ]);
    registry.update(1, 'threadId', resolved('thread-1', 1));

    service(registry, 0).begin({ id: 2, key: startKey, label: 'startRun', startedAt: 2 });

    expect(
      registry.forRequest(startKey).map(({ name, secret, runId, result }) => ({
        name,
        secret,
        runId,
        result,
      })),
    ).toEqual([
      { name: 'threadId', secret: false, runId: 2, result: { state: 'pending' } },
      { name: 'sessionToken', secret: true, runId: 2, result: { state: 'pending' } },
    ]);
  });

  it("the observer evaluates the request's captures into the registry", () => {
    const registry = new CaptureRegistry();
    const captures = service(registry, 0);
    captures.begin({ id: 3, key: startKey, label: 'startRun', startedAt: 3 });

    const observer = captures.observer({ id: 3, label: 'startRun', wallStartedAt: 0 });
    observer?.head(head([['X-Session-Token', 'synthetic-session']]), {
      spillPath: () => Promise.resolve(undefined),
      signal: signal(),
    });

    expect(registry.get(startKey, 'sessionToken')?.result).toMatchObject({
      state: 'resolved',
      text: 'synthetic-session',
      secret: true,
    });
  });

  it('a request without captures has no observer and keeps no captures', () => {
    const registry = new CaptureRegistry();
    const captures = service(registry, 2);

    captures.begin({ id: 4, key: keyOf(file, 2), label: 'plain', startedAt: 4 });

    expect(captures.observer({ id: 4, label: 'plain', wallStartedAt: 0 })).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  it('a wait ends when the capture arrives', async () => {
    const registry = new CaptureRegistry();
    service(registry, 0).begin({ id: 5, key: startKey, label: 'startRun', startedAt: 5 });
    const captures = service(registry, 1);
    captures.begin({ id: 6, key: continueKey, label: 'continue', startedAt: 6 });

    const waiting = captures.wait([threadWait], 6, { timeoutMs: 30_000, signal: signal() });
    registry.update(5, 'threadId', resolved('thread-1', 5));

    expect(await waiting).toEqual({ ok: true });
    expect(registry.waitCount).toBe(0);
  });

  it('a wait that times out is a problem at the reference, with the decision 10 message', async () => {
    vi.useFakeTimers();
    const registry = new CaptureRegistry();
    service(registry, 0).begin({ id: 7, key: startKey, label: 'startRun', startedAt: 7 });
    const captures = service(registry, 1);
    captures.begin({ id: 8, key: continueKey, label: 'continue', startedAt: 8 });

    const waiting = captures.wait([threadWait], 8, { timeoutMs: 30_000, signal: signal() });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await waiting).toEqual({
      ok: false,
      problem: {
        message: 'startRun › threadId did not arrive within 30 s.',
        range: { start: { line: 9, character: 10 }, end: { line: 9, character: 31 } },
      },
    });
    expect(registry.waitCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancelling a wait releases every wait and timer', async () => {
    vi.useFakeTimers();
    const registry = new CaptureRegistry();
    service(registry, 0).begin({ id: 9, key: startKey, label: 'startRun', startedAt: 9 });
    const producer = producerRun(9);
    const captures = service(registry, 1, (key) => (key === startKey ? producer : undefined));
    captures.begin({ id: 10, key: continueKey, label: 'continue', startedAt: 10 });
    const controller = new AbortController();

    const waiting = captures.wait([threadWait, sessionWait], 10, {
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(registry.waitCount).toBe(1);
    controller.abort();

    expect(await waiting).toMatchObject({
      ok: false,
      problem: { message: 'Waiting for startRun › threadId was cancelled.' },
    });
    expect(registry.waitCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a request reading its own capture gets its previous value, or is refused when there is none', () => {
    const registry = new CaptureRegistry();
    const first = service(registry, 1);
    first.begin({ id: 11, key: continueKey, label: 'continue', startedAt: 11 });

    expect(first.lookup.bare('threadId')).toEqual({
      kind: 'failed',
      message: 'continue cannot use its own capture threadId.',
    });

    registry.update(11, 'threadId', resolved('thread-1', 11));
    const second = service(registry, 1);
    second.begin({ id: 12, key: continueKey, label: 'continue', startedAt: 12 });

    expect(second.lookup.bare('threadId')).toMatchObject({ kind: 'value', text: 'thread-1' });
    expect(second.lookup.request('continue', 'threadId')).toMatchObject({
      kind: 'value',
      text: 'thread-1',
    });
    expect(registry.get(continueKey, 'threadId')?.result).toEqual({ state: 'pending' });
  });

  it('the previous values and evaluated responses live only until the observer is taken', async () => {
    const registry = new CaptureRegistry();
    const producer = producerRun(13);
    producer.arrive(head([['X-Session', 'session-1']]));
    const earlier = service(registry, 1);
    earlier.begin({ id: 14, key: continueKey, label: 'continue', startedAt: 14 });
    registry.update(14, 'threadId', resolved('thread-1', 14));
    const captures = service(registry, 1, () => producer);
    captures.begin({ id: 15, key: continueKey, label: 'continue', startedAt: 15 });
    await captures.wait([sessionWait], 15, { timeoutMs: 30_000, signal: signal() });

    captures.observer({ id: 15, label: 'continue', wallStartedAt: 0 });

    expect(captures.lookup.bare('threadId')).toMatchObject({ kind: 'failed' });
    expect(captures.lookup.response('startRun', 'response.headers.X-Session')).toBeUndefined();
  });

  it('response references wait for the run, then the lookup reads the evaluated value', async () => {
    const registry = new CaptureRegistry();
    const producer = producerRun(16);
    const captures = service(registry, 1, (key) => (key === startKey ? producer : undefined));
    captures.begin({ id: 17, key: continueKey, label: 'continue', startedAt: 17 });
    const body: CaptureWait = {
      kind: 'response',
      requestName: 'startRun',
      reference: 'response.body.*',
    };

    const waiting = captures.wait([sessionWait, body], 17, {
      timeoutMs: 30_000,
      signal: signal(),
    });
    expect(captures.lookup.response('startRun', 'response.headers.X-Session')).toBeUndefined();
    producer.arrive(
      head([
        ['Content-Type', 'application/json'],
        ['X-Session', 'session-1'],
      ]),
    );
    producer.end('completed', '{"token":"synthetic-token"}');

    expect(await waiting).toEqual({ ok: true });
    expect(captures.lookup.response('startRun', 'response.headers.X-Session')).toEqual({
      kind: 'value',
      text: 'session-1',
      secret: false,
      label: 'startRun',
      provenance: {
        runId: 16,
        event: undefined,
        path: 'response.headers.X-Session',
        time: 1_700_000_000_250,
      },
    });
    expect(captures.lookup.response('startRun', 'response.body.*')).toMatchObject({
      kind: 'value',
      text: '{"token":"synthetic-token"}',
    });
  });

  it('a response reference to a request that never ran is not run, with its producer', async () => {
    const captures = service(new CaptureRegistry(), 1);
    captures.begin({ id: 18, key: continueKey, label: 'continue', startedAt: 18 });

    expect(await captures.wait([sessionWait], 18, { timeoutMs: 30_000, signal: signal() })).toEqual(
      { ok: true },
    );
    expect(captures.lookup.response('startRun', 'response.headers.X-Session')).toEqual({
      kind: 'not-run',
      label: 'startRun',
      producerName: 'startRun',
    });
  });

  it('a failed response reference reads <request> › <reference> failed: <reason>.', async () => {
    const producer = producerRun(19);
    const captures = service(new CaptureRegistry(), 1, () => producer);
    captures.begin({ id: 20, key: continueKey, label: 'continue', startedAt: 20 });
    producer.end('cancelled');

    await captures.wait([sessionWait], 20, { timeoutMs: 30_000, signal: signal() });

    expect(captures.lookup.response('startRun', 'response.headers.X-Session')).toEqual({
      kind: 'failed',
      message:
        'startRun › response.headers.X-Session failed: startRun was cancelled before response.headers.X-Session resolved.',
    });
  });

  it('a response reference to the waiting run itself is refused at once', async () => {
    const producer = producerRun(21, 'continue');
    const captures = service(new CaptureRegistry(), 1, () => producer);
    captures.begin({ id: 21, key: continueKey, label: 'continue', startedAt: 21 });
    const own: CaptureWait = {
      kind: 'response',
      requestName: 'continue',
      reference: 'response.body.*',
    };

    expect(await captures.wait([own], 21, { timeoutMs: 30_000, signal: signal() })).toEqual({
      ok: true,
    });
    expect(captures.lookup.response('continue', 'response.body.*')).toEqual({
      kind: 'failed',
      message: 'continue cannot use its own capture response.body.*.',
    });
  });

  it('a response reference that never arrives times out like a capture', async () => {
    vi.useFakeTimers();
    const producer = producerRun(22);
    const captures = service(new CaptureRegistry(), 1, () => producer);
    captures.begin({ id: 23, key: continueKey, label: 'continue', startedAt: 23 });

    const waiting = captures.wait([sessionWait], 23, { timeoutMs: 30_000, signal: signal() });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await waiting).toEqual({
      ok: false,
      problem: {
        message: 'startRun › response.headers.X-Session did not arrive within 30 s.',
        range: { start: { line: 10, character: 11 }, end: { line: 10, character: 50 } },
      },
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
