import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureLookup } from '../../../src/capture/lookup';
import { CaptureRegistry } from '../../../src/capture/registry';
import { CaptureService, type ProducerRun } from '../../../src/capture/service';
import type { CaptureResult } from '../../../src/capture/tracker';
import { parseHttpFile } from '../../../src/http-file/parse';
import type { HttpFile } from '../../../src/http-file/model';
import { requestKey } from '../../../src/runs/run';
import type { ResponseHead } from '../../../src/transport/model';
import { describeReference, variableDiagnostics } from '../../../src/variables/inspect';
import { resolveRequest, type CaptureWait, type Resolution } from '../../../src/variables/resolve';
import type { VariableSources } from '../../../src/variables/sources';
import { sourced, testSources } from '../variables/sources';
import { expectNoChild, missingWorker, useCaptureWorker } from './worker';

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
  workerFile = missingWorker,
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
    workerFile,
    runs,
  });
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

function head(headers: [string, string][]): ResponseHead {
  return { httpVersion: '1.1', status: 200, statusText: 'OK', headers };
}

interface FakeRun extends ProducerRun {
  readonly reads: number[];
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
  const reads: number[] = [];
  return {
    id,
    reads,
    done,
    headArrived,
    snapshot: () => ({
      label,
      status,
      head: current,
      bodyLength: body.length,
      failure: undefined,
      problems: [],
      sensitiveValues: [],
      wallStartedAt: 1_700_000_000_000,
      elapsedMs: 250,
    }),
    readBody: (maxBytes) => {
      reads.push(maxBytes);
      return Promise.resolve(body.subarray(0, maxBytes));
    },
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

function responseWait(reference: string, requestName = 'startRun'): CaptureWait {
  return { kind: 'response', requestName, reference };
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

    const observer = captures.observer({
      id: 3,
      label: 'startRun',
      wallStartedAt: 0,
      sensitiveValues: [],
    });
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

    expect(
      captures.observer({ id: 4, label: 'plain', wallStartedAt: 0, sensitiveValues: [] }),
    ).toBeUndefined();
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

    expect(first.lookup.bare('threadId')).toBeUndefined();
    expect(first.lookup.elsewhere('threadId')).toEqual({
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

  it("a bare name the request also captures reads the newer of its previous value and another request's capture", () => {
    const registry = new CaptureRegistry();
    const producer = service(registry, 0);
    const answer = (id: number) => {
      const captures = service(registry, 1);
      captures.begin({ id, key: continueKey, label: 'continue', startedAt: id });
      return captures.lookup.bare('threadId');
    };

    producer.begin({ id: 60, key: startKey, label: 'startRun', startedAt: 60 });
    expect(answer(61)).toEqual({
      kind: 'pending',
      request: startKey,
      label: 'startRun',
      name: 'threadId',
    });

    registry.update(60, 'threadId', { state: 'failed', reason: 'the stream ended' });
    expect(answer(62)).toEqual({
      kind: 'failed',
      message: 'startRun › threadId failed: the stream ended.',
    });

    registry.update(62, 'threadId', resolved('thread-own', 62));
    expect(answer(63)).toMatchObject({ kind: 'value', text: 'thread-own' });

    producer.begin({ id: 64, key: startKey, label: 'startRun', startedAt: 64 });
    registry.update(64, 'threadId', resolved('thread-1', 64));
    expect(answer(65)).toMatchObject({ kind: 'value', text: 'thread-1' });

    registry.update(65, 'threadId', { state: 'failed', reason: 'the body has no threadId' });
    expect(answer(66)).toEqual({
      kind: 'failed',
      message: 'continue › threadId failed: the body has no threadId.',
    });
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
    expect(captures.lookup.bare('threadId')).toMatchObject({ kind: 'value', text: 'thread-1' });

    captures.observer({ id: 15, label: 'continue', wallStartedAt: 0, sensitiveValues: [] });

    expect(captures.lookup.bare('threadId')).toBeUndefined();
    expect(captures.lookup.elsewhere('threadId')).toMatchObject({ kind: 'failed' });
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
      secret: true,
      sensitive: ['session-1'],
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

  it('a header reference carries short sensitive header and credential cookie values, a body reference only from 8 characters on', async () => {
    const registry = new CaptureRegistry();
    const producer = producerRun(22);
    const captures = service(registry, 1, (key) => (key === startKey ? producer : undefined));
    captures.begin({ id: 23, key: continueKey, label: 'continue', startedAt: 23 });
    const trace: CaptureWait = {
      kind: 'response',
      requestName: 'startRun',
      reference: 'response.headers.X-Trace',
    };
    const body: CaptureWait = {
      kind: 'response',
      requestName: 'startRun',
      reference: 'response.body.*',
    };
    producer.arrive(
      head([
        ['Content-Type', 'application/json'],
        ['X-Api-Key', 'k3y-06'],
        ['Set-Cookie', 'session=q7Z'],
        ['X-Trace', 'trace k3y-06 q7Z'],
      ]),
    );
    producer.end('completed', '{"note":"k3y-06 q7Z"}');

    expect(await captures.wait([trace, body], 23, { timeoutMs: 30_000, signal: signal() })).toEqual(
      { ok: true },
    );
    expect(captures.lookup.response('startRun', 'response.headers.X-Trace')).toMatchObject({
      kind: 'value',
      text: 'trace k3y-06 q7Z',
      secret: false,
      sensitive: ['k3y-06', 'q7Z'],
    });
    expect(captures.lookup.response('startRun', 'response.body.*')).toMatchObject({
      kind: 'value',
      text: '{"note":"k3y-06 q7Z"}',
      secret: false,
      sensitive: [],
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

  it('a response reference wait follows a re-sent producer to its new run', async () => {
    let current = producerRun(70);
    const captures = service(new CaptureRegistry(), 1, (key) =>
      key === startKey ? current : undefined,
    );
    captures.begin({ id: 71, key: continueKey, label: 'continue', startedAt: 71 });
    const body = responseWait('response.body.*');

    const first = captures.wait([body], 71, { timeoutMs: 30_000, signal: signal() });
    const earlier = current;
    const resent = producerRun(72);
    current = resent;
    earlier.end('cancelled');

    expect(await first).toEqual({ ok: true });
    expect(captures.lookup.response('startRun', 'response.body.*')).toBeUndefined();
    expect(await captures.settle([body], 71, signal())).toEqual([body]);

    const second = captures.wait([body], 71, { timeoutMs: 30_000, signal: signal() });
    resent.end('completed', '{"token":"synthetic-token-2"}');

    expect(await second).toEqual({ ok: true });
    expect(captures.lookup.response('startRun', 'response.body.*')).toMatchObject({
      kind: 'value',
      text: '{"token":"synthetic-token-2"}',
      provenance: { runId: 72 },
    });
  });

  it('a Stop of the producer keeps its run, so a waiting response reference is still blocked', async () => {
    const producer = producerRun(73);
    const captures = service(new CaptureRegistry(), 1, (key) =>
      key === startKey ? producer : undefined,
    );
    captures.begin({ id: 74, key: continueKey, label: 'continue', startedAt: 74 });

    const waiting = captures.wait([sessionWait], 74, { timeoutMs: 30_000, signal: signal() });
    producer.end('cancelled');

    expect(await waiting).toEqual({ ok: true });
    expect(captures.lookup.response('startRun', 'response.headers.X-Session')).toEqual({
      kind: 'failed',
      message:
        'startRun › response.headers.X-Session failed: startRun was cancelled before response.headers.X-Session resolved.',
    });
  });

  it('a response reference waiting when the captures are cleared does not read the run that started before', async () => {
    const registry = new CaptureRegistry();
    const producer = producerRun(75);
    registry.begin({ id: 75, key: startKey, label: 'startRun', startedAt: 75 }, []);
    const captures = service(registry, 1, (key) => (key === startKey ? producer : undefined));
    captures.begin({ id: 76, key: continueKey, label: 'continue', startedAt: 76 });
    const body = responseWait('response.body.*');

    const waiting = captures.wait([body], 76, { timeoutMs: 30_000, signal: signal() });
    registry.clear();
    producer.end('completed', '{"token":"synthetic-token-restricted"}');

    expect(await waiting).toEqual({ ok: true });
    expect(captures.lookup.response('startRun', 'response.body.*')).toBeUndefined();
    expect(producer.reads).toEqual([]);
    expect(await captures.settle([body], 76, signal())).toEqual([]);
    expect(captures.lookup.response('startRun', 'response.body.*')).toEqual({
      kind: 'not-run',
      label: 'startRun',
      producerName: 'startRun',
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
      message: 'continue cannot use its own response.',
    });
  });

  it('a wait that timed out does not read the body when the producer finishes later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const producer = producerRun(24);
    const captures = service(new CaptureRegistry(), 1, () => producer);
    captures.begin({ id: 25, key: continueKey, label: 'continue', startedAt: 25 });

    const waiting = captures.wait([responseWait('response.body.*')], 25, {
      timeoutMs: 30_000,
      signal: signal(),
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await waiting).toMatchObject({ ok: false });
    producer.end('completed', '{"token":"synthetic-token"}');
    await vi.advanceTimersByTimeAsync(0);
    await new Promise((resolve) => setImmediate(resolve));

    expect(producer.reads).toEqual([]);
    expect(captures.lookup.response('startRun', 'response.body.*')).toBeUndefined();
  });

  it('{{continue.threadId}} inside continue reports its own failed capture', () => {
    const registry = new CaptureRegistry();
    const earlier = service(registry, 1);
    earlier.begin({ id: 26, key: continueKey, label: 'continue', startedAt: 26 });
    registry.update(26, 'threadId', { state: 'failed', reason: 'the body has no threadId' });
    const captures = service(registry, 1);
    captures.begin({ id: 27, key: continueKey, label: 'continue', startedAt: 27 });

    expect(captures.lookup.request('continue', 'threadId')).toEqual({
      kind: 'failed',
      message: 'continue › threadId failed: the body has no threadId.',
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

describe('CaptureService.settle', () => {
  it('evaluates response references whose producer is done and keeps every other wait', async () => {
    const registry = new CaptureRegistry();
    service(registry, 0).begin({ id: 40, key: startKey, label: 'startRun', startedAt: 40 });
    const finished = producerRun(41, 'login');
    finished.arrive(head([['X-Session', 'session-1']]));
    finished.end('completed');
    const running = producerRun(42);
    const captures = service(registry, 1, (key) =>
      key === startKey ? running : key === `${documentUri}\n@login` ? finished : undefined,
    );
    captures.begin({ id: 43, key: continueKey, label: 'continue', startedAt: 43 });
    const login = responseWait('response.headers.X-Session', 'login');

    const remaining = await captures.settle([threadWait, login, sessionWait], 43, signal());

    expect(remaining).toEqual([threadWait, sessionWait]);
    expect(captures.lookup.response('login', 'response.headers.X-Session')).toMatchObject({
      kind: 'value',
      text: 'session-1',
    });
    expect(captures.lookup.response('startRun', 'response.headers.X-Session')).toBeUndefined();
  });

  it('answers a request that never ran and the run itself at once', async () => {
    const own = producerRun(44, 'continue');
    const captures = service(new CaptureRegistry(), 1, (key) =>
      key === continueKey ? own : undefined,
    );
    captures.begin({ id: 44, key: continueKey, label: 'continue', startedAt: 44 });
    const self = responseWait('response.body.*', 'continue');

    expect(await captures.settle([sessionWait, self], 44, signal())).toEqual([]);
    expect(captures.lookup.response('startRun', 'response.headers.X-Session')).toEqual({
      kind: 'not-run',
      label: 'startRun',
      producerName: 'startRun',
    });
    expect(captures.lookup.response('continue', 'response.body.*')).toEqual({
      kind: 'failed',
      message: 'continue cannot use its own response.',
    });
  });

  it('reads a header reference once the head is there, without waiting for the end', async () => {
    const producer = producerRun(45);
    producer.arrive(head([['X-Session', 'session-1']]));
    const captures = service(new CaptureRegistry(), 1, () => producer);
    captures.begin({ id: 46, key: continueKey, label: 'continue', startedAt: 46 });
    const body = responseWait('response.body.*');

    expect(await captures.settle([sessionWait, body], 46, signal())).toEqual([body]);
    expect(captures.lookup.response('startRun', 'response.headers.X-Session')).toMatchObject({
      kind: 'value',
      text: 'session-1',
    });
  });
});

describe('response references and secrets', () => {
  const files = useCaptureWorker();

  it('a value is sensitive when its header or last JSONPath name looks like a credential', async () => {
    const producer = producerRun(50);
    producer.arrive(
      head([
        ['Content-Type', 'application/json'],
        ['Authorization', 'Bearer synthetic-bearer'],
        ['X-Request-Id', 'request-1'],
      ]),
    );
    producer.end('completed', '{"data":{"accessToken":"synthetic-access"},"id":"item-1"}');
    const captures = service(new CaptureRegistry(), 1, () => producer, files().worker);
    captures.begin({ id: 51, key: continueKey, label: 'continue', startedAt: 51 });
    const references = [
      'response.headers.Authorization',
      'response.headers.X-Request-Id',
      "response.body.$.data['accessToken']",
      'response.body.$.id',
    ];

    await captures.settle(
      references.map((reference) => responseWait(reference)),
      51,
      signal(),
    );

    expect(
      references.map((reference) => {
        const result = captures.lookup.response('startRun', reference);
        return result?.kind === 'value' ? [result.text, result.secret] : result;
      }),
    ).toEqual([
      ['Bearer synthetic-bearer', true],
      ['request-1', false],
      ['synthetic-access', true],
      ['item-1', false],
    ]);
  });

  it("a value is sensitive when it equals a secret capture of the producer's run", async () => {
    const registry = new CaptureRegistry();
    service(registry, 0).begin({ id: 52, key: startKey, label: 'startRun', startedAt: 52 });
    registry.update(52, 'sessionToken', resolved('synthetic-session', 52, true));
    const producer = producerRun(52);
    producer.arrive(
      head([
        ['X-Echo', 'synthetic-session'],
        ['X-Plain', 'plain-1'],
      ]),
    );
    const captures = service(registry, 1, () => producer);
    captures.begin({ id: 53, key: continueKey, label: 'continue', startedAt: 53 });

    await captures.settle(
      [responseWait('response.headers.X-Echo'), responseWait('response.headers.X-Plain')],
      53,
      signal(),
    );

    expect(captures.lookup.response('startRun', 'response.headers.X-Echo')).toMatchObject({
      text: 'synthetic-session',
      secret: true,
    });
    expect(captures.lookup.response('startRun', 'response.headers.X-Plain')).toMatchObject({
      text: 'plain-1',
      secret: false,
    });
  });

  it("a value is sensitive while a secret capture of the producer's run is still pending", async () => {
    const registry = new CaptureRegistry();
    service(registry, 0).begin({ id: 58, key: startKey, label: 'startRun', startedAt: 58 });
    const producer = producerRun(58);
    producer.arrive(head([['X-Sid', 'synthetic-sid']]));
    producer.end('completed');
    const captures = service(registry, 1, () => producer);
    captures.begin({ id: 59, key: continueKey, label: 'continue', startedAt: 59 });

    await captures.settle([responseWait('response.headers.X-Sid')], 59, signal());

    expect(registry.get(startKey, 'sessionToken')?.result).toEqual({ state: 'pending' });
    expect(captures.lookup.response('startRun', 'response.headers.X-Sid')).toMatchObject({
      text: 'synthetic-sid',
      secret: true,
    });
  });

  it('a sensitive response value is masked when the reference is described', async () => {
    const producer = producerRun(54);
    producer.arrive(head([['Authorization', 'Bearer synthetic-bearer']]));
    const captures = service(new CaptureRegistry(), 1, () => producer);
    captures.begin({ id: 55, key: continueKey, label: 'continue', startedAt: 55 });
    await captures.settle([responseWait('response.headers.Authorization')], 55, signal());

    expect(
      describeReference(
        file,
        'startRun.response.headers.Authorization',
        testSources({ captures: captures.lookup }),
      ),
    ).toMatchObject({ kind: 'value', value: '••••••', sensitive: true });
  });

  it('stopping a response evaluation kills its JSONPath child', async () => {
    const producer = producerRun(56);
    producer.arrive(head([['Content-Type', 'application/json']]));
    producer.end('completed', '{"token":"synthetic-token"}');
    const hanging = files().script('hanging', 'setInterval(() => undefined, 1000);');
    const captures = service(new CaptureRegistry(), 1, () => producer, hanging);
    captures.begin({ id: 57, key: continueKey, label: 'continue', startedAt: 57 });
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 100);

    await captures.settle([responseWait('response.body.$.token')], 57, controller.signal);

    await expectNoChild();
    expect(captures.lookup.response('startRun', 'response.body.$.token')).toBeUndefined();
  });
});

describe('the order of a bare name', () => {
  const apiUri = 'file:///api.http';
  const otherKey = 'file:///other.http\n@seed';
  const apiLines = [
    '@baseUrl = https://api.example.test',
    '',
    '###',
    '# @name me',
    'GET {{baseUrl}}/me',
    'Authorization: Bearer {{$secret token}}',
  ];

  function seed(registry: CaptureRegistry, name: string, id = 90): void {
    registry.begin({ id, key: otherKey, label: 'seed', startedAt: id }, [{ name, secret: false }]);
  }

  function resolveIn(
    registry: CaptureRegistry,
    lines: string[],
    sources: Partial<VariableSources> = {},
  ): Resolution {
    const parsed = parseHttpFile(lines.join('\n'));
    const index = parsed.requests.length - 1;
    const request = parsed.requests[index];
    if (!request) {
      throw new Error('expected a request');
    }
    const captures = new CaptureService({
      registry,
      documentUri: apiUri,
      file: parsed,
      request,
      workerFile: missingWorker,
      runs: () => undefined,
    });
    captures.begin({
      id: 100,
      key: requestKey(apiUri, request, index),
      label: request.name ?? 'request',
      startedAt: 100,
    });
    return resolveRequest(parsed, request, testSources({ ...sources, captures: captures.lookup }));
  }

  it("another document's capture neither replaces a file variable nor is waited on while pending", () => {
    const registry = new CaptureRegistry();
    const secrets = new Map([['token', 'synthetic-token-55aa']]);
    seed(registry, 'baseUrl');

    const pending = resolveIn(registry, apiLines, { secrets });
    registry.update(90, 'baseUrl', resolved('https://attacker.invalid/collect', 90));
    const replaced = resolveIn(registry, apiLines, { secrets });

    for (const resolution of [replaced, pending]) {
      expect(resolution).toMatchObject({
        ok: true,
        request: {
          url: 'https://api.example.test/me',
          headers: [{ name: 'Authorization', value: 'Bearer synthetic-token-55aa' }],
        },
      });
    }
  });

  it("a request's previous value counts as secret when its run's secret capture was still pending at the re-send", () => {
    const lines = [
      '# @name page',
      '# @capture cursor = body.next',
      '# @capture secret token = body.token',
      'GET https://api.example.test/items?cursor={{cursor}}',
    ];
    const earlier = (tokenResolves: boolean): CaptureRegistry => {
      const registry = new CaptureRegistry();
      registry.begin({ id: 99, key: `${apiUri}\n@page`, label: 'page', startedAt: 99 }, [
        { name: 'cursor', secret: false },
        { name: 'token', secret: true },
      ]);
      registry.update(99, 'cursor', resolved('cursor-2', 99));
      if (tokenResolves) {
        registry.update(99, 'token', resolved('synthetic-token-2', 99, true));
      }
      return registry;
    };

    expect(resolveIn(earlier(false), lines)).toMatchObject({
      ok: true,
      request: { url: 'https://api.example.test/items?cursor=cursor-2' },
      sensitiveValues: ['cursor-2'],
    });
    expect(resolveIn(earlier(true), lines)).toMatchObject({
      ok: true,
      request: { url: 'https://api.example.test/items?cursor=cursor-2' },
      sensitiveValues: [],
    });
  });

  it('a capture of a run whose secret capture is pending is secret for resolution, not for its displays', () => {
    const registry = new CaptureRegistry();
    const lines = [
      '# @name login',
      '# @capture location = headers["location"]',
      '# @capture secret code = body.code',
      'POST https://api.example.test/login',
      '',
      '###',
      '# @name me',
      'GET https://api.example.test/me',
      'X-Location: {{location}}',
      'X-Named: {{login.location}}',
    ];
    registry.begin({ id: 98, key: `${apiUri}\n@login`, label: 'login', startedAt: 98 }, [
      { name: 'location', secret: false },
      { name: 'code', secret: true },
    ]);
    registry.update(98, 'location', resolved('https://cb.example.test/cb', 98));
    const parsed = parseHttpFile(lines.join('\n'));
    const editor = testSources({ captures: captureLookup(registry, apiUri, parsed, new Map()) });

    expect(resolveIn(registry, lines)).toMatchObject({
      ok: true,
      sensitiveValues: ['https://cb.example.test/cb'],
    });
    expect(describeReference(parsed, 'location', editor)).toMatchObject({
      kind: 'value',
      value: 'https://cb.example.test/cb',
      sensitive: false,
    });
    registry.update(98, 'code', resolved('synthetic-code-1', 98, true));
    expect(resolveIn(registry, lines)).toMatchObject({ ok: true, sensitiveValues: [] });
  });

  it('a capture of a request deleted from this document no longer outranks the file variable, in sending or in the hover', () => {
    const registry = new CaptureRegistry();
    const pasted = ['###', '# @capture baseUrl = body.u', 'GET https://probe.invalid/config'];
    const withPasted = parseHttpFile([...apiLines, '', ...pasted].join('\n'));
    const producer = withPasted.requests[1];
    if (!producer) {
      throw new Error('expected the pasted producer');
    }
    const pastedKey = requestKey(apiUri, producer, 1);
    registry.begin({ id: 97, key: pastedKey, label: 'GET probe', startedAt: 97 }, [
      { name: 'baseUrl', secret: false },
    ]);
    registry.update(97, 'baseUrl', resolved('https://attacker.invalid/collect', 97));
    const secrets = new Map([['token', 'synthetic-token-55aa']]);

    const whilePasted = resolveIn(registry, [
      ...apiLines,
      '',
      ...pasted,
      '',
      '###',
      'GET {{baseUrl}}/me',
    ]);
    const deleted = resolveIn(registry, apiLines, { secrets });
    const parsed = parseHttpFile(apiLines.join('\n'));

    expect(whilePasted).toMatchObject({
      ok: true,
      request: { url: 'https://attacker.invalid/collect/me' },
    });
    expect(deleted).toMatchObject({
      ok: true,
      request: {
        url: 'https://api.example.test/me',
        headers: [{ name: 'Authorization', value: 'Bearer synthetic-token-55aa' }],
      },
    });
    expect(
      describeReference(
        parsed,
        'baseUrl',
        testSources({ captures: captureLookup(registry, apiUri, parsed, new Map()) }),
      ),
    ).toMatchObject({ kind: 'value', value: 'https://api.example.test', origin: 'file variable' });
  });

  it("another document's capture still applies when nothing else defines the name", () => {
    const registry = new CaptureRegistry();
    seed(registry, 'tenant');
    const lines = ['GET https://api.example.test/me?tenant={{tenant}}'];

    expect(resolveIn(registry, lines)).toEqual({
      ok: false,
      problems: [],
      waits: [{ kind: 'capture', request: otherKey, name: 'tenant', label: 'seed' }],
    });
    registry.update(90, 'tenant', resolved('tenant-other', 90));
    expect(resolveIn(registry, lines)).toMatchObject({
      ok: true,
      request: { url: 'https://api.example.test/me?tenant=tenant-other' },
    });
  });

  it('a producer in this document that never ran gives way to an environment value', () => {
    const lines = [
      '# @name login',
      '# @capture tenant = body.tenant',
      'POST https://api.example.test/login',
      '',
      '###',
      '# @name me',
      'GET https://api.example.test/me?tenant={{tenant}}',
    ];

    expect(
      resolveIn(new CaptureRegistry(), lines, {
        environmentName: 'dev',
        environment: sourced({ tenant: 'tenant-env' }, 'dev environment (settings)'),
      }),
    ).toMatchObject({
      ok: true,
      request: { url: 'https://api.example.test/me?tenant=tenant-env' },
    });
  });

  it('a pending capture in this document is waited on even when a file variable has its name', () => {
    const registry = new CaptureRegistry();
    const lines = [
      '@tenant = tenant-file',
      '',
      '# @name login',
      '# @capture tenant = body.tenant',
      'POST https://api.example.test/login',
      '',
      '###',
      '# @name me',
      'GET https://api.example.test/me?tenant={{tenant}}',
    ];
    const loginKey = `${apiUri}\n@login`;
    registry.begin({ id: 95, key: loginKey, label: 'login', startedAt: 95 }, [
      { name: 'tenant', secret: false },
    ]);

    expect(resolveIn(registry, lines)).toEqual({
      ok: false,
      problems: [],
      waits: [{ kind: 'capture', request: loginKey, name: 'tenant', label: 'login' }],
    });
    registry.update(95, 'tenant', resolved('tenant-captured', 95));
    expect(resolveIn(registry, lines)).toMatchObject({
      ok: true,
      request: { url: 'https://api.example.test/me?tenant=tenant-captured' },
    });
  });

  it("a hover on {{baseUrl}} shows the file variable that sending uses, not another document's capture", () => {
    const registry = new CaptureRegistry();
    seed(registry, 'baseUrl');
    registry.update(90, 'baseUrl', resolved('https://attacker.invalid/collect', 90));
    const parsed = parseHttpFile(apiLines.join('\n'));

    expect(
      describeReference(
        parsed,
        'baseUrl',
        testSources({ captures: captureLookup(registry, apiUri, parsed, new Map()) }),
      ),
    ).toEqual({
      kind: 'value',
      value: 'https://api.example.test',
      origin: 'file variable',
      sensitive: false,
    });
  });

  it('a name only another document captures is not reported as undefined', () => {
    const registry = new CaptureRegistry();
    seed(registry, 'tenant');
    registry.update(90, 'tenant', resolved('tenant-other', 90));
    const parsed = parseHttpFile('GET https://api.example.test/me?tenant={{tenant}}');

    expect(
      variableDiagnostics(
        parsed,
        testSources({ captures: captureLookup(registry, apiUri, parsed, new Map()) }),
      ),
    ).toEqual([]);
  });
});
