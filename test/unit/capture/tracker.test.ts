import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CaptureTracker,
  type CaptureDefinition,
  type CaptureResult,
} from '../../../src/capture/tracker';
import type { EventKind, JsonValue, SseFields, StreamEvent } from '../../../src/events/model';
import { SpillArea, type SpillFile } from '../../../src/events/spill';
import { defaultSpillLimits } from '../../../src/streaming/limits';
import { parseExpression } from '../../../src/expressions/parse';
import type { RunAccess, RunEnd } from '../../../src/runs/observer';
import type { ResponseHead } from '../../../src/transport/model';
import { expectNoChild, longestStall, missingWorker, useCaptureWorker } from './worker';

const encoder = new TextEncoder();
const mebibyte = 1_048_576;

function capture(name: string, text: string, secret = false): CaptureDefinition {
  const parsed = parseExpression(text, 'capture');
  if (!parsed.ok) {
    throw new Error(`${text}: ${parsed.error.message}`);
  }
  return { name, secret, expression: parsed.expr, text };
}

interface EventOptions {
  kind?: EventKind;
  sse?: SseFields;
  offset?: number;
  length?: number;
}

interface Harness {
  tracker: CaptureTracker;
  results: Map<string, CaptureResult>;
  calls: string[];
  send(value: JsonValue, options?: EventOptions): StreamEvent;
}

function harness(definitions: CaptureDefinition[], workerFile = missingWorker): Harness {
  const results = new Map<string, CaptureResult>();
  const calls: string[] = [];
  const tracker = new CaptureTracker(
    { id: 7, label: 'startRun' },
    definitions,
    (name, result) => {
      calls.push(name);
      results.set(name, result);
    },
    workerFile,
  );
  let index = 0;
  return {
    tracker,
    results,
    calls,
    send(value, options = {}) {
      index += 1;
      const event: StreamEvent = {
        index,
        time: index * 10,
        offset: options.offset ?? index * 64,
        length: options.length ?? 64,
        line: index,
        kind: options.kind ?? 'json',
        value,
        label: undefined,
        sse: options.sse,
        marker: undefined,
        error: undefined,
        unterminated: false,
      };
      tracker.event(event);
      return event;
    },
  };
}

function head(contentType: string, headers: [string, string][] = []): ResponseHead {
  return {
    httpVersion: '1.1',
    status: 200,
    statusText: 'OK',
    headers: [['Content-Type', contentType], ...headers],
  };
}

const ndjsonHead = head('application/x-ndjson');

interface EndOptions {
  body?: string | Uint8Array;
  contentType?: string;
  reply?: string;
  recognised?: boolean;
  truncated?: boolean;
  spill?: string;
}

function completed(
  format: 'ndjson' | 'sse' | 'json' | 'text',
  options: EndOptions = {},
): Extract<RunEnd, { kind: 'completed' }> {
  const bytes =
    typeof options.body === 'string' ? encoder.encode(options.body) : (options.body ?? undefined);
  return {
    kind: 'completed',
    format,
    contentType: options.contentType,
    bodyLength: bytes?.length ?? 0,
    spillPath: () => Promise.resolve(options.spill),
    reply: { recognised: options.recognised ?? true, truncated: options.truncated ?? false },
    signal: new AbortController().signal,
    readBody: (maxBytes) => Promise.resolve((bytes ?? new Uint8Array()).subarray(0, maxBytes)),
    readReply: () => Promise.resolve(options.reply ?? ''),
  };
}

function access(path: string | undefined): RunAccess {
  return {
    spillPath: () => Promise.resolve(path),
    signal: new AbortController().signal,
  };
}

function fromFile(file: { path: string; length: number }): RunEnd {
  return {
    kind: 'completed',
    format: 'json',
    contentType: 'application/json',
    bodyLength: file.length,
    spillPath: (end) => Promise.resolve(end <= file.length ? file.path : undefined),
    reply: { recognised: false, truncated: false },
    signal: new AbortController().signal,
    readBody: () => Promise.reject(new Error('the host read the body')),
    readReply: () => Promise.resolve(''),
  };
}

const spillRoots: string[] = [];

afterEach(() => {
  for (const root of spillRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface SpilledEvents {
  path: string;
  ranges: { offset: number; length: number }[];
}

async function spilledEvents(blocks: string[]): Promise<SpilledEvents> {
  const ranges: { offset: number; length: number }[] = [];
  let offset = 0;
  for (const block of blocks) {
    const length = encoder.encode(block).length;
    ranges.push({ offset, length });
    offset += length;
  }
  const file = await spilled(encoder.encode(blocks.join('')));
  return { path: file.path, ranges };
}

async function spilled(body: Uint8Array): Promise<{ path: string; length: number }> {
  const root = mkdtempSync(path.join(tmpdir(), 'streamscope-capture-spill-'));
  spillRoots.push(root);
  const area = await SpillArea.open(root);
  const file = await area.create();
  file.append(body);
  await file.finish();
  return { path: file.path, length: body.length };
}

function resolved(text: string, event: number | undefined, path: string, secret = false) {
  return {
    state: 'resolved',
    text,
    secret,
    provenance: { runId: 7, event, path, time: expect.any(Number) as unknown },
  };
}

function failed(reason: string): CaptureResult {
  return { state: 'failed', reason };
}

describe('CaptureTracker', () => {
  const files = useCaptureWorker();

  it('first(…) resolves at the matching event and stops evaluating', async () => {
    let reads = 0;
    const counted = (type: string, fields: Record<string, JsonValue> = {}): JsonValue => {
      const value: Record<string, JsonValue> = { ...fields };
      Object.defineProperty(value, 'type', {
        enumerable: true,
        get: () => {
          reads += 1;
          return type;
        },
      });
      return value;
    };
    const run = harness([capture('threadId', 'first(type == "RUN_STARTED").threadId')]);
    run.tracker.head(ndjsonHead);

    run.send(counted('TEXT_MESSAGE_START'));
    expect(run.results.size).toBe(0);
    run.send(counted('RUN_STARTED', { threadId: 'thread-1' }));
    expect(run.results.get('threadId')).toEqual(resolved('thread-1', 2, 'threadId'));
    const readsAtMatch = reads;
    for (let count = 0; count < 100; count += 1) {
      run.send(counted('RUN_STARTED', { threadId: 'thread-2' }));
    }
    await run.tracker.end(completed('ndjson'));

    expect(readsAtMatch).toBe(2);
    expect(reads).toBe(readsAtMatch);
    expect(run.calls).toEqual(['threadId']);
  });

  it('nth(2, …) resolves at the second match', () => {
    const run = harness([capture('second', 'nth(2, type == "TEXT_MESSAGE_CONTENT").delta')]);
    run.tracker.head(ndjsonHead);

    run.send({ type: 'RUN_STARTED' });
    run.send({ type: 'TEXT_MESSAGE_CONTENT', delta: 'Hel' });
    expect(run.results.size).toBe(0);
    run.send({ type: 'TEXT_MESSAGE_CONTENT', delta: 'lo' });

    expect(run.results.get('second')).toEqual(resolved('lo', 3, 'delta'));
  });

  it('last(…), count(…) and text resolve at the end', async () => {
    const run = harness([
      capture('lastDelta', 'last(type == "TEXT_MESSAGE_CONTENT").delta'),
      capture('deltas', 'count(type == "TEXT_MESSAGE_CONTENT")'),
      capture('reply', 'text'),
    ]);
    run.tracker.head(ndjsonHead);

    run.send({ type: 'RUN_STARTED' });
    run.send({ type: 'TEXT_MESSAGE_CONTENT', delta: 'Hel' });
    run.send({ type: 'TEXT_MESSAGE_CONTENT', delta: 'lo' });
    run.send({ type: 'RUN_FINISHED' });
    expect(run.results.size).toBe(0);
    await run.tracker.end(completed('ndjson', { reply: 'Hello' }));

    expect(run.results.get('lastDelta')).toEqual(resolved('lo', 3, 'delta'));
    expect(run.results.get('deltas')).toEqual(resolved('2', undefined, ''));
    expect(run.results.get('reply')).toEqual(resolved('Hello', undefined, ''));
  });

  it('head-only expressions resolve at the headers', () => {
    const run = harness([
      capture('code', 'status'),
      capture('token', 'headers["X-Session-Token"]', true),
      capture('trace', 'headers["x-trace"]'),
      capture('session', 'cookies.session'),
      capture('allHeaders', 'headers'),
      capture('allCookies', 'cookies'),
      capture('constant', '"fixed"'),
    ]);

    run.tracker.head(
      head('application/json', [
        ['X-Session-Token', 'token-1'],
        ['X-Trace', 'a'],
        ['x-trace', 'b'],
        ['Set-Cookie', 'session=abc; Path=/'],
        ['Set-Cookie', 'theme=dark'],
        ['Set-Cookie', 'session=def; HttpOnly'],
        ['Set-Cookie', 'flag'],
      ]),
    );

    expect(run.results.get('code')).toEqual(resolved('200', undefined, ''));
    expect(run.results.get('token')).toEqual(
      resolved('token-1', undefined, '["x-session-token"]', true),
    );
    expect(run.results.get('trace')).toEqual(resolved('a, b', undefined, '["x-trace"]'));
    expect(run.results.get('session')).toEqual(resolved('def', undefined, 'session'));
    expect(run.results.get('allHeaders')).toEqual(
      resolved(
        JSON.stringify({
          'content-type': 'application/json',
          'x-session-token': 'token-1',
          'x-trace': 'a, b',
          'set-cookie': 'session=abc; Path=/, theme=dark, session=def; HttpOnly, flag',
        }),
        undefined,
        '',
      ),
    );
    expect(run.results.get('allCookies')).toEqual(
      resolved('{"session":"def","theme":"dark"}', undefined, ''),
    );
    expect(run.results.get('constant')).toEqual(resolved('fixed', undefined, ''));
  });

  it('keeps a header named like an Object.prototype member as an own field', () => {
    const run = harness([capture('proto', 'headers["__proto__"]'), capture('cookie', 'cookies')]);

    run.tracker.head(
      head('text/plain', [
        ['__proto__', 'header-value'],
        ['Set-Cookie', '__proto__=cookie-value'],
      ]),
    );

    expect(run.results.get('proto')).toEqual(resolved('header-value', undefined, '__proto__'));
    expect(run.results.get('cookie')).toEqual(
      resolved('{"__proto__":"cookie-value"}', undefined, ''),
    );
  });

  it('a late event resolves after earlier ones did not match', () => {
    const run = harness([capture('messageId', 'first(type == "RUN_FINISHED").result.messageId')]);
    run.tracker.head(ndjsonHead);

    for (let count = 0; count < 50; count += 1) {
      run.send({ type: 'TEXT_MESSAGE_CONTENT', delta: 'x' });
    }
    expect(run.results.size).toBe(0);
    run.send({ type: 'RUN_FINISHED', result: { messageId: 'msg-1' } });

    expect(run.results.get('messageId')).toEqual(resolved('msg-1', 51, 'result.messageId'));
  });

  it('no matching event fails at the end with the decision 10 reason, counting malformed events', async () => {
    const run = harness([
      capture('threadId', 'first(type == "RUN_STARTED")'),
      capture('third', 'nth(3, type == "TEXT_MESSAGE_CONTENT")'),
      capture('finished', 'last(type == "RUN_FINISHED")'),
    ]);
    run.tracker.head(ndjsonHead);

    run.send({ type: 'TEXT_MESSAGE_CONTENT', delta: 'a' });
    run.send('{"type":"RUN_STARTED"', { kind: 'malformed' });
    for (let count = 0; count < 10; count += 1) {
      run.send({ type: 'TEXT_MESSAGE_CONTENT', delta: 'b' });
    }
    run.send('{"type":"RUN_STARTED","padding":"', { kind: 'oversize' });
    run.send(' keep-alive', { kind: 'comment' });
    run.send('{"type":"RUN_FINISHED"', { kind: 'malformed' });
    run.send('{"type":"RUN_FINISHED"', { kind: 'malformed' });
    await run.tracker.end(completed('ndjson'));

    expect(run.results.get('threadId')).toEqual(
      failed('no event matched first(type == "RUN_STARTED") (16 events, 3 malformed, 1 too large)'),
    );
    expect(run.results.get('third')).toEqual(
      resolved(JSON.stringify({ type: 'TEXT_MESSAGE_CONTENT', delta: 'b' }), 4, ''),
    );
    expect(run.results.get('finished')).toEqual(
      failed('no event matched last(type == "RUN_FINISHED") (16 events, 3 malformed, 1 too large)'),
    );
  });

  it('counts events in the decision 10 form', async () => {
    const run = harness([capture('threadId', 'first(type == "RUN_STARTED")')]);
    run.tracker.head(ndjsonHead);

    for (let count = 0; count < 11; count += 1) {
      run.send({ type: 'TEXT_MESSAGE_CONTENT' });
    }
    run.send('{"type":', { kind: 'malformed' });
    await run.tracker.end(completed('ndjson'));

    expect(run.results.get('threadId')).toEqual(
      failed('no event matched first(type == "RUN_STARTED") (12 events, 1 malformed)'),
    );
  });

  it('says how many events matched when nth(…) found too few', async () => {
    const run = harness([capture('third', 'nth(3, type == "A")'), capture('one', 'first()')]);
    run.tracker.head(ndjsonHead);

    run.send({ type: 'A' });
    run.send({ type: 'B' });
    run.send({ type: 'A' });
    await run.tracker.end(completed('ndjson'));
    const empty = harness([capture('one', 'first()')]);
    await empty.tracker.end(completed('ndjson'));

    expect(run.results.get('third')).toEqual(
      failed('only 2 events matched nth(3, type == "A") (3 events)'),
    );
    expect(empty.results.get('one')).toEqual(failed('no event matched first() (0 events)'));
  });

  it('malformed events never match', async () => {
    const run = harness(
      [
        capture('any', 'first()'),
        capture('started', 'first(@ == "{\\"type\\":\\"RUN_STARTED\\"")'),
        capture('total', 'count()'),
        capture('everything', 'all()'),
      ],
      files().worker,
    );
    run.tracker.head(ndjsonHead);

    run.send('{"type":"RUN_STARTED"', { kind: 'malformed' });
    run.send('{"type":"RUN_STARTED"…', { kind: 'oversize' });
    run.send(' ping', {
      kind: 'comment',
      sse: { event: undefined, id: undefined, retry: undefined },
    });
    expect(run.results.size).toBe(0);
    run.send('[DONE]', { kind: 'text', sse: { event: 'done', id: '9', retry: undefined } });
    await run.tracker.end(completed('sse'));

    expect(run.results.get('any')).toEqual(resolved('[DONE]', 4, ''));
    expect(run.results.get('started')).toEqual(
      failed(
        'no event matched first(@ == "{\\"type\\":\\"RUN_STARTED\\"") (4 events, 1 malformed, 1 too large)',
      ),
    );
    expect(run.results.get('total')).toEqual(resolved('1', undefined, ''));
    expect(run.results.get('everything')).toEqual(resolved('["[DONE]"]', undefined, ''));
  });

  it('reads the SSE fields of an event in a condition', () => {
    const run = harness([
      capture('delta', 'first(@sse.event == "content_block_delta").delta.text'),
    ]);
    run.tracker.head(head('text/event-stream'));

    run.send(
      { type: 'message_start' },
      { sse: { event: 'message_start', id: undefined, retry: undefined } },
    );
    run.send(
      { delta: { text: 'Syn' } },
      { sse: { event: 'content_block_delta', id: '2', retry: undefined } },
    );

    expect(run.results.get('delta')).toEqual(resolved('Syn', 2, 'delta.text'));
  });

  it('a cancelled, failed or blocked run fails pending captures with its reason', async () => {
    const definitions = [
      capture('threadId', 'first(type == "RUN_STARTED").threadId'),
      capture('code', 'status'),
      capture('fallback', 'last(type == "RUN_FINISHED") | default("none")'),
    ];
    const cancelled = harness(definitions);
    const failedRun = harness(definitions);
    const blocked = harness(definitions);

    cancelled.tracker.head(ndjsonHead);
    failedRun.tracker.head(ndjsonHead);
    await cancelled.tracker.end({ kind: 'cancelled' });
    await failedRun.tracker.end({ kind: 'failed', message: 'The connection was reset.' });
    await blocked.tracker.end({
      kind: 'blocked',
      message: '`{{missing}}` is not defined in this file or `$shared` (no environment selected).',
    });

    expect(cancelled.results.get('code')).toEqual(resolved('200', undefined, ''));
    expect(cancelled.results.get('threadId')).toEqual(
      failed('startRun was cancelled before threadId resolved'),
    );
    expect(cancelled.results.get('fallback')).toEqual(
      failed('startRun was cancelled before fallback resolved'),
    );
    expect(failedRun.results.get('threadId')).toEqual(
      failed('startRun failed before threadId resolved: The connection was reset'),
    );
    expect(blocked.results.get('code')).toEqual(
      failed(
        'startRun was not sent: `{{missing}}` is not defined in this file or `$shared` (no environment selected)',
      ),
    );
    expect(blocked.calls).toEqual(['threadId', 'code', 'fallback']);
  });

  it('a missing path in the matching event fails at once, naming the event and the segment', () => {
    const run = harness([
      capture('messageId', 'first(type == "RUN_FINISHED").result.messageId'),
      capture('second', 'nth(2, type == "A")[3]'),
    ]);
    run.tracker.head(ndjsonHead);

    run.send({ type: 'A' });
    run.send({ type: 'TEXT_MESSAGE_CONTENT' });
    run.send({ type: 'RUN_FINISHED', result: {} });
    expect(run.results.get('messageId')).toEqual(
      failed('event 3 has no value at result.messageId ("messageId" is missing)'),
    );
    run.send({ type: 'A' });

    expect(run.results.get('second')).toEqual(
      failed('event 4 has no value at [3] (the value is an object, not a list)'),
    );
  });

  it('names the source of a missing path at the end', async () => {
    const run = harness(
      [
        capture('code', 'status.value'),
        capture('header', 'headers["x-missing"]'),
        capture('cookie', 'cookies.missing'),
        capture('ids', 'all(type == "A").id'),
        capture('total', 'count().value'),
        capture('reply', 'text.value'),
        capture('lastMissing', 'last(type == "A").missing'),
      ],
      files().worker,
    );
    run.tracker.head(ndjsonHead);

    run.send({ type: 'A', id: 'a-1' });
    run.send({ type: 'A' });
    await run.tracker.end(completed('ndjson', { reply: 'Hello' }));

    expect(run.results.get('code')).toEqual(
      failed('the status has no value at value (the value is a number, not an object)'),
    );
    expect(run.results.get('header')).toEqual(
      failed('the headers have no value at ["x-missing"] ("x-missing" is missing)'),
    );
    expect(run.results.get('cookie')).toEqual(
      failed('the cookies have no value at missing ("missing" is missing)'),
    );
    expect(run.results.get('ids')).toEqual(
      failed('the matching events have no value at id ("id" is missing) in result 2'),
    );
    expect(run.results.get('total')).toEqual(
      failed('the count has no value at value (the value is a number, not an object)'),
    );
    expect(run.results.get('reply')).toEqual(
      failed('the reply text has no value at value (the value is a string, not an object)'),
    );
    expect(run.results.get('lastMissing')).toEqual(
      failed('event 2 has no value at missing ("missing" is missing)'),
    );
  });

  it('default(…) resolves a capture whose event never arrived', async () => {
    const run = harness([
      capture('threadId', 'first(type == "RUN_STARTED").threadId | default("none")'),
    ]);
    run.tracker.head(ndjsonHead);

    run.send({ type: 'TEXT_MESSAGE_CONTENT' });
    expect(run.results.size).toBe(0);
    await run.tracker.end(completed('ndjson'));

    expect(run.results.get('threadId')).toEqual(resolved('none', undefined, ''));
  });

  it('all(…) fails after 10,000 matches and keeps no more than that', async () => {
    const run = harness([
      capture('deltas', 'all(type == "D").delta'),
      capture('total', 'count(type == "D")'),
    ]);
    run.tracker.head(ndjsonHead);
    let peak = 0;

    for (let count = 1; count <= 50_000; count += 1) {
      run.send({ type: 'D', delta: 'x' });
      peak = Math.max(peak, run.tracker.retainedValues);
      if (count === 10_000) {
        expect(run.tracker.retainedValues).toBe(10_000);
        expect(run.results.size).toBe(0);
      }
      if (count === 10_001) {
        expect(run.results.get('deltas')).toEqual(
          failed('all(type == "D") matched more than 10,000 events'),
        );
      }
    }
    await run.tracker.end(completed('ndjson'));

    expect(peak).toBe(10_000);
    expect(run.tracker.retainedValues).toBe(0);
    expect(run.results.get('total')).toEqual(resolved('50000', undefined, ''));
    expect(run.calls).toEqual(['deltas', 'total']);
  });

  it('all(…) fails past 16 MiB of matched events, keeping only ranges past 1 MiB', () => {
    const run = harness([capture('deltas', 'all(type == "D")')]);
    run.tracker.head(ndjsonHead);

    run.send({ type: 'D' }, { length: mebibyte });
    expect(run.tracker.retainedValues).toBe(1);
    for (let count = 1; count < 16; count += 1) {
      run.send({ type: 'D' }, { length: mebibyte });
    }
    expect(run.results.size).toBe(0);
    expect(run.tracker.retainedValues).toBe(0);
    expect(run.tracker.retainedRanges).toBe(16);
    run.send({ type: 'D' }, { length: 1 });

    expect(run.results.get('deltas')).toEqual(
      failed('all(type == "D") matched more than 16 MiB of events'),
    );
    expect(run.tracker.retainedRanges).toBe(0);
  });

  it('bounds the all(…) sources of one capture together', () => {
    const run = harness([capture('same', 'all(type == "A") == all(type == "B")')]);
    run.tracker.head(ndjsonHead);

    for (let count = 0; count < 6_000; count += 1) {
      run.send({ type: 'A' });
    }
    for (let count = 0; count < 4_000; count += 1) {
      run.send({ type: 'B' });
    }
    expect(run.results.size).toBe(0);
    run.send({ type: 'B' });

    expect(run.results.get('same')).toEqual(
      failed('all(type == "A") and all(type == "B") matched more than 10,000 events'),
    );
  });

  it('collects all(…) results and maps a path over them', async () => {
    const run = harness([capture('ids', 'all(type == "A").id | join(",")')], files().worker);
    run.tracker.head(ndjsonHead);

    run.send({ type: 'A', id: 'a-1' });
    run.send({ type: 'B', id: 'b-1' });
    run.send({ type: 'A', id: 'a-2' });
    await run.tracker.end(completed('ndjson'));

    expect(run.results.get('ids')).toEqual(resolved('a-1,a-2', undefined, 'id'));
  });

  it('body on an event stream fails', async () => {
    const run = harness([capture('value', 'body.x'), capture('whole', 'body')]);
    run.tracker.head(ndjsonHead);

    run.send({ x: 1 });
    await run.tracker.end(completed('ndjson'));

    const reason = 'the response is an event stream; use first(…), last(…) or all(…)';
    expect(run.results.get('value')).toEqual(failed(reason));
    expect(run.results.get('whole')).toEqual(failed(reason));
  });

  it('first(…) on a JSON body fails', async () => {
    const run = harness([
      capture('threadId', 'first(type == "RUN_STARTED").threadId'),
      capture('total', 'count()'),
      capture('reply', 'text'),
    ]);
    run.tracker.head(head('application/json'));

    await run.tracker.end(
      completed('json', { body: '{"type":"RUN_STARTED"}', contentType: 'application/json' }),
    );

    const reason = 'the response is not an event stream';
    expect(run.results.get('threadId')).toEqual(failed(reason));
    expect(run.results.get('total')).toEqual(failed(reason));
    expect(run.results.get('reply')).toEqual(failed(reason));
  });

  it('evaluates a JSON body at the end and names a missing segment', async () => {
    const run = harness([
      capture('item', 'body.items[5]'),
      capture('id', 'body.items[1].id'),
      capture('both', 'status == 200 && body.items[0].id == "a-1"'),
    ]);
    run.tracker.head(head('application/json'));

    expect(run.results.size).toBe(0);
    await run.tracker.end(
      completed('json', {
        body: '{"items":[{"id":"a-1"},{"id":"a-2"},{"id":"a-3"}]}',
        contentType: 'application/json',
      }),
    );

    expect(run.results.get('item')).toEqual(
      failed('the body has no value at items[5] (the list has 3 items)'),
    );
    expect(run.results.get('id')).toEqual(resolved('a-2', undefined, 'items[1].id'));
    expect(run.results.get('both')).toEqual(resolved('true', undefined, ''));
  });

  it('evaluates a body over 1 MiB in the worker with the head sources it needs', async () => {
    const items = Array.from({ length: 3 }, (_, index) => ({ id: `a-${String(index)}` }));
    const body = JSON.stringify({ items, padding: 'x'.repeat(2 * mebibyte) });
    const definitions = [
      capture('both', 'status == 200 && body.items[1].id == "a-1"'),
      capture('id', 'body.items[2].id'),
    ];
    const file = await spilled(encoder.encode(body));
    const run = harness(definitions, files().worker);
    const unavailable = harness(definitions);
    run.tracker.head(head('application/json'));
    unavailable.tracker.head(head('application/json'));

    await run.tracker.end(
      completed('json', { body, contentType: 'application/json', spill: file.path }),
    );
    await unavailable.tracker.end(
      completed('json', { body, contentType: 'application/json', spill: file.path }),
    );

    expect(run.results.get('both')).toEqual(resolved('true', undefined, ''));
    expect(run.results.get('id')).toEqual(resolved('a-2', undefined, 'items[2].id'));
    expect(unavailable.results.get('id')).toEqual(
      failed('evaluating the body took too long or used too much memory'),
    );
  });

  it('keeps the digits of large integers from events and bodies', async () => {
    const stream = harness([capture('id', 'first(type == "RUN_STARTED").id')]);
    const json = harness([capture('id', 'body.id')]);
    stream.tracker.head(ndjsonHead);
    json.tracker.head(head('application/json'));

    stream.send({ type: 'RUN_STARTED', id: 12345678901234567890n });
    await json.tracker.end(
      completed('json', { body: '{"id":98765432109876543210}', contentType: 'application/json' }),
    );

    expect(stream.results.get('id')).toEqual(resolved('12345678901234567890', 1, 'id'));
    expect(json.results.get('id')).toEqual(resolved('98765432109876543210', undefined, 'id'));
  });

  it('runs jsonpath() over the JSON values of a stream in the worker', async () => {
    const run = harness(
      [
        capture('messageId', 'jsonpath("$[?@.type == \'RUN_FINISHED\'].result.messageId")'),
        capture('types', 'jsonpath("$[*].type")'),
        capture('none', 'jsonpath("$[?@.type == \'NONE\']")'),
        capture(
          'mixed',
          'jsonpath("$[0].threadId") == first(type == "RUN_STARTED").threadId && status == 200',
        ),
      ],
      files().worker,
    );
    run.tracker.head(ndjsonHead);

    run.send({ type: 'RUN_STARTED', threadId: 'thread-1', runId: 'run-1' });
    run.send('{"type":', { kind: 'malformed' });
    run.send(' ping', { kind: 'comment' });
    run.send({ type: 'RUN_FINISHED', result: { messageId: 'msg-1' } });
    await run.tracker.end(completed('ndjson'));

    expect(run.results.get('messageId')).toEqual(
      resolved('msg-1', undefined, "$[?@.type == 'RUN_FINISHED'].result.messageId"),
    );
    expect(run.results.get('types')).toEqual(
      resolved('["RUN_STARTED","RUN_FINISHED"]', undefined, '$[*].type'),
    );
    expect(run.results.get('none')).toEqual(
      failed("the events have no value at $[?@.type == 'NONE'] (the query matched nothing)"),
    );
    expect(run.results.get('mixed')).toEqual(resolved('true', undefined, ''));
  });

  it('runs jsonpath() on a JSON body in the worker', async () => {
    const run = harness([capture('id', 'jsonpath("$.items[1].id")')], files().worker);
    run.tracker.head(head('application/json'));

    await run.tracker.end(
      completed('json', {
        body: '{"items":[{"id":"a-1"},{"id":"a-2"}]}',
        contentType: 'application/json',
      }),
    );

    expect(run.results.get('id')).toEqual(resolved('a-2', undefined, '$.items[1].id'));
  });

  it('fails jsonpath() over a stream of more than 10,000 events at once and drops what it kept', () => {
    const run = harness([
      capture('ids', 'jsonpath("$[*].id")'),
      capture('other', 'jsonpath("$[0].id")'),
    ]);
    run.tracker.head(ndjsonHead);

    for (let count = 1; count <= 10_000; count += 1) {
      run.send({ id: count });
    }
    expect(run.results.size).toBe(0);
    expect(run.tracker.retainedValues).toBe(10_000);
    run.send({ id: 10_001 });

    expect(run.results.get('ids')).toEqual(
      failed('jsonpath("$[*].id") reads at most 10,000 events, and the stream has more'),
    );
    expect(run.results.get('other')).toEqual(
      failed('jsonpath("$[0].id") reads at most 10,000 events, and the stream has more'),
    );
    expect(run.tracker.retainedValues).toBe(0);
  });

  it('jsonpath over events fails beyond 16 MiB of event bytes', () => {
    const run = harness([capture('ids', 'jsonpath("$[*].id")')]);
    run.tracker.head(ndjsonHead);

    for (let count = 0; count < 16; count += 1) {
      run.send({ id: count }, { length: mebibyte });
    }
    expect(run.results.size).toBe(0);
    expect(run.tracker.retainedRanges).toBe(16);
    run.send({ id: 16 }, { length: 1 });

    expect(run.results.get('ids')).toEqual(
      failed('jsonpath("$[*].id") reads at most 16 MiB of events, and the stream has more'),
    );
    expect(run.tracker.retainedRanges).toBe(0);
  });

  it('posting a 1 MiB jsonpath collection without a spill file costs the host under 50 ms', async () => {
    const run = harness([capture('first', 'jsonpath("$[0][0]")')], files().worker);
    run.tracker.head(ndjsonHead);
    const eventBytes = mebibyte / 16;
    for (let count = 0; count < 16; count += 1) {
      const tiny: JsonValue[] = Array.from({ length: Math.floor(eventBytes / 3) }, () => ({}));
      run.send(tiny, { length: eventBytes });
    }
    expect(run.tracker.retainedValues).toBe(16);

    const { stallMs } = await longestStall(() => run.tracker.end(completed('ndjson')));

    expect(stallMs).toBeLessThan(100);
    expect(run.results.get('first')).toEqual(resolved('{}', undefined, '$[0][0]'));
    await expectNoChild();
  });

  it('all() over a 16 MiB collection costs the host under 50 ms', async () => {
    const zeros = `[${'0,'.repeat(mebibyte / 2 - 2)}0]`;
    const spill = await spilledEvents(Array.from({ length: 16 }, () => `${zeros}\n`));
    const value = JSON.parse(zeros) as JsonValue;
    const run = harness(
      [capture('zeros', 'all()[?@[0] == 0][*]'), capture('last', 'all()[-1][-1]')],
      files().worker,
    );
    run.tracker.head(ndjsonHead);
    for (const range of spill.ranges) {
      run.send(value, range);
    }
    expect(run.tracker.retainedValues).toBe(0);

    const { stallMs } = await longestStall(() =>
      run.tracker.end(completed('ndjson', { spill: spill.path })),
    );

    expect(stallMs).toBeLessThan(100);
    expect(run.results.get('zeros')).toEqual(resolved('[]', undefined, '[?…][*]'));
    expect(run.results.get('last')).toEqual(resolved('0', undefined, '[-1][-1]'));
    await expectNoChild();
  });

  it('all() reads its matches from the spill file in the child', async () => {
    const blocks = [
      'event: start\ndata: {"threadId":"thread-1"}\n\n',
      'event: delta\ndata: {"n":12345678901234567890}\n\n',
      ': keep-alive\n\n',
      'event: delta\ndata: {"n":2}\n\n',
      'event: delta\ndata: [DONE]\n\n',
    ];
    const spill = await spilledEvents(blocks);
    const delta = (index: number): { offset: number; length: number } => {
      const range = spill.ranges[index];
      if (range === undefined) {
        throw new Error(`no range ${String(index)}`);
      }
      return range;
    };
    const sse = (event: string): SseFields => ({ event, id: undefined, retry: undefined });
    const echo = files().script(
      'echo-collected',
      [
        "process.once('message', (message) => {",
        '  for (const job of message.jobs) {',
        '    const collected = [...job.collected.values()].map((entry) => ({ kind: entry.kind, size: (entry.ranges ?? entry.values).length }));',
        "    process.send({ name: job.name, result: { present: true, text: JSON.stringify(collected), path: '' } });",
        '  }',
        '});',
      ].join('\n'),
    );
    const definitions = [capture('deltas', 'all(@sse.event == "delta")')];
    const real = harness(definitions, files().worker);
    const echoed = harness(definitions, echo);
    for (const run of [real, echoed]) {
      run.tracker.head(head('text/event-stream'));
      run.send({ threadId: 'host-copy' }, { ...delta(0), sse: sse('start') });
      run.send({ n: 'host-copy' }, { ...delta(1), sse: sse('delta') });
      run.send('keep-alive', { ...delta(2), kind: 'comment' });
      run.send({ n: 'host-copy' }, { ...delta(3), sse: sse('delta') });
      run.send('[DONE]', { ...delta(4), kind: 'text', sse: sse('delta') });
      await run.tracker.end(completed('sse', { spill: spill.path }));
    }

    expect(real.results.get('deltas')).toEqual(
      resolved('[{"n":12345678901234567890},{"n":2},"[DONE]"]', undefined, ''),
    );
    expect(echoed.results.get('deltas')).toEqual(
      resolved(JSON.stringify([{ kind: 'ranges', size: 6 }]), undefined, ''),
    );
  });

  it('all() without a spill file over 1 MiB fails with the message', async () => {
    const definitions = [
      capture('ids', 'all(type == "A").id'),
      capture('fallback', 'all(type == "A").id | default("none")'),
    ];
    const large = harness(definitions, files().worker);
    const small = harness(definitions, files().worker);
    for (const run of [large, small]) {
      run.tracker.head(ndjsonHead);
    }
    large.send({ type: 'A', id: 'a-1' }, { length: mebibyte });
    large.send({ type: 'A', id: 'a-2' }, { length: 1 });
    small.send({ type: 'A', id: 'a-1' }, { length: mebibyte - 1 });
    small.send({ type: 'A', id: 'a-2' }, { length: 1 });

    await large.tracker.end(completed('ndjson'));
    await small.tracker.end(completed('ndjson'));

    const unavailable = failed('the events are no longer available for this capture');
    expect(large.results.get('ids')).toEqual(unavailable);
    expect(large.results.get('fallback')).toEqual(unavailable);
    expect(small.results.get('ids')).toEqual(resolved('["a-1","a-2"]', undefined, 'id'));
  });

  it('default does not hide body on a stream, nor an event source on a body', async () => {
    const stream = harness([capture('value', 'body.x | default("none")')]);
    const json = harness([capture('first', 'first(type == "A").id | default("none")')]);
    stream.tracker.head(ndjsonHead);
    json.tracker.head(head('application/json'));

    stream.send({ x: 1 });
    await stream.tracker.end(completed('ndjson'));
    await json.tracker.end(
      completed('json', { body: '{"type":"A"}', contentType: 'application/json' }),
    );

    expect(stream.results.get('value')).toEqual(
      failed('the response is an event stream; use first(…), last(…) or all(…)'),
    );
    expect(json.results.get('first')).toEqual(failed('the response is not an event stream'));
  });

  it('text without a reply adapter fails', async () => {
    const run = harness([capture('reply', 'text'), capture('fallback', 'text | default("")')]);
    run.tracker.head(ndjsonHead);

    run.send({ value: 'not a reply' });
    await run.tracker.end(completed('ndjson', { recognised: false }));

    expect(run.results.get('reply')).toEqual(failed('the response has no recognised reply'));
    expect(run.results.get('fallback')).toEqual(failed('the response has no recognised reply'));
  });

  it('a cut-off reply fails', async () => {
    const run = harness([capture('reply', 'text')]);
    run.tracker.head(ndjsonHead);

    await run.tracker.end(completed('ndjson', { reply: 'x'.repeat(16), truncated: true }));

    expect(run.results.get('reply')).toEqual(failed('the reply is larger than 1 MiB'));
  });

  it('a large body is read from the spill file, and the message to the child carries no body bytes', async () => {
    const body = encoder.encode(
      JSON.stringify({ items: [{ id: 'a-0' }, { id: 'a-1' }], padding: 'x'.repeat(2 * mebibyte) }),
    );
    const file = await spilled(body);
    const echo = files().script(
      'echo',
      [
        'const holdsBytes = (value) =>',
        '  value instanceof Uint8Array ||',
        '  (Array.isArray(value) ? value.some(holdsBytes) :',
        "    value !== null && typeof value === 'object' && !(value instanceof Map) && Object.values(value).some(holdsBytes));",
        "process.once('message', (message) => {",
        '  for (const job of message.jobs) {',
        '    const value = { kind: message.subject.kind, path: message.subject.path, length: message.subject.length, bytes: holdsBytes(message) };',
        "    process.send({ name: job.name, result: { present: true, text: JSON.stringify(value), path: '' } });",
        '  }',
        '});',
      ].join('\n'),
    );
    const definitions = [
      capture('id', 'body.items[1].id'),
      capture('query', 'jsonpath("$.items[0].id")'),
    ];
    const real = harness(definitions, files().worker);
    const echoed = harness(definitions, echo);
    real.tracker.head(head('application/json'));
    echoed.tracker.head(head('application/json'));

    await real.tracker.end(fromFile(file));
    await echoed.tracker.end(fromFile(file));

    expect(real.results.get('id')).toEqual(resolved('a-1', undefined, 'items[1].id'));
    expect(real.results.get('query')).toEqual(resolved('a-0', undefined, '$.items[0].id'));
    expect(echoed.results.get('id')).toEqual(
      resolved(
        JSON.stringify({ kind: 'file', path: file.path, length: body.length, bytes: false }),
        undefined,
        '',
      ),
    );
    await expectNoChild();
  });

  it('fails a body over 1 MiB that no spill file holds, and sends the bytes of a smaller one', async () => {
    const body = (padding: number): string =>
      JSON.stringify({ items: [{ id: 'a-0' }, { id: 'a-1' }], padding: 'x'.repeat(padding) });
    const large = harness(
      [
        capture('id', 'body.items[1].id'),
        capture('fallback', 'body.items[1].id | default("none")'),
      ],
      files().worker,
    );
    const medium = harness([capture('id', 'body.items[1].id')], files().worker);
    large.tracker.head(head('application/json'));
    medium.tracker.head(head('application/json'));

    await large.tracker.end(
      completed('json', { body: body(2 * mebibyte), contentType: 'application/json' }),
    );
    await medium.tracker.end(
      completed('json', { body: body(512 * 1024), contentType: 'application/json' }),
    );

    const notSent = failed('the body is no longer available for this capture');
    expect(large.results.get('id')).toEqual(notSent);
    expect(large.results.get('fallback')).toEqual(notSent);
    expect(medium.results.get('id')).toEqual(resolved('a-1', undefined, 'items[1].id'));
  });

  it('starts no child for a run that was released before its captures were evaluated', async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'streamscope-released-'));
    spillRoots.push(folder);
    const marker = path.join(folder, 'started');
    const marking = files().script(
      'marking',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, ''); setInterval(() => undefined, 1000);`,
    );
    const run = harness(
      [capture('query', 'jsonpath("$.items[0]")'), capture('code', 'status')],
      marking,
    );
    run.tracker.head(head('application/json'));
    const released = new AbortController();
    released.abort();

    await run.tracker.end({
      ...completed('json', { body: '{"items":[1]}', contentType: 'application/json' }),
      signal: released.signal,
    });

    expect(run.results.get('query')).toEqual(
      failed('startRun was cancelled before query resolved'),
    );
    expect(run.results.get('code')).toEqual(resolved('200', undefined, ''));
    expect(existsSync(marker)).toBe(false);
  });

  it('an out-of-memory in the child fails the capture and leaves the host running', async () => {
    const body = encoder.encode(
      `[${'{},'.repeat(Math.floor(16_000_000 / 3))}12345678901234567890]`,
    );
    const file = await spilled(body);
    const run = harness(
      [capture('first', 'body[0]'), capture('query', 'jsonpath("$[0]")')],
      files().worker,
    );
    run.tracker.head(head('application/json'));

    await run.tracker.end(fromFile(file));

    expect(run.results.get('first')).toEqual(
      failed('evaluating the body took too long or used too much memory'),
    );
    expect(run.results.get('query')).toEqual(
      failed('jsonpath() took too long or used too much memory'),
    );
    expect(process.kill(process.pid, 0)).toBe(true);
    await expectNoChild();
  }, 30_000);

  it('fails a value larger than 1 MiB', () => {
    const run = harness([capture('big', 'first().text')]);
    run.tracker.head(ndjsonHead);

    run.send({ text: 'x'.repeat(mebibyte + 1) });

    expect(run.results.get('big')).toEqual(failed('the value is larger than 1 MiB'));
  });

  it('fails captures whose body or reply can no longer be read, and never rejects', async () => {
    const definitions = [capture('value', 'body.x'), capture('reply', 'text')];
    const rejected = harness(definitions);
    const gone = harness(definitions);
    const streamRejected = harness(definitions);
    rejected.tracker.head(head('application/json'));
    gone.tracker.head(head('application/json'));
    streamRejected.tracker.head(ndjsonHead);

    await rejected.tracker.end({
      kind: 'completed',
      format: 'json',
      contentType: 'application/json',
      bodyLength: 7,
      spillPath: () => Promise.resolve(undefined),
      reply: { recognised: true, truncated: false },
      signal: new AbortController().signal,
      readBody: () => Promise.reject(new Error('synthetic read failure')),
      readReply: () => Promise.reject(new Error('synthetic read failure')),
    });
    await gone.tracker.end({
      kind: 'completed',
      format: 'json',
      contentType: 'application/json',
      bodyLength: 7,
      spillPath: () => Promise.resolve(undefined),
      reply: { recognised: true, truncated: false },
      signal: new AbortController().signal,
      readBody: () => Promise.resolve(undefined),
      readReply: () => Promise.resolve(undefined),
    });
    await streamRejected.tracker.end({
      kind: 'completed',
      format: 'ndjson',
      contentType: 'application/x-ndjson',
      bodyLength: 0,
      spillPath: () => Promise.resolve(undefined),
      reply: { recognised: true, truncated: false },
      signal: new AbortController().signal,
      readBody: () => Promise.reject(new Error('synthetic read failure')),
      readReply: () => Promise.reject(new Error('synthetic read failure')),
    });

    expect(rejected.results.get('value')).toEqual(failed('the body is no longer available'));
    expect(gone.results.get('value')).toEqual(failed('the body is no longer available'));
    expect(rejected.results.get('reply')).toEqual(failed('the response is not an event stream'));
    expect(streamRejected.results.get('reply')).toEqual(
      failed('the reply text is no longer available'),
    );
  });

  it('a capture with a first(…) and a last(…) waits for the end', async () => {
    const run = harness([
      capture('differ', 'first(type == "A").id != last(type == "A").id'),
      capture('withStatus', 'status == 200 && first(type == "A").id == "a-1"'),
    ]);
    run.tracker.head(ndjsonHead);

    run.send({ type: 'A', id: 'a-1' });
    expect(run.results.get('withStatus')).toEqual(resolved('true', undefined, ''));
    run.send({ type: 'A', id: 'a-2' });
    expect(run.results.has('differ')).toBe(false);
    await run.tracker.end(completed('ndjson'));

    expect(run.results.get('differ')).toEqual(resolved('true', undefined, ''));
  });

  it('a first() capture from a 16 MiB event costs the host under 50 ms', async () => {
    const zeros = (16 * mebibyte - 40) / 2;
    const line = `{"type":"BIG","items":[${'0,'.repeat(zeros - 1)}0]}\n`;
    const spill = await spilledEvents([line]);
    const range = spill.ranges[0] ?? { offset: 0, length: 0 };
    expect(range.length).toBeGreaterThan(16 * mebibyte - 64);
    const value = JSON.parse(line) as JsonValue;
    const run = harness(
      [
        capture('last', 'first(type == "BIG").items[-1]'),
        capture('filtered', 'first(type == "BIG").items[?@ == 0] | json'),
      ],
      files().worker,
    );
    run.tracker.head(ndjsonHead, access(spill.path));

    const { stallMs } = await longestStall(() => {
      run.send(value, range);
      return run.tracker.end(completed('ndjson', { spill: spill.path }));
    });

    expect(stallMs).toBeLessThan(100);
    expect(run.results.get('last')).toEqual(resolved('0', 1, 'items[-1]'));
    expect(run.results.get('filtered')).toEqual(failed('the value is larger than 1 MiB'));
    await expectNoChild();
  });

  it('a large matched event is read from the spill file in the child', async () => {
    const padding = 'x'.repeat(300_000);
    const spill = await spilledEvents([
      '{"type":"SMALL"}\n',
      `${JSON.stringify({ type: 'BIG', id: 'from-file', padding })}\n`,
    ]);
    const [small, big] = spill.ranges;
    if (small === undefined || big === undefined) {
      throw new Error('expected two ranges');
    }
    const definitions = [
      capture('first', 'first(type == "BIG").id'),
      capture('nth', 'nth(1, type == "BIG").id'),
      capture('last', 'last(type == "BIG").id'),
    ];
    const spilledRun = harness(definitions, files().worker);
    const unspilled = harness(definitions, files().worker);
    const tooLarge = harness(definitions, files().worker);
    spilledRun.tracker.head(ndjsonHead, access(spill.path));
    unspilled.tracker.head(ndjsonHead, access(undefined));
    tooLarge.tracker.head(ndjsonHead, access(undefined));
    const hostCopy: JsonValue = { type: 'BIG', id: 'host-copy' };

    for (const run of [spilledRun, unspilled]) {
      run.send({ type: 'SMALL' }, small);
      run.send(hostCopy, big);
    }
    tooLarge.send({ type: 'SMALL' }, small);
    tooLarge.send(hostCopy, { offset: big.offset, length: 2 * mebibyte });
    await spilledRun.tracker.end(completed('ndjson', { spill: spill.path }));
    await unspilled.tracker.end(completed('ndjson'));
    await tooLarge.tracker.end(completed('ndjson'));

    for (const name of ['first', 'nth', 'last']) {
      expect(spilledRun.results.get(name)).toEqual(resolved('from-file', 2, 'id'));
      expect(unspilled.results.get(name)).toEqual(resolved('host-copy', 2, 'id'));
      expect(tooLarge.results.get(name)).toEqual(
        failed('the event is no longer available for this capture'),
      );
    }
    await expectNoChild();
  });

  it('a small matched event stays on the host', async () => {
    const small = harness([capture('id', 'first(type == "A").id')]);
    const large = harness([capture('id', 'first(type == "A").id')]);
    small.tracker.head(ndjsonHead, access('/synthetic/spill/stream.spill'));
    large.tracker.head(ndjsonHead, access('/synthetic/spill/stream.spill'));

    small.send({ type: 'A', id: 'a-1' }, { offset: 0, length: 256 * 1024 });
    large.send({ type: 'A', id: 'a-1' }, { offset: 0, length: 256 * 1024 + 1 });

    expect(small.results.get('id')).toEqual(resolved('a-1', 1, 'id'));
    expect(large.results.size).toBe(0);
    await large.tracker.end(completed('ndjson', { spill: '/synthetic/spill/stream.spill' }));
    expect(large.results.get('id')).toEqual(
      failed('evaluating the events took too long or used too much memory'),
    );
  });

  it('8 captures on one 256 KiB event stall the host under 50 ms', async () => {
    const line = `{"type":"BIG","items":[${'0,'.repeat((256 * 1024 - 40) / 2 - 1)}0]}\n`;
    const spill = await spilledEvents([line]);
    const range = spill.ranges[0] ?? { offset: 0, length: 0 };
    expect(range.length).toBeLessThanOrEqual(256 * 1024);
    const value = JSON.parse(line) as JsonValue;
    const names = Array.from({ length: 8 }, (_, at) => `zeros${String(at)}`);
    const run = harness(
      names.map((name) => capture(name, 'first(type == "BIG").items[?@ == 0] | json')),
      files().worker,
    );
    run.tracker.head(ndjsonHead, access(spill.path));

    const { stallMs } = await longestStall(() => {
      run.send(value, range);
      return run.tracker.end(completed('ndjson', { spill: spill.path }));
    });

    expect(stallMs).toBeLessThan(100);
    for (const name of names) {
      expect(run.results.get(name)).toMatchObject({ state: 'resolved', provenance: { event: 1 } });
    }
    await expectNoChild();
  });

  it('64 captures without a spill file stall the host under 50 ms', async () => {
    const names = Array.from({ length: 64 }, (_, at) => `all${String(at)}`);
    const run = harness(
      names.map((name) => capture(name, 'all(type == "A")[-1].type')),
      files().worker,
    );
    run.tracker.head(ndjsonHead);
    const eventBytes = mebibyte / 16;
    for (let count = 0; count < 16; count += 1) {
      const tiny: JsonValue = {
        type: 'A',
        items: Array.from({ length: Math.floor(eventBytes / 3) - 10 }, () => ({})),
      };
      run.send(tiny, { length: eventBytes });
    }

    const { stallMs } = await longestStall(() => run.tracker.end(completed('ndjson')));

    expect(stallMs).toBeLessThan(100);
    expect(run.results.get('all0')).toEqual(resolved('A', undefined, '[-1].type'));
    for (const name of names.slice(1)) {
      expect(run.results.get(name)).toEqual(
        failed('the events are no longer available for this capture'),
      );
    }
    await expectNoChild();
  });

  it('reads each capture from a capped spill file up to its own furthest event', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'streamscope-capped-'));
    spillRoots.push(root);
    const area = await SpillArea.open(root, { ...defaultSpillLimits, maxFileSize: 4 * mebibyte });
    const file: SpillFile = await area.create();
    const early = ['{"type":"EARLY","id":"e-1"}\n', '{"type":"EARLY","id":"e-2"}\n'];
    const big = `{"type":"BIG","id":"late","padding":"${'x'.repeat(5 * mebibyte)}"}\n`;
    let offset = 0;
    const ranges: { offset: number; length: number }[] = [];
    for (const block of [...early, big]) {
      const bytes = encoder.encode(block);
      file.append(bytes);
      ranges.push({ offset, length: bytes.length });
      offset += bytes.length;
    }
    await file.finish();
    expect(file.capped).toBe(true);
    const spillPath = async (end: number): Promise<string | undefined> =>
      file.savedBytes >= end && (await file.whenWritten(end)) ? file.path : undefined;
    const run = harness(
      [capture('early', 'all(type == "EARLY").id'), capture('late', 'last(type == "BIG").id')],
      files().worker,
    );
    run.tracker.head(ndjsonHead, { spillPath, signal: new AbortController().signal });
    run.send({ type: 'EARLY', id: 'host-1' }, ranges[0]);
    run.send({ type: 'EARLY', id: 'host-2' }, ranges[1]);
    run.send({ type: 'BIG', id: 'host-late' }, ranges[2]);

    await run.tracker.end({ ...completed('ndjson'), spillPath });

    expect(run.results.get('early')).toEqual(resolved('["e-1","e-2"]', undefined, 'id'));
    expect(run.results.get('late')).toEqual(
      failed('the event is no longer available for this capture'),
    );
    await area.dispose();
  });

  it('says a large matched event was cancelled with its run in the decision 10 wording', async () => {
    const released = new AbortController();
    released.abort();
    const run = harness([capture('big', 'first(type == "BIG").id')], files().worker);
    run.tracker.head(ndjsonHead, {
      spillPath: () => Promise.resolve('/synthetic/spill/stream.spill'),
      signal: released.signal,
    });

    run.send({ type: 'BIG', id: 'b-1' }, { offset: 0, length: 512 * 1024 });
    await run.tracker.end({ ...completed('ndjson'), signal: released.signal });

    expect(run.results.get('big')).toEqual(failed('startRun was cancelled before big resolved'));
    expect(run.calls).toEqual(['big']);
  });

  it("a secret capture's result is marked secret", async () => {
    const run = harness([
      capture('token', 'first(type == "RUN_STARTED").token', true),
      capture('threadId', 'first(type == "RUN_STARTED").threadId'),
    ]);
    run.tracker.head(ndjsonHead);

    run.send({ type: 'RUN_STARTED', token: 'synthetic-token', threadId: 'thread-1' });
    await run.tracker.end(completed('ndjson'));

    expect(run.results.get('token')).toEqual(resolved('synthetic-token', 1, 'token', true));
    expect(run.results.get('threadId')).toEqual(resolved('thread-1', 1, 'threadId'));
  });

  it('reports every capture exactly once and nothing after the end', async () => {
    const run = harness([
      capture('code', 'status'),
      capture('threadId', 'first(type == "RUN_STARTED").threadId'),
      capture('total', 'count()'),
    ]);
    run.tracker.head(ndjsonHead);

    run.send({ type: 'RUN_STARTED', threadId: 'thread-1' });
    await run.tracker.end(completed('ndjson'));
    run.send({ type: 'RUN_STARTED', threadId: 'thread-2' });
    await run.tracker.end({ kind: 'cancelled' });

    expect(run.calls).toEqual(['code', 'threadId', 'total']);
    expect(run.results.get('total')).toEqual(resolved('1', undefined, ''));
  });
});
