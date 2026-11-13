import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StreamEvent } from '../../../src/events/model';
import { SpillArea, type SpillFile } from '../../../src/events/spill';
import { EventStore, type EventStoreOptions } from '../../../src/events/store';
import { defaultStreamLimits, maxIndexedEvents, maxLabels } from '../../../src/streaming/limits';
import { parseEventBytes } from '../../../src/streaming/parser';
import { collect } from '../../support/memory';

const encoder = new TextEncoder();

function event(index: number, overrides: Partial<StreamEvent> = {}): StreamEvent {
  return {
    index,
    time: index * 10,
    offset: (index - 1) * 6,
    length: 6,
    line: index,
    kind: 'json',
    value: { type: `t-${String(index)}` },
    label: `t-${String(index)}`,
    sse: undefined,
    marker: undefined,
    error: undefined,
    unterminated: false,
    ...overrides,
  };
}

function store(overrides: Partial<EventStoreOptions> = {}): EventStore {
  return new EventStore({
    memoryEvents: 10,
    memoryBytes: 1024,
    maxIndexedEvents,
    spill: undefined,
    reparse: (bytes) =>
      parseEventBytes(bytes, 'ndjson', {
        maxEventSize: defaultStreamLimits.maxEventSize,
        typeFields: defaultStreamLimits.typeFields,
      }),
    ...overrides,
  });
}

function spillLines(file: SpillFile, count: number, from = 1): StreamEvent[] {
  const events: StreamEvent[] = [];
  let offset = file.savedBytes;
  for (let index = from; index < from + count; index += 1) {
    const value = { type: `t-${String(index)}` };
    const bytes = encoder.encode(`${JSON.stringify(value)}\n`);
    file.append(bytes);
    events.push(
      event(index, { offset, length: bytes.length, value, label: value.type, line: index }),
    );
    offset += bytes.length;
  }
  return events;
}

describe('EventStore', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'streamscope-store-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('summarises every event and keeps only the newest in memory', () => {
    const events = store({ memoryEvents: 3 });
    for (let index = 1; index <= 5; index += 1) {
      events.append(event(index));
    }

    expect(events.count).toBe(5);
    for (let index = 1; index <= 5; index += 1) {
      expect(events.summary(index)).toEqual({
        index,
        time: index * 10,
        offset: (index - 1) * 6,
        length: 6,
        line: index,
        kind: 'json',
        label: `t-${String(index)}`,
      });
    }
    expect(events.summary(0)).toBeUndefined();
    expect(events.summary(6)).toBeUndefined();
    expect(events.inMemory(2)).toBeUndefined();
    expect(events.inMemory(3)).toEqual(event(3));
    expect(events.inMemory(5)).toEqual(event(5));
  });

  it('evicts by raw bytes as well as by count', () => {
    const events = store({ memoryEvents: 100, memoryBytes: 10 });
    events.append(event(1));
    events.append(event(2));

    expect(events.inMemory(1)).toBeUndefined();
    expect(events.inMemory(2)).toBeDefined();

    events.append(event(3, { length: 20 }));

    expect(events.inMemory(2)).toBeUndefined();
    expect(events.inMemory(3)).toBeDefined();
  });

  it('re-reads an evicted event from the spill file', async () => {
    const area = await SpillArea.open(root);
    const file = await area.create();
    const events = store({ memoryEvents: 2, spill: file });
    for (const appended of spillLines(file, 4)) {
      events.append(appended);
    }

    expect(events.inMemory(1)).toBeUndefined();
    expect(await events.read(1)).toEqual(
      event(1, { length: 15, offset: 0, value: { type: 't-1' }, label: 't-1' }),
    );
    expect(await events.read(4)).toBe(events.inMemory(4));
    expect(await events.read(5)).toBeUndefined();
    await area.dispose();
  });

  it('returns undefined for an evicted event whose bytes were not saved', async () => {
    const withoutSpill = store({ memoryEvents: 1 });
    withoutSpill.append(event(1));
    withoutSpill.append(event(2));

    expect(await withoutSpill.read(1)).toBeUndefined();

    const area = await SpillArea.open(root);
    const file = await area.create();
    const capped = store({ memoryEvents: 1, spill: file });
    const [first, second] = spillLines(file, 2);
    if (first === undefined || second === undefined) {
      throw new Error('Missing spilled events');
    }
    capped.append(first);
    capped.append(second);
    capped.append(event(3, { offset: 1000, length: 15 }));
    capped.append(event(4, { offset: 1015, length: 15 }));

    expect(await capped.read(3)).toBeUndefined();
    await area.dispose();
  });

  it('compacts away in-memory events but keeps the index', async () => {
    const area = await SpillArea.open(root);
    const file = await area.create();
    const events = store({ spill: file });
    const appended = spillLines(file, 3);
    for (const event of appended) {
      events.append(event);
    }
    const summaries = [1, 2, 3].map((index) => events.summary(index));

    events.compact();

    expect(events.inMemory(1)).toBeUndefined();
    expect(events.inMemory(2)).toBeUndefined();
    expect(events.inMemory(3)).toBeUndefined();
    expect(events.count).toBe(3);
    expect([1, 2, 3].map((index) => events.summary(index))).toEqual(summaries);
    expect(await events.read(1)).toEqual(appended[0]);
    expect(await events.read(3)).toEqual(appended[2]);
    await area.dispose();
  });

  it('counts only the events kept after compacting against the byte budget', () => {
    const events = store({ memoryEvents: 100, memoryBytes: 20 });
    for (let index = 1; index <= 3; index += 1) {
      events.append(event(index));
    }

    events.compact();
    for (let index = 4; index <= 6; index += 1) {
      events.append(event(index));
    }

    expect(events.inMemory(3)).toBeUndefined();
    expect(events.inMemory(4)).toEqual(event(4));
    expect(events.inMemory(5)).toEqual(event(5));
    expect(events.inMemory(6)).toEqual(event(6));
    expect(events.count).toBe(6);
  });

  it('keeps holding the newest events by count after compacting', () => {
    const events = store({ memoryEvents: 2 });
    events.append(event(1));
    events.append(event(2));

    events.compact();
    for (let index = 3; index <= 6; index += 1) {
      events.append(event(index));
    }

    expect(events.inMemory(4)).toBeUndefined();
    expect(events.inMemory(5)).toEqual(event(5));
    expect(events.inMemory(6)).toEqual(event(6));
  });

  it('compacts a store without a spill file and an empty store', async () => {
    const empty = store();
    empty.compact();
    empty.append(event(1));

    expect(empty.inMemory(1)).toEqual(event(1));

    const withoutSpill = store();
    withoutSpill.append(event(1));
    withoutSpill.append(event(2));
    withoutSpill.compact();
    withoutSpill.compact();

    expect(withoutSpill.count).toBe(2);
    expect(withoutSpill.summary(2)?.label).toBe('t-2');
    expect(await withoutSpill.read(1)).toBeUndefined();
  });

  it('release() frees the ring and the index, and nothing can be read afterwards', async () => {
    const area = await SpillArea.open(root);
    const file = await area.create();
    const memoryEvents = 1_000_000;
    const events = store({ memoryEvents, memoryBytes: 1024 * 1024 * 1024, spill: file });
    for (const appended of spillLines(file, 70_000)) {
      events.append(appended);
    }
    const indexBytes = events.indexBytes;
    collect();
    const heapBefore = process.memoryUsage().heapUsed;
    const buffersBefore = process.memoryUsage().arrayBuffers;

    events.release();
    collect();

    expect(indexBytes).toBe((65_536 + 65_536) * 27);
    expect(events.indexBytes).toBe(0);
    expect(buffersBefore - process.memoryUsage().arrayBuffers).toBeGreaterThanOrEqual(indexBytes);
    expect(heapBefore - process.memoryUsage().heapUsed).toBeGreaterThan(memoryEvents * 8);
    expect(events.count).toBe(70_000);
    expect(events.summary(1)).toBeUndefined();
    expect(events.summary(70_000)).toBeUndefined();
    expect(events.inMemory(70_000)).toBeUndefined();
    expect(await events.read(1)).toBeUndefined();
    expect(await events.read(70_000)).toBeUndefined();
    await area.dispose();
  });

  it('reports the capacity of its index blocks as its index bytes', () => {
    const events = store({ memoryEvents: 2, maxIndexedEvents: 65_536 });

    expect(events.indexBytes).toBe(0);
    events.append(event(1));
    expect(events.indexBytes).toBe(1024 * 27);
    for (let index = 2; index <= 1025; index += 1) {
      events.append(event(index));
    }
    expect(events.indexBytes).toBe(2048 * 27);
    for (let index = 1026; index <= 65_536; index += 1) {
      events.append(event(index));
    }
    expect(events.indexBytes).toBe(65_536 * 27);
    events.append(event(65_537));
    expect(events.indexBytes).toBe(2 * 65_536 * 27);
    for (let index = 65_538; index <= 140_000; index += 1) {
      events.append(event(index));
    }
    expect(events.indexBytes).toBe(2 * 65_536 * 27);
  });

  it('stops interning labels after 4,096 distinct ones', async () => {
    const area = await SpillArea.open(root);
    const file = await area.create();
    const events = store({ memoryEvents: 1, spill: file });
    for (const appended of spillLines(file, maxLabels + 2)) {
      events.append(appended);
    }

    expect(events.summary(maxLabels)?.label).toBe(`t-${String(maxLabels)}`);
    expect(events.summary(maxLabels + 1)?.label).toBeUndefined();
    expect((await events.read(maxLabels + 1))?.label).toBe(`t-${String(maxLabels + 1)}`);
    await area.dispose();
  });

  it('keeps repeated labels after the table is full', () => {
    const events = store({ memoryEvents: 1 });
    events.append(event(1, { label: 'TEXT_MESSAGE_CONTENT' }));
    for (let index = 2; index <= maxLabels + 2; index += 1) {
      events.append(event(index));
    }
    events.append(event(maxLabels + 3, { label: 'TEXT_MESSAGE_CONTENT' }));
    events.append(event(maxLabels + 4, { label: undefined }));

    expect(events.summary(maxLabels + 3)?.label).toBe('TEXT_MESSAGE_CONTENT');
    expect(events.summary(maxLabels + 4)?.label).toBeUndefined();
  });

  it('crosses index blocks', () => {
    const events = store({ memoryEvents: 4 });
    for (let index = 1; index <= 70_000; index += 1) {
      events.append(
        event(index, {
          kind: index % 2 === 0 ? 'text' : 'malformed',
          label: index % 3 === 0 ? 'third' : 'other',
        }),
      );
    }

    expect(events.count).toBe(70_000);
    expect(events.summary(65_536)).toEqual({
      index: 65_536,
      time: 655_360,
      offset: 65_535 * 6,
      length: 6,
      line: 65_536,
      kind: 'text',
      label: 'other',
    });
    expect(events.summary(65_537)).toEqual({
      index: 65_537,
      time: 655_370,
      offset: 65_536 * 6,
      length: 6,
      line: 65_537,
      kind: 'malformed',
      label: 'other',
    });
    expect(events.summary(69_999)?.label).toBe('third');
  });

  it('rejects an out-of-order index', () => {
    const events = store();
    events.append(event(1));

    expect(() => {
      events.append(event(3));
    }).toThrow();
    expect(() => {
      events.append(event(1));
    }).toThrow();
  });

  it('allocates a small index for a short stream', () => {
    const before = process.memoryUsage().arrayBuffers;
    const stores = Array.from({ length: 50 }, () => {
      const events = store();
      for (let index = 1; index <= 3; index += 1) {
        events.append(event(index));
      }
      return events;
    });
    const used = process.memoryUsage().arrayBuffers - before;

    expect(stores.every((events) => events.summary(3)?.label === 't-3')).toBe(true);
    expect(used).toBeLessThan(5 * 1024 * 1024);
  });

  it('keeps summaries across the growth of the first index block', () => {
    const events = store({ memoryEvents: 2 });
    for (let index = 1; index <= 5000; index += 1) {
      events.append(event(index));
    }

    expect(events.summary(1)?.label).toBe('t-1');
    expect(events.summary(1025)?.offset).toBe(1024 * 6);
    expect(events.summary(5000)?.time).toBe(50_000);
  });

  it('drops the oldest index blocks beyond maxIndexedEvents', async () => {
    const events = store({ memoryEvents: 4, maxIndexedEvents: 65_536 });
    for (let index = 1; index <= 140_000; index += 1) {
      events.append(event(index));
    }

    expect(events.count).toBe(140_000);
    expect(events.summary(1)).toBeUndefined();
    expect(events.summary(65_536)).toBeUndefined();
    expect(events.summary(65_537)?.offset).toBe(65_536 * 6);
    expect(events.summary(140_000)?.time).toBe(1_400_000);
    expect(await events.read(1)).toBeUndefined();
  });
});
