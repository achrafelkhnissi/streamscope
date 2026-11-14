import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { conditionText, type EventCondition } from '../../../src/capture/capture-line';
import { countOccurrence, type OccurrenceEvents } from '../../../src/capture/occurrence';
import type { TaskClock } from '../../../src/capture/task-budget';
import { eventLabel } from '../../../src/events/label';
import type { EventKind, JsonValue, SseFields, StreamEvent } from '../../../src/events/model';
import { StreamSession } from '../../../src/events/session';
import { SpillArea } from '../../../src/events/spill';
import { EventStore } from '../../../src/events/store';
import type { Expr } from '../../../src/expressions/ast';
import { parseExpression } from '../../../src/expressions/parse';
import { fastestOf } from '../timing';
import { longestStall } from './worker';

const typeFields = ['type', 'event', 'object'];
const encoder = new TextEncoder();

function condition(written: EventCondition): Expr {
  const parsed = parseExpression(conditionText(written), 'condition');
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }
  return parsed.expr;
}

function typed(type: string): Expr {
  return condition({ kind: 'field', field: 'type', value: type });
}

function streamEvent(
  index: number,
  value: JsonValue,
  kind: EventKind = 'json',
  sse?: SseFields,
  fields: readonly string[] = typeFields,
): StreamEvent {
  return {
    index,
    time: index,
    offset: 0,
    length: 16,
    line: index,
    kind,
    value,
    label: eventLabel(value, sse, fields),
    sse,
    marker: undefined,
    error: kind === 'malformed' ? 'Unexpected token' : undefined,
    unterminated: false,
  };
}

function memoryStore(
  events: readonly StreamEvent[],
  options: { memoryEvents?: number; maxIndexedEvents?: number } = {},
): EventStore {
  const store = new EventStore({
    memoryEvents: options.memoryEvents ?? events.length + 1,
    memoryBytes: Number.MAX_SAFE_INTEGER,
    maxIndexedEvents: options.maxIndexedEvents ?? 2_097_152,
    spill: undefined,
    reparse: () => undefined,
  });
  for (const event of events) {
    store.append(event);
  }
  return store;
}

function spying(store: EventStore): { events: OccurrenceEvents; reads: number[] } {
  const reads: number[] = [];
  return {
    reads,
    events: {
      get count() {
        return store.count;
      },
      summary: (index) => store.summary(index),
      read: (index) => {
        reads.push(index);
        return store.read(index);
      },
    },
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe('countOccurrence', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'streamscope-occurrence-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('counts earlier matching events of kind json and text only', async () => {
    const events = [
      streamEvent(1, { type: 'A' }),
      streamEvent(2, '{bad', 'malformed'),
      streamEvent(3, { type: 'A' }, 'oversize'),
      streamEvent(4, 'keepalive', 'comment'),
      streamEvent(5, 'hello', 'text'),
      streamEvent(6, { type: 'A' }),
      streamEvent(7, { type: 'B' }),
      streamEvent(8, { type: 'A' }),
    ];
    const store = memoryStore(events);

    expect(
      await countOccurrence({
        events: store,
        index: 8,
        condition: typed('A'),
        label: 'A',
        signal: signal(),
      }),
    ).toEqual({ ok: true, occurrence: 3 });
    expect(
      await countOccurrence({
        events: store,
        index: 8,
        condition: undefined,
        label: undefined,
        signal: signal(),
      }),
    ).toEqual({ ok: true, occurrence: 5 });
    expect(
      await countOccurrence({
        events: store,
        index: 1,
        condition: typed('A'),
        label: 'A',
        signal: signal(),
      }),
    ).toEqual({ ok: true, occurrence: 1 });
    expect(
      await countOccurrence({
        events: store,
        index: 5,
        condition: undefined,
        label: undefined,
        signal: signal(),
      }),
    ).toEqual({ ok: true, occurrence: 2 });
  });

  it('reads only candidates when the condition is on the first type field', async () => {
    const types = ['A', 'B', 'C', 'D', 'E'];
    const events = Array.from({ length: 50_000 }, (_, at) =>
      streamEvent(at + 1, { type: types[at % types.length] ?? 'A', n: at }),
    );
    const { events: spied, reads } = spying(memoryStore(events));

    const result = await countOccurrence({
      events: spied,
      index: 50_000,
      condition: typed('E'),
      label: 'E',
      signal: signal(),
    });

    expect(result).toEqual({ ok: true, occurrence: 10_000 });
    expect(reads.length).toBe(9_999);
    expect(reads.every((index) => events[index - 1]?.label === 'E')).toBe(true);
  });

  it('stays exact when a later type field decides', async () => {
    const fields = ['type', 'event'];
    const events = [
      streamEvent(1, { type: 'B', event: 'A' }, 'json', undefined, fields),
      streamEvent(2, { event: 'A' }, 'json', undefined, fields),
      streamEvent(3, { type: 'A' }, 'json', undefined, fields),
      streamEvent(4, { event: 'C' }, 'json', undefined, fields),
      streamEvent(5, { event: 'A' }, 'json', undefined, fields),
    ];
    const sse: SseFields = { event: 'x', id: undefined, retry: undefined };
    const sseEvents = [
      streamEvent(1, { type: 'B' }, 'json', sse),
      streamEvent(2, 'plain', 'text', sse),
      streamEvent(3, {}, 'json', sse),
    ];

    expect(
      await countOccurrence({
        events: memoryStore(events),
        index: 5,
        condition: condition({ kind: 'field', field: 'event', value: 'A' }),
        label: undefined,
        signal: signal(),
      }),
    ).toEqual({ ok: true, occurrence: 3 });
    expect(
      await countOccurrence({
        events: memoryStore(sseEvents),
        index: 3,
        condition: condition({ kind: 'sse', value: 'x' }),
        label: undefined,
        signal: signal(),
      }),
    ).toEqual({ ok: true, occurrence: 3 });
  });

  it('stays exact past 4,096 distinct labels', async () => {
    const events = Array.from({ length: 5_000 }, (_, at) =>
      streamEvent(at + 1, { type: `t${String(at)}` }),
    );
    events.push(streamEvent(5_001, { type: 't4500' }));
    const store = memoryStore(events);
    expect(store.summary(5_001)?.label).toBeUndefined();

    expect(
      await countOccurrence({
        events: store,
        index: 5_001,
        condition: typed('t4500'),
        label: store.summary(5_001)?.label,
        signal: signal(),
      }),
    ).toEqual({ ok: true, occurrence: 2 });
  });

  it('refuses when earlier events are no longer indexed or readable', async () => {
    const events = Array.from({ length: 140_000 }, (_, at) => streamEvent(at + 1, { type: 'A' }));
    const dropped = memoryStore(events, { maxIndexedEvents: 65_536 });
    expect(dropped.summary(1)).toBeUndefined();

    expect(
      await countOccurrence({
        events: dropped,
        index: 140_000,
        condition: typed('Z'),
        label: 'Z',
        signal: signal(),
      }),
    ).toEqual({ ok: false, reason: 'events-gone' });

    const forgotten = memoryStore(events.slice(0, 300), { memoryEvents: 100 });
    expect(
      await countOccurrence({
        events: forgotten,
        index: 300,
        condition: typed('A'),
        label: 'A',
        signal: signal(),
      }),
    ).toEqual({ ok: false, reason: 'events-gone' });
  });

  it('stops when cancelled', async () => {
    const events = Array.from({ length: 200_000 }, (_, at) => streamEvent(at + 1, { type: 'A' }));
    const { events: spied, reads } = spying(memoryStore(events));
    const controller = new AbortController();
    let readsAtAbort = -1;
    const clock: TaskClock = {
      now: () => performance.now(),
      nextTask: (callback) => {
        if (readsAtAbort === -1) {
          readsAtAbort = reads.length;
          controller.abort();
        }
        setImmediate(callback);
      },
    };

    const result = await countOccurrence({
      events: spied,
      index: 200_000,
      condition: typed('A'),
      label: 'A',
      signal: controller.signal,
      clock,
    });

    expect(result).toEqual({ ok: false, reason: 'cancelled' });
    expect(readsAtAbort).toBeGreaterThanOrEqual(0);
    expect(reads.length).toBe(readsAtAbort);
  });

  it('keeps the host stall under 100 ms counting 200,000 spilled events', async () => {
    const area = await SpillArea.open(root);
    const spill = await area.create();
    const session = new StreamSession({
      contentType: 'application/x-ndjson',
      directive: undefined,
      spill,
      now: () => 0,
      onUpdate: () => undefined,
      onText: () => undefined,
      limits: { memoryEvents: 100 },
    });
    const lines: string[] = [];
    for (let at = 1; at <= 200_000; at += 1) {
      lines.push(`{"type":"${at % 1_000 === 0 ? 'R' : 'T'}","n":${String(at)}}`);
    }
    session.write(encoder.encode(`${lines.join('\n')}\n`));
    session.end();
    const store = session.store;
    expect(store.count).toBe(200_000);
    expect(store.inMemory(1)).toBeUndefined();

    let occurrence: unknown;
    const stallMs = await fastestOf(async () => {
      const { result, stallMs: stall } = await longestStall(() =>
        countOccurrence({
          events: store,
          index: 200_000,
          condition: typed('R'),
          label: store.summary(200_000)?.label,
          signal: signal(),
        }),
      );
      occurrence = result;
      return stall;
    });

    expect(occurrence).toEqual({ ok: true, occurrence: 200 });
    expect(stallMs).toBeLessThan(100);
    session.dispose();
    await area.dispose();
  }, 60_000);
});
