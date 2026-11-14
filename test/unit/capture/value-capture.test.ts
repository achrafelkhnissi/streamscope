import { afterEach, describe, expect, it } from 'vitest';
import { hostBudget } from '../../../src/capture/task-budget';
import {
  CaptureTracker,
  type CaptureDefinition,
  type CaptureResult,
} from '../../../src/capture/tracker';
import { planValueCapture, type ValuePlan } from '../../../src/capture/value-capture';
import { eventLabel } from '../../../src/events/label';
import type { EventKind, JsonValue, StreamEvent } from '../../../src/events/model';
import { EventStore } from '../../../src/events/store';
import { insertText, maxInsertedLength } from '../../../src/expressions/insert';
import { captureLine } from '../../../src/http-file/capture-placement';
import { parseHttpFile } from '../../../src/http-file/parse';
import type { PathSegment } from '../../../src/response/json-position';
import { isEventStream } from '../../../src/response/panel-content';
import type { RunObserver } from '../../../src/runs/observer';
import { startRun } from '../../../src/runs/run';
import { parseJson } from '../../../src/streaming/json';
import { startHttpServer, type LocalServer } from '../../support/servers';
import { streamFixtures } from '../../support/stream-fixtures';
import { dependencies, runInput, useSpillArea, withObserver } from '../runs/support';
import { missingWorker } from './worker';

const servers: LocalServer[] = [];
const typeFields = ['type', 'event', 'object'];
const batchSize = 64;
useSpillArea();

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

interface Planned {
  name: string;
  expression: string;
  expected: string;
  where: string;
}

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function allPaths(value: JsonValue, prefix: PathSegment[] = []): PathSegment[][] {
  const found: PathSegment[][] = [prefix];
  if (Array.isArray(value)) {
    value.forEach((item: JsonValue, index) => {
      found.push(...allPaths(item, [...prefix, index]));
    });
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      found.push(...allPaths(item, [...prefix, key]));
    }
  }
  return found;
}

function valueAt(value: JsonValue, segments: readonly PathSegment[]): JsonValue {
  let node = value;
  for (const segment of segments) {
    node = (node as Record<string | number, JsonValue>)[segment] ?? null;
  }
  return node;
}

function expectedText(value: JsonValue): string {
  const text = insertText(value, maxInsertedLength);
  if (!text.ok) {
    throw new Error('value too large');
  }
  return text.text;
}

function planned(plan: ValuePlan): { expression: string; suggestedName: string } {
  if (!plan.ok) {
    throw new Error('message' in plan ? plan.message : 'cancelled');
  }
  return plan;
}

async function serve(contentType: string, body: Uint8Array | string): Promise<string> {
  const server = await startHttpServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': contentType });
    response.end(typeof body === 'string' ? body : Buffer.from(body));
  });
  servers.push(server);
  return `${server.url}/stream`;
}

async function resolve(url: string, lines: readonly string[]): Promise<Map<string, CaptureResult>> {
  const file = parseHttpFile([...lines, `GET ${url}`].join('\n'));
  expect(file.diagnostics).toEqual([]);
  const request = file.requests[0];
  if (request === undefined) {
    throw new Error('no request');
  }
  const definitions: CaptureDefinition[] = request.captures.map((capture) => {
    if (capture.expression === undefined) {
      throw new Error(capture.expressionText);
    }
    return {
      name: capture.name,
      secret: capture.secret,
      provenance: false,
      expression: capture.expression,
      text: capture.expressionText,
    };
  });
  expect(definitions.length).toBe(lines.length);
  const results = new Map<string, CaptureResult>();
  const tracker = new CaptureTracker(
    { id: 1, label: 'request', wallStartedAt: Date.now(), sensitiveValues: [] },
    definitions,
    (name, result) => {
      results.set(name, result);
    },
    missingWorker,
    hostBudget,
  );
  let ended: Promise<void> | undefined;
  const observer: RunObserver = {
    head: (head, access) => {
      tracker.head(head, access);
    },
    event: (event) => {
      tracker.event(event);
    },
    end: (end) => {
      ended = tracker.end(end);
    },
    backpressure: tracker,
  };
  const run = startRun(withObserver(runInput([`GET ${url}`]), observer), dependencies);
  const snapshot = await run.done;
  await ended;
  expect(snapshot.status).toBe('completed');
  await run.release();
  return results;
}

async function expectRoundTrip(url: string, plans: readonly Planned[]): Promise<void> {
  for (let start = 0; start < plans.length; start += batchSize) {
    const batch = plans.slice(start, start + batchSize);
    const results = await resolve(
      url,
      batch.map(({ name, expression }) => captureLine('#', name, false, expression)),
    );
    for (const { name, expression, expected, where } of batch) {
      const result = results.get(name);
      expect(result?.state, `${where}: ${expression}`).toBe('resolved');
      expect(
        result?.state === 'resolved' ? result.text : undefined,
        `${where}: ${expression}`,
      ).toBe(expected);
    }
  }
}

function streamEvent(index: number, value: JsonValue, kind: EventKind): StreamEvent {
  return {
    index,
    time: index,
    offset: 0,
    length: 16,
    line: index,
    kind,
    value,
    label: eventLabel(value, undefined, typeFields),
    sse: undefined,
    marker: undefined,
    error: undefined,
    unterminated: false,
  };
}

function memoryStore(events: readonly StreamEvent[]): EventStore {
  const store = new EventStore({
    memoryEvents: events.length + 1,
    memoryBytes: Number.MAX_SAFE_INTEGER,
    maxIndexedEvents: 2_097_152,
    spill: undefined,
    reparse: () => undefined,
  });
  for (const event of events) {
    store.append(event);
  }
  return store;
}

describe('planValueCapture', () => {
  it('evaluates every generated expression of every fixture event back to its value', async () => {
    let checked = 0;
    for (const fixture of streamFixtures) {
      const url = await serve(fixture.contentType, fixture.bytes);
      const run = startRun(runInput([`GET ${url}`]), dependencies);
      const snapshot = await run.done;
      const session = snapshot.stream;
      if (session === undefined || !isEventStream(snapshot)) {
        await run.release();
        continue;
      }
      const plans: Planned[] = [];
      for (let index = 1; index <= session.store.count; index += 1) {
        const event = await session.store.read(index);
        if (event === undefined || (event.kind !== 'json' && event.kind !== 'text')) {
          continue;
        }
        const paths = event.kind === 'text' ? [[]] : allPaths(event.value);
        for (const segments of paths) {
          const plan = planned(
            await planValueCapture({
              target: { kind: 'event', event },
              segments,
              stream: { events: session.store, typeFields: session.typeFields },
              taken: new Set(),
              sensitiveValues: [],
              signal: new AbortController().signal,
            }),
          );
          plans.push({
            name: `c${String(plans.length % batchSize)}`,
            expression: plan.expression,
            expected: expectedText(valueAt(event.value, segments)),
            where: `${fixture.name} #${String(index)} ${JSON.stringify(segments)}`,
          });
        }
      }
      await run.release();
      await expectRoundTrip(url, plans);
      checked += plans.length;
    }
    expect(checked).toBeGreaterThan(100);
  }, 120_000);

  it('evaluates every generated expression of a JSON body back to its value', async () => {
    const raw =
      '{"items":[{"id":1,"name":"a"},{"id":"x-2","tags":[],"meta":{}}],"count":2,' +
      '"big":12345678901234567890,"ok":null,"nested":{"a.b":true,"":"empty","in":"kw",' +
      '"__proto__":"own","0":"zero","x\\u202ey":"bidi","deep":[[[-1.5e3]]]}}';
    const parsed = parseJson(raw);
    if (!parsed.ok) {
      throw new Error(parsed.message);
    }
    const url = await serve('application/json', raw);
    const run = startRun(runInput([`GET ${url}`]), dependencies);
    const snapshot = await run.done;
    expect(isEventStream(snapshot)).toBe(false);
    await run.release();
    const plans: Planned[] = [];
    for (const segments of allPaths(parsed.value)) {
      const plan = planned(
        await planValueCapture({
          target: { kind: 'body' },
          segments,
          stream: undefined,
          taken: new Set(),
          sensitiveValues: [],
          signal: new AbortController().signal,
        }),
      );
      plans.push({
        name: `c${String(plans.length % batchSize)}`,
        expression: plan.expression,
        expected: expectedText(valueAt(parsed.value, segments)),
        where: JSON.stringify(segments),
      });
    }
    await expectRoundTrip(url, plans);
  }, 30_000);

  it('refuses events captures cannot read', async () => {
    const events = [
      streamEvent(1, '{bad', 'malformed'),
      streamEvent(2, '{"type":"A","pad', 'oversize'),
      streamEvent(3, 'keepalive', 'comment'),
      streamEvent(4, { type: 'A' }, 'json'),
    ];
    const store = memoryStore(events);
    const plan = (event: StreamEvent, segments: PathSegment[] = []): Promise<ValuePlan> =>
      planValueCapture({
        target: { kind: 'event', event },
        segments,
        stream: { events: store, typeFields },
        taken: new Set(),
        sensitiveValues: [],
        signal: new AbortController().signal,
      });

    expect(await plan(events[0] as StreamEvent)).toEqual({
      ok: false,
      message: 'Event 1 is not valid JSON, so a capture cannot read it.',
    });
    expect(await plan(events[1] as StreamEvent)).toEqual({
      ok: false,
      message: 'Event 2 was cut at streamscope.stream.maxEventSize, so a capture cannot read it.',
    });
    expect(await plan(events[2] as StreamEvent)).toEqual({
      ok: false,
      message: 'Event 3 is an SSE comment, and captures do not see comments.',
    });
    expect(await plan(events[3] as StreamEvent, ['missing'])).toEqual({
      ok: false,
      message: 'There is no value at this position.',
    });
    expect(
      await planValueCapture({
        target: { kind: 'body' },
        segments: ['a'],
        stream: { events: store, typeFields },
        taken: new Set(),
        sensitiveValues: [],
        signal: new AbortController().signal,
      }),
    ).toEqual({
      ok: false,
      message: 'This response is an event stream; capture a value from one of its events instead.',
    });

    const gone = new EventStore({
      memoryEvents: 2,
      memoryBytes: Number.MAX_SAFE_INTEGER,
      maxIndexedEvents: 2_097_152,
      spill: undefined,
      reparse: () => undefined,
    });
    const many = [1, 2, 3, 4].map((index) => streamEvent(index, { type: 'A' }, 'json'));
    for (const event of many) {
      gone.append(event);
    }
    expect(
      await planValueCapture({
        target: { kind: 'event', event: many[3] as StreamEvent },
        segments: ['type'],
        stream: { events: gone, typeFields },
        taken: new Set(),
        sensitiveValues: [],
        signal: new AbortController().signal,
      }),
    ).toEqual({
      ok: false,
      message:
        'The events before event 4 are no longer kept, so Streamscope cannot tell which occurrence it is. Write this capture by hand.',
    });

    const controller = new AbortController();
    controller.abort();
    expect(
      await planValueCapture({
        target: { kind: 'event', event: events[3] as StreamEvent },
        segments: ['type'],
        stream: { events: store, typeFields },
        taken: new Set(),
        sensitiveValues: [],
        signal: controller.signal,
      }),
    ).toEqual({ ok: false, cancelled: true });
  });

  it('suggests a name not taken on the request', async () => {
    const events = [streamEvent(1, { type: 'RUN_STARTED', threadId: 't' }, 'json')];
    const plan = await planValueCapture({
      target: { kind: 'event', event: events[0] as StreamEvent },
      segments: ['threadId'],
      stream: { events: memoryStore(events), typeFields },
      taken: new Set(['threadId']),
      sensitiveValues: [],
      signal: new AbortController().signal,
    });

    expect(plan).toEqual({
      ok: true,
      expression: 'first(type == "RUN_STARTED").threadId',
      condition: { kind: 'field', field: 'type', value: 'RUN_STARTED' },
      suggestedName: 'threadId2',
      sensitive: false,
    });
  });

  it('marks a plan sensitive when a key or the type field has a sensitive word', async () => {
    const body = (segments: PathSegment[]) =>
      planValueCapture({
        target: { kind: 'body' },
        segments,
        stream: undefined,
        taken: new Set(),
        sensitiveValues: [],
        signal: new AbortController().signal,
      });
    for (const segments of [
      ['headers', 'Authorization'],
      ['sessionId'],
      ['auth', 'value'],
      ['jwt'],
    ]) {
      expect(await body(segments), JSON.stringify(segments)).toMatchObject({
        ok: true,
        sensitive: true,
      });
    }
    expect(await body(['threadId'])).toMatchObject({ ok: true, sensitive: false });
    const events = [streamEvent(1, { session: 'opened', id: 'x' }, 'json')];
    expect(
      await planValueCapture({
        target: { kind: 'event', event: events[0] as StreamEvent },
        segments: ['id'],
        stream: { events: memoryStore(events), typeFields: ['session'] },
        taken: new Set(),
        sensitiveValues: [],
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ ok: true, expression: 'first(session == "opened").id', sensitive: true });
  });

  it('refuses a capture whose expression would contain a secret the request sent', async () => {
    const refused = {
      ok: false,
      message:
        'The path to this value or its event type contains a secret this request sent, so Streamscope will not write it into the file.',
    };
    expect(
      await planValueCapture({
        target: { kind: 'body' },
        segments: ['synthetic-secret-value'],
        stream: undefined,
        taken: new Set(),
        sensitiveValues: ['synthetic-secret-value'],
        signal: new AbortController().signal,
      }),
    ).toEqual(refused);
    const events = [streamEvent(1, { type: 'synthetic-secret-value', id: 'x' }, 'json')];
    expect(
      await planValueCapture({
        target: { kind: 'event', event: events[0] as StreamEvent },
        segments: ['id'],
        stream: { events: memoryStore(events), typeFields },
        taken: new Set(),
        sensitiveValues: ['synthetic-secret-value'],
        signal: new AbortController().signal,
      }),
    ).toEqual(refused);
  });

  it('counts numeric discriminators by value and skips ones that are not finite', async () => {
    const numeric = [
      streamEvent(1, { type: 1e21, id: 'a' }, 'json'),
      streamEvent(2, { type: 1000000000000000000000n, id: 'b' }, 'json'),
    ];
    expect(
      await planValueCapture({
        target: { kind: 'event', event: numeric[1] as StreamEvent },
        segments: ['id'],
        stream: { events: memoryStore(numeric), typeFields },
        taken: new Set(),
        sensitiveValues: [],
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ ok: true, expression: 'nth(2, type == 1000000000000000000000).id' });
    const infinite = [
      streamEvent(1, { other: 1 }, 'json'),
      streamEvent(2, { type: Number.POSITIVE_INFINITY, id: 'c' }, 'json'),
    ];
    expect(
      await planValueCapture({
        target: { kind: 'event', event: infinite[1] as StreamEvent },
        segments: ['id'],
        stream: { events: memoryStore(infinite), typeFields },
        taken: new Set(),
        sensitiveValues: [],
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ ok: true, expression: 'nth(2).id' });
  });
});
