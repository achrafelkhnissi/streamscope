import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { streamFixtures } from '../../support/stream-fixtures';
import { StreamSession, type StreamSessionOptions } from '../../../src/events/session';
import { SpillArea } from '../../../src/events/spill';
import { defaultSpillLimits } from '../../../src/streaming/limits';

const encoder = new TextEncoder();

function fixture(name: string): { bytes: Uint8Array; contentType: string } {
  const found = streamFixtures.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`Missing fixture ${name}`);
  }
  return found;
}

function chunks(bytes: Uint8Array, size: number): Uint8Array[] {
  const pieces: Uint8Array[] = [];
  for (let start = 0; start < bytes.length; start += size) {
    pieces.push(bytes.subarray(start, start + size));
  }
  return pieces;
}

interface Harness {
  session: StreamSession;
  updates: number;
  text: string;
}

function harness(overrides: Partial<StreamSessionOptions> = {}): Harness {
  const state: Harness = { session: undefined as unknown as StreamSession, updates: 0, text: '' };
  state.session = new StreamSession({
    contentType: undefined,
    directive: undefined,
    spill: undefined,
    now: () => Date.now(),
    onUpdate: () => {
      state.updates += 1;
    },
    onText: (text) => {
      state.text += text;
    },
    ...overrides,
  });
  return state;
}

function fileHandles(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === 'FileHandle').length;
}

describe('StreamSession', () => {
  let root: string;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    root = mkdtempSync(path.join(tmpdir(), 'streamscope-session-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  it('streams AG-UI NDJSON into the store and the reply', () => {
    const { bytes } = fixture('ag-ui.ndjson');
    const state = harness({ contentType: 'application/json' });
    for (const chunk of chunks(bytes, 7)) {
      state.session.write(chunk);
    }
    state.session.end();

    expect(state.session.format?.format).toBe('ndjson');
    expect(state.session.store.count).toBe(8);
    expect(state.session.store.inMemory(1)?.label).toBe('RUN_STARTED');
    expect(state.session.reply.adapter).toBe('ag-ui');
    expect(state.session.reply.text()).toBe('Héllo, wörld 🚀✓');
    expect(state.session.warnings).toEqual([]);
    state.session.dispose();
  });

  it('sends text bodies to onText', () => {
    const state = harness({ contentType: 'text/html' });
    state.session.write(encoder.encode('<p>synthetic</p>'));
    state.session.end();

    expect(state.text).toBe('<p>synthetic</p>');
    expect(state.session.format).toEqual({
      format: 'text',
      reason: 'content-type',
      contentType: 'text/html',
    });
    expect(state.session.store.count).toBe(0);
    state.session.dispose();
  });

  it('updates once at end even inside the interval', async () => {
    const state = harness({ contentType: 'application/x-ndjson' });
    state.session.write(encoder.encode('{"type":"A"}\n'));
    expect(state.updates).toBe(0);
    await Promise.resolve();
    expect(state.updates).toBe(1);

    vi.advanceTimersByTime(10);
    state.session.write(encoder.encode('{"type":"B"}\n'));
    expect(state.updates).toBe(1);

    state.session.end();
    expect(state.updates).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(100);
    expect(state.updates).toBe(2);
    state.session.dispose();
  });

  it('records warnings', () => {
    const state = harness({ contentType: 'text/event-stream' });
    state.session.write(encoder.encode('data: partial\n'));
    state.session.end();

    expect(state.session.warnings).toEqual([{ kind: 'discarded-event', offset: 0, length: 14 }]);
    state.session.dispose();
  });

  it('ignores writes and emits nothing after stop', async () => {
    const state = harness({ contentType: 'application/x-ndjson' });
    state.session.write(encoder.encode('{"type":"A"}\n{"type":"B"'));
    await Promise.resolve();
    vi.advanceTimersByTime(10);
    state.session.write(encoder.encode('}\n'));

    state.session.stop();
    const updates = state.updates;
    state.session.write(encoder.encode('{"type":"C"}\n'));
    state.session.end();
    vi.advanceTimersByTime(100);

    expect(updates).toBe(2);
    expect(state.updates).toBe(updates);
    expect(state.session.store.count).toBe(2);
    state.session.dispose();
  });

  it('passes spill backpressure through write and onDrain', async () => {
    vi.useRealTimers();
    const area = await SpillArea.open(root, { ...defaultSpillLimits, writeBufferBytes: 4 });
    const spill = await area.create();
    const state = harness({ contentType: 'application/x-ndjson', spill });
    const drained = new Promise<void>((resolve) => {
      state.session.onDrain(resolve);
    });

    expect(state.session.write(encoder.encode('{"type":"A"}\n'))).toBe(false);
    await drained;
    state.session.end();
    state.session.dispose();
    await area.dispose();

    const unspilled = harness({ contentType: 'application/x-ndjson' });
    expect(unspilled.session.write(encoder.encode('{"type":"A"}\n'))).toBe(true);
    unspilled.session.dispose();
  });

  it('reads an evicted event back through the spill file', async () => {
    vi.useRealTimers();
    const area = await SpillArea.open(root);
    const spill = await area.create();
    const { bytes, contentType } = fixture('ag-ui.ndjson');
    const state = harness({ contentType, spill, limits: { memoryEvents: 2 } });
    for (const chunk of chunks(bytes, 5)) {
      state.session.write(chunk);
    }
    state.session.end();

    expect(state.session.store.inMemory(1)).toBeUndefined();
    const first = await state.session.store.read(1);
    expect(first).toMatchObject({
      index: 1,
      offset: 0,
      line: 1,
      kind: 'json',
      label: 'RUN_STARTED',
      value: { type: 'RUN_STARTED', threadId: 'thread-1', runId: 'run-1' },
    });
    expect((await state.session.store.read(3))?.value).toEqual({
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'msg-1',
      delta: 'Héllo',
    });
    state.session.dispose();
    await area.dispose();
  });

  it('leaves no timers or open handles after end and dispose', async () => {
    const baseline = fileHandles();
    vi.useRealTimers();
    const area = await SpillArea.open(root);
    const spill = await area.create();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const state = harness({ contentType: 'application/x-ndjson', spill });
    state.session.write(encoder.encode('{"type":"A"}\n'));
    await Promise.resolve();
    vi.advanceTimersByTime(5);
    state.session.write(encoder.encode('{"type":"B"}\n'));
    expect(vi.getTimerCount()).toBe(1);

    state.session.end();
    state.session.dispose();

    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    expect((await state.session.store.read(1))?.label).toBe('A');
    await area.dispose();
    expect(fileHandles()).toBe(baseline);
  });

  it('releases the spill file, ignores writes and stays silent after dispose', async () => {
    vi.useRealTimers();
    const area = await SpillArea.open(root);
    const spill = await area.create();
    const state = harness({ contentType: 'application/x-ndjson', spill });
    state.session.write(encoder.encode('{"type":"A"}\n'));
    state.session.dispose();
    await Promise.resolve();

    expect(state.session.write(encoder.encode('{"type":"B"}\n'))).toBe(true);
    expect(spill.append(encoder.encode('{"type":"C"}\n'))).toBe(true);
    expect(spill.savedBytes).toBe(13);
    expect(state.session.store.count).toBe(1);
    expect(state.updates).toBe(0);
    await area.dispose();
  });
});
