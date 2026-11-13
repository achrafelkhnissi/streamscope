import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptureRegistry } from '../../../src/capture/registry';
import { CaptureTracker, type CaptureResult } from '../../../src/capture/tracker';
import { StreamSession } from '../../../src/events/session';
import { SpillArea, type SpillFile } from '../../../src/events/spill';
import {
  captureRefreshMs,
  PanelFeed,
  readBackBytes,
  readsInFlight,
  RowCache,
} from '../../../src/response/panel-feed';
import type { StreamEvent } from '../../../src/events/model';
import { parseExpression } from '../../../src/expressions/parse';
import { maskedValue } from '../../../src/masking/masking';
import {
  panelLimits,
  type PanelRow,
  type PanelView,
  type ToPanel,
} from '../../../src/response/panel-protocol';
import { RawTail } from '../../../src/runs/raw-tail';
import type { RunSnapshot } from '../../../src/runs/run';
import { missingWorker } from '../capture/worker';
import { snapshot } from './fixtures';

const encoder = new TextEncoder();
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

type Update = Extract<ToPanel, { type: 'update' }>;
type Reset = Extract<ToPanel, { type: 'reset' }>;

interface Harness {
  readRaw: ReturnType<typeof vi.fn<() => Promise<string | undefined>>>;
  readReply: ReturnType<typeof vi.fn<() => Promise<string | undefined>>>;
  posted: ToPanel[];
  feed: PanelFeed;
  registry: CaptureRegistry;
  write(text: string): void;
  set(overrides: Partial<RunSnapshot>): void;
  session: StreamSession;
  updates(): Update[];
  last(): Update;
  reset(): Reset;
}

function lines(from: number, count: number): string {
  return Array.from(
    { length: count },
    (_, at) => `${JSON.stringify({ type: 'PART', index: from + at })}\n`,
  ).join('');
}

function agUi(delta: string): string {
  return `${JSON.stringify({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta })}\n`;
}

function harness(
  options: {
    contentType?: string;
    streamView?: PanelView;
    readOnly?: boolean;
    bodyKept?: boolean;
    spill?: SpillFile;
    readRaw?: () => Promise<string | undefined>;
    readReply?: () => Promise<string | undefined>;
    registry?: CaptureRegistry;
    timed?: (work: () => void) => void;
  } = {},
): Harness {
  const contentType = options.contentType ?? 'application/x-ndjson';
  const session = new StreamSession({
    contentType,
    directive: undefined,
    spill: options.spill,
    now: () => 5,
    onUpdate: () => undefined,
    onText: () => undefined,
  });
  const raw = new RawTail(panelLimits.rawTailChars);
  let current = snapshot({
    status: 'receiving',
    bodyKept: options.bodyKept ?? false,
    body: new Uint8Array(),
    timing: undefined,
    stream: session,
    raw,
    head: {
      httpVersion: '1.1',
      status: 200,
      statusText: 'OK',
      headers: [['Content-Type', contentType]],
    },
  });
  const posted: ToPanel[] = [];
  const readRaw = vi.fn(options.readRaw ?? (() => Promise.resolve(raw.text)));
  const readReply = vi.fn(options.readReply ?? (() => Promise.resolve(session.reply.text())));
  const registry = options.registry ?? new CaptureRegistry();
  const feed = new PanelFeed(
    { id: 7, snapshot: () => current, readRaw, readReply },
    {
      readOnly: options.readOnly ?? false,
      streamView: options.streamView ?? 'events',
      post: (message) => posted.push(message),
      captures: registry,
      timed:
        options.timed ??
        ((work) => {
          work();
        }),
    },
  );
  const updates = (): Update[] =>
    posted.filter((message): message is Update => message.type === 'update');
  return {
    readRaw,
    readReply,
    posted,
    feed,
    registry,
    session,
    write: (text) => {
      const bytes = encoder.encode(text);
      raw.push(bytes);
      session.write(bytes);
    },
    set: (overrides) => {
      current = { ...current, ...overrides };
    },
    updates,
    last: () => {
      const found = updates().at(-1);
      if (found === undefined) {
        throw new Error('no update was posted');
      }
      return found;
    },
    reset: () => {
      const found = posted.findLast((message): message is Reset => message.type === 'reset');
      if (found === undefined) {
        throw new Error('no reset was posted');
      }
      return found;
    },
  };
}

function indexes(rows: readonly PanelRow[]): number[] {
  return rows.map((row) => row.index);
}

async function spillFile(): Promise<SpillFile> {
  const root = mkdtempSync(path.join(tmpdir(), 'streamscope-feed-'));
  const area = await SpillArea.open(root);
  cleanups.push(async () => {
    await area.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  return area.create();
}

describe('PanelFeed', () => {
  it('resets the page and then sends the newest rows', () => {
    const page = harness();
    page.write(lines(1, 3));

    page.feed.start();

    expect(page.posted.map((message) => message.type)).toEqual(['reset', 'update']);
    const reset = page.posted[0];
    expect(reset?.type === 'reset' && reset).toMatchObject({
      run: 7,
      view: 'events',
      readOnly: false,
      body: { kind: 'stream' },
      status: { state: 'receiving', events: 3, running: true },
    });
    expect(reset?.type === 'reset' && reset.headers.startsWith('HTTP/1.1 200 OK\n')).toBe(true);
    const update = page.last();
    expect(update.count).toBe(3);
    expect(indexes(update.rows)).toEqual([1, 2, 3]);
    expect(update.rows[0]?.label).toBe('PART');
    expect(update.rows[0]?.preview).toBe('{"type":"PART","index":1}');
    expect(update.reply).toBeUndefined();
    expect(update.raw).toBeUndefined();
    expect(update.headers).toBeUndefined();
    expect(update.body).toBeUndefined();
  });

  it('posts nothing before it starts or after it pauses', () => {
    const page = harness();
    page.write(lines(1, 3));

    page.feed.refresh();
    page.feed.start();
    page.feed.pause();
    page.write(lines(4, 2));
    page.feed.refresh();
    page.feed.setBody({ kind: 'none' });

    expect(page.posted.map((message) => message.type)).toEqual(['reset', 'update']);
  });

  it('sends only the rows that arrived since the last update while following', () => {
    const page = harness();
    page.write(lines(1, 3));
    page.feed.start();

    page.write(lines(4, 2));
    page.feed.refresh();
    const second = page.last();
    page.feed.refresh();

    expect(indexes(second.rows)).toEqual([4, 5]);
    expect(second.count).toBe(5);
    expect(page.last().rows).toEqual([]);
  });

  it('never sends more than the newest window of rows', () => {
    const page = harness();
    page.write(lines(1, 1000));

    page.feed.start();
    const first = page.last();
    void page.feed.window(981, 1000, true);
    const resent = page.last();
    page.write(lines(1001, 30));
    page.feed.refresh();

    expect(first.rows).toHaveLength(panelLimits.windowRows);
    expect(first.rows[0]?.index).toBe(601);
    expect(indexes(resent.rows)).toEqual(Array.from({ length: 20 }, (_, at) => 981 + at));
    expect(indexes(page.last().rows)).toEqual(Array.from({ length: 20 }, (_, at) => 1011 + at));
  });

  it('keeps Reply and Raw out of updates while their tabs are hidden', () => {
    const page = harness();
    page.write(`${JSON.stringify({ type: 'RUN_STARTED' })}\n${agUi('Hello')}`);
    page.feed.start();

    page.write(agUi(' there'));
    page.feed.refresh();

    expect(page.updates().every((update) => update.reply === undefined)).toBe(true);
    expect(page.updates().every((update) => update.raw === undefined)).toBe(true);
    expect(page.last().status.reply).toBe(true);
  });

  it('sends Raw whole when its tab is picked and then only what is new', () => {
    const page = harness();
    page.write(lines(1, 2));
    page.feed.start();

    page.feed.pick('raw');
    const picked = page.last();
    page.write(lines(3, 1));
    page.feed.refresh();

    expect(page.feed.view).toBe('raw');
    expect(picked.raw).toEqual({ reset: true, text: lines(1, 2) });
    expect(page.last().raw).toEqual({ reset: false, text: lines(3, 1) });
    page.feed.refresh();
    expect(page.last().raw).toBeUndefined();
  });

  it('continues Raw where it stopped when its tab is picked again', () => {
    const page = harness();
    page.write(lines(1, 2));
    page.feed.start();
    page.feed.pick('raw');

    page.feed.pick('events');
    page.write(lines(3, 2));
    page.feed.refresh();
    const hidden = page.last();
    page.feed.pick('raw');

    expect(hidden.raw).toBeUndefined();
    expect(page.last().raw).toEqual({ reset: false, text: lines(3, 2) });
  });

  it('sends Raw whole again after the page reloads', () => {
    const page = harness();
    page.write(lines(1, 2));
    page.feed.start();
    page.feed.pick('raw');

    page.feed.pause();
    page.write(lines(3, 1));
    page.feed.start();

    expect(page.posted.at(-2)).toMatchObject({ type: 'reset', view: 'raw' });
    expect(page.last().raw).toEqual({ reset: true, text: lines(1, 3) });
  });

  it('counts the Raw and Reply characters it sent', () => {
    const written = `${JSON.stringify({ type: 'RUN_STARTED' })}\n${agUi('Hello')}`;
    const page = harness();
    page.write(written);
    page.feed.start();
    expect(page.feed.rawChars).toBe(0);
    expect(page.feed.replyChars).toBe(0);

    page.feed.pick('raw');
    page.feed.select('reply');

    expect(page.feed.rawChars).toBe(written.length);
    expect(page.feed.replyChars).toBe(5);
  });

  it('switches to Reply on request and sends it as it grows', () => {
    const page = harness();
    page.write(`${JSON.stringify({ type: 'RUN_STARTED' })}\n${agUi('Hel')}${agUi('lo')}`);
    page.feed.start();

    page.feed.select('reply');
    const selected = page.posted.slice(-2);
    page.write(agUi(' you'));
    page.feed.refresh();

    expect(selected[0]).toMatchObject({ type: 'update', reply: { reset: true, text: 'Hello' } });
    expect(selected[1]).toEqual({ type: 'select', view: 'reply' });
    expect(page.last().reply).toEqual({ reset: false, text: ' you' });
  });

  it('shows Events until the remembered Reply view has a reply', () => {
    const page = harness({ streamView: 'reply' });
    page.write(lines(1, 1));
    page.feed.start();

    expect(page.posted[0]).toMatchObject({ type: 'reset', view: 'events' });
    page.write(`${JSON.stringify({ type: 'RUN_STARTED' })}\n${agUi('Hi')}`);
    page.feed.refresh();

    expect(page.feed.view).toBe('reply');
    expect(page.last().reply).toEqual({ reset: true, text: 'Hi' });
    expect(page.posted.at(-1)).toEqual({ type: 'select', view: 'reply' });
  });

  it('moves a response first shown on Body to the stream view once it turns out to be a stream', () => {
    const page = harness({ contentType: 'application/json', bodyKept: true, streamView: 'raw' });
    page.feed.start();

    page.write(lines(1, 2));
    page.set({ bodyKept: false });
    page.feed.refresh();

    expect(page.posted[0]).toMatchObject({
      type: 'reset',
      view: 'body',
      body: { kind: 'arriving' },
    });
    expect(page.last().body).toEqual({ kind: 'stream' });
    expect(page.last().raw).toEqual({ reset: true, text: lines(1, 2) });
    expect(page.posted.at(-1)).toEqual({ type: 'select', view: 'raw' });
    expect(page.feed.view).toBe('raw');
  });

  it('stays on the tab the user picked when the stream is detected later', () => {
    const page = harness({ contentType: 'application/json', bodyKept: true, streamView: 'raw' });
    page.feed.start();
    page.feed.pick('headers');

    page.write(lines(1, 2));
    page.set({ bodyKept: false });
    page.feed.refresh();

    expect(page.posted.at(-1)?.type).toBe('update');
    expect(page.feed.view).toBe('headers');
  });

  it('opens a stream labelled as one on the remembered view', () => {
    const page = harness({ streamView: 'raw', bodyKept: true });

    page.feed.start();

    expect(page.posted[0]).toMatchObject({ type: 'reset', view: 'raw' });
  });

  it('reads the requested window when the list is scrolled back', async () => {
    const page = harness();
    page.write(lines(1, 50));
    page.feed.start();

    await page.feed.window(5, 9, false);
    page.write(lines(51, 2));
    page.feed.refresh();

    const rows = page.posted.find((message) => message.type === 'rows');
    expect(rows?.type === 'rows' && indexes(rows.rows)).toEqual([5, 6, 7, 8, 9]);
    expect(rows?.type === 'rows' && rows.rows[0]?.preview).toBe('{"type":"PART","index":5}');
    expect(page.last().rows).toEqual([]);
    expect(page.last().count).toBe(52);
  });

  it('reads back the previews of rows that are no longer in memory', async () => {
    const page = harness({ spill: await spillFile() });
    page.write(lines(1, 10));
    page.session.end();
    page.session.store.compact();

    page.feed.start();
    const update = page.last();
    await vi.waitFor(() => {
      expect(page.posted.at(-1)?.type).toBe('rows');
    });
    const rows = page.posted.at(-1);

    expect(indexes(update.rows)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(update.rows[3]).toMatchObject({ label: 'PART', preview: '' });
    expect(rows?.type === 'rows' && rows.rows[3]?.preview).toBe('{"type":"PART","index":4}');
  });

  it('reads back only events small enough for a preview', async () => {
    const page = harness({ spill: await spillFile() });
    const large = JSON.stringify({ type: 'LARGE', padding: 'x'.repeat(readBackBytes) });
    page.write(`${lines(1, 2)}${large}\n${lines(4, 2)}`);
    page.session.end();
    page.session.store.compact();
    const read = vi.spyOn(page.session.store, 'read');

    page.feed.start();
    await vi.waitFor(() => {
      expect(page.posted.at(-1)?.type).toBe('rows');
    });
    const rows = page.posted.at(-1);

    expect(read.mock.calls.map(([index]) => index)).toEqual([1, 2, 4, 5]);
    expect(page.last().rows[2]).toMatchObject({ index: 3, label: 'LARGE', preview: '' });
    expect(rows?.type === 'rows' && indexes(rows.rows)).toEqual([1, 2, 4, 5]);
  });

  it('keeps a bounded number of reads in flight and drops the queued reads of a replaced window', async () => {
    const page = harness();
    page.write(lines(1, 1000));
    page.feed.start();
    page.session.store.compact();
    let active = 0;
    let most = 0;
    const started: number[] = [];
    const waiting: (() => void)[] = [];
    vi.spyOn(page.session.store, 'read').mockImplementation((index) => {
      started.push(index);
      active += 1;
      most = Math.max(most, active);
      return new Promise<StreamEvent | undefined>((resolve) => {
        waiting.push(() => {
          active -= 1;
          resolve(undefined);
        });
      });
    });
    const finish = async (): Promise<void> => {
      while (waiting.length > 0) {
        waiting.splice(0).forEach((release) => {
          release();
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };

    const first = page.feed.window(1, 100, false);
    const second = page.feed.window(101, 200, false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const inFlight = active;
    await finish();
    await Promise.all([first, second]);

    expect(inFlight).toBe(readsInFlight);
    expect(most).toBe(readsInFlight);
    expect(started.filter((index) => index <= 100)).toHaveLength(readsInFlight);
    expect(started.filter((index) => index > 100)).toHaveLength(100);
    const windows = page.posted.filter((message) => message.type === 'rows');
    expect(windows).toHaveLength(1);
    expect(windows[0]?.type === 'rows' && windows[0].rows[0]?.index).toBe(101);
  });

  it('treats an event whose read fails as no longer available', async () => {
    const page = harness();
    page.write(lines(1, 1000));
    page.feed.start();
    page.session.store.compact();
    vi.spyOn(page.session.store, 'read').mockRejectedValue(new Error('synthetic EIO'));

    await page.feed.window(3, 4, false);
    await page.feed.detail(3);

    const rows = page.posted.find((message) => message.type === 'rows');
    expect(rows?.type === 'rows' && rows.rows.map((row) => row.preview)).toEqual(['', '']);
    expect(page.posted.at(-1)).toMatchObject({
      type: 'detail',
      index: 3,
      text: 'This event is no longer available.',
    });
  });

  it('counts drawn rows only forward and from zero after a reload', () => {
    const page = harness();
    page.write(lines(1, 10));
    page.feed.start();

    page.feed.acknowledge(8);
    page.feed.acknowledge(3);
    const drawn = page.feed.rendered;
    page.feed.pause();
    page.feed.start();

    expect(drawn).toBe(8);
    expect(page.feed.rendered).toBe(0);
  });

  it('says an event is no longer available when it cannot be read', async () => {
    const page = harness();
    page.write(lines(1, 3));
    page.session.store.compact();
    page.feed.start();

    await page.feed.detail(2);

    expect(page.posted.at(-1)).toEqual({
      type: 'detail',
      run: 7,
      index: 2,
      text: 'This event is no longer available.',
      truncated: false,
    });
  });

  it('answers a detail request even when the list window moves meanwhile', async () => {
    const page = harness();
    page.write(lines(1, 30));
    page.feed.start();

    const detail = page.feed.detail(4);
    const window = page.feed.window(1, 20, false);
    await Promise.all([detail, window]);

    expect(page.posted.some((message) => message.type === 'detail' && message.index === 4)).toBe(
      true,
    );
  });

  it('drops a window read that a newer window request replaced', async () => {
    const page = harness();
    page.write(lines(1, 30));
    page.feed.start();

    const first = page.feed.window(1, 10, false);
    const second = page.feed.window(11, 20, false);
    await Promise.all([first, second]);

    const windows = page.posted.filter((message) => message.type === 'rows');
    expect(windows).toHaveLength(1);
    expect(windows[0]?.type === 'rows' && windows[0].rows[0]?.index).toBe(11);
  });

  it('shows an event in full detail up to the inline limit', async () => {
    const page = harness();
    const wide = { type: 'WIDE', items: Array.from({ length: 20_000 }, (_, index) => index) };
    page.write(`${JSON.stringify({ type: 'SMALL', ok: true })}\n${JSON.stringify(wide)}\n`);
    page.feed.start();

    await page.feed.detail(1);
    const small = page.posted.at(-1);
    await page.feed.detail(2);
    const large = page.posted.at(-1);

    expect(small).toEqual({
      type: 'detail',
      run: 7,
      index: 1,
      text: '{\n  "type": "SMALL",\n  "ok": true\n}',
      truncated: false,
    });
    expect(large?.type === 'detail' && large.truncated).toBe(true);
    expect(
      large?.type === 'detail' && Buffer.byteLength(large.text) <= panelLimits.inlineEventBytes,
    ).toBe(true);
  });

  it('sends the parse error of a malformed event with its detail', async () => {
    const page = harness();
    page.write(`${JSON.stringify({ type: 'OK' })}\n{"type":\n`);
    page.feed.start();

    await page.feed.detail(1);
    const valid = page.posted.at(-1);
    await page.feed.detail(2);
    const malformed = page.posted.at(-1);

    expect(valid).toMatchObject({ type: 'detail', index: 1, note: undefined });
    expect(malformed).toMatchObject({ type: 'detail', index: 2, text: '{"type":' });
    expect(malformed?.type === 'detail' && malformed.note).toMatch(
      /^Event 2 is not valid JSON: \S/,
    );
  });

  it('says why the detail of an oversize event is only its beginning', async () => {
    const page = harness();
    page.write(lines(1, 3));
    page.feed.start();
    const oversize: StreamEvent = {
      index: 2,
      time: 5,
      offset: 0,
      length: 20_000_000,
      line: 2,
      kind: 'oversize',
      value: '{"type":"BIG",',
      label: undefined,
      sse: undefined,
      marker: undefined,
      error: undefined,
      unterminated: false,
    };
    vi.spyOn(page.session.store, 'read').mockResolvedValue(oversize);

    await page.feed.detail(2);

    expect(page.posted.at(-1)).toMatchObject({
      type: 'detail',
      index: 2,
      text: '{"type":"BIG",',
      note: 'Event 2 is larger than streamscope.stream.maxEventSize, so only its beginning was kept.',
    });
  });

  it('caps the note of a detail like its text', async () => {
    const page = harness();
    page.write(lines(1, 1));
    page.feed.start();
    const error = 'é'.repeat(panelLimits.inlineEventBytes);
    vi.spyOn(page.session.store, 'read').mockResolvedValue({
      index: 1,
      time: 5,
      offset: 0,
      length: 8,
      line: 1,
      kind: 'malformed',
      value: '{"type":',
      label: undefined,
      sse: undefined,
      marker: undefined,
      error,
      unterminated: false,
    });

    await page.feed.detail(1);
    const detail = page.posted.at(-1);
    const note = detail?.type === 'detail' ? (detail.note ?? '') : '';

    expect(note.startsWith('Event 1 is not valid JSON: éé')).toBe(true);
    expect(Buffer.byteLength(note)).toBeLessThanOrEqual(panelLimits.inlineEventBytes);
    expect(Buffer.byteLength(note)).toBeGreaterThan(panelLimits.inlineEventBytes - 2);
  });

  it('sends the headers again only when the run changes state', () => {
    const page = harness();
    page.feed.start();
    page.feed.refresh();
    const unchanged = page.last().headers;

    page.set({ status: 'completed', timing: { totalMs: 40 } });
    page.feed.refresh();
    const changed = page.last().headers;
    page.feed.refresh();

    expect(unchanged).toBeUndefined();
    expect(changed).toContain('### Timing');
    expect(page.last().headers).toBeUndefined();
    expect(page.last().status).toMatchObject({ state: 'completed', running: false });
  });

  it('says a body is still arriving while it is received, without leaving Body', () => {
    const page = harness({ contentType: 'text/plain', bodyKept: true, streamView: 'raw' });
    page.feed.start();
    page.write('first part ');
    page.feed.refresh();
    const receiving = page.feed.body;

    page.set({ status: 'completed' });
    page.feed.refresh();
    const ended = page.last().body;
    page.feed.setBody({ kind: 'text', language: 'plaintext', text: 'first part second part' });

    expect(page.posted[0]).toMatchObject({
      type: 'reset',
      view: 'body',
      body: { kind: 'arriving' },
    });
    expect(receiving).toEqual({ kind: 'arriving' });
    expect(page.posted.some((message) => message.type === 'select')).toBe(false);
    expect(ended).toEqual({ kind: 'none' });
    expect(page.feed.body).toEqual({
      kind: 'text',
      language: 'plaintext',
      text: 'first part second part',
    });
    expect(page.feed.view).toBe('body');
  });

  it('says nothing about the body before the response arrives', () => {
    const page = harness({ contentType: 'text/plain', bodyKept: true });
    page.set({ status: 'sending', head: undefined });

    page.feed.start();

    expect(page.posted[0]).toMatchObject({ type: 'reset', body: { kind: 'none' } });
  });

  it('sends the formatted body once', () => {
    const page = harness({ contentType: 'application/json', bodyKept: true });
    page.feed.start();

    page.feed.setBody({ kind: 'text', language: 'json', text: '{}' });
    const first = page.last();
    page.feed.refresh();

    expect(first.body).toEqual({ kind: 'text', language: 'json', text: '{}' });
    expect(page.feed.body).toEqual({ kind: 'text', language: 'json', text: '{}' });
    expect(page.last().body).toBeUndefined();
  });

  it('expands an event after the page is reset', () => {
    const page = harness();
    page.write(lines(1, 5));

    page.feed.expand(3);
    page.feed.start();

    expect(page.posted.map((message) => message.type)).toEqual(['reset', 'update', 'expand']);
    expect(page.posted.at(-1)).toEqual({ type: 'expand', index: 3 });
    expect(page.feed.view).toBe('events');
  });

  it('carries a read-only run to the page', () => {
    const page = harness({ readOnly: true });

    page.feed.start();

    expect(page.posted[0]).toMatchObject({ type: 'reset', readOnly: true });
  });
});

describe('PanelFeed captured values', () => {
  const key = snapshot().key;
  const shownRun = 7;
  const threadId = [{ name: 'threadId', secret: false }];

  afterEach(() => {
    vi.useRealTimers();
  });

  function begin(
    registry: CaptureRegistry,
    definitions: readonly { name: string; secret: boolean }[],
    id = shownRun,
  ): void {
    registry.begin({ id, key, label: 'items', startedAt: id }, definitions);
  }

  function resolved(text: string, secret = false): CaptureResult {
    return {
      state: 'resolved',
      text,
      secret,
      sensitive: [],
      provenance: { runId: shownRun, event: 1, path: 'threadId', time: 0 },
    };
  }

  it("posts the shown run's captures and only the changes", () => {
    vi.useFakeTimers();
    const page = harness();
    begin(page.registry, [...threadId, { name: 'messageId', secret: false }]);
    page.feed.start();

    expect(page.reset().captures).toEqual([
      { name: 'threadId', state: 'pending', text: '' },
      { name: 'messageId', state: 'pending', text: '' },
    ]);
    expect(page.last().captures).toBeUndefined();

    const before = page.updates().length;
    page.registry.update(shownRun, 'threadId', resolved('thread-1'));
    page.registry.update(shownRun, 'messageId', {
      state: 'failed',
      reason: 'no event matched last(type == "RUN_FINISHED") (3 events)',
    });
    expect(page.updates()).toHaveLength(before);
    vi.advanceTimersByTime(captureRefreshMs);

    expect(page.updates()).toHaveLength(before + 1);
    expect(page.last().captures).toEqual([
      { name: 'threadId', state: 'resolved', text: 'thread-1' },
      {
        name: 'messageId',
        state: 'failed',
        text: 'no event matched last(type == "RUN_FINISHED") (3 events)',
      },
    ]);
    page.feed.refresh();
    expect(page.last().captures).toBeUndefined();

    page.registry.update(shownRun, 'threadId', resolved('thread-1'));
    vi.advanceTimersByTime(captureRefreshMs);
    expect(page.last().captures).toBeUndefined();

    const sent = page.updates().length;
    page.registry.begin(
      { id: 9, key: 'file:///requests.http\n@other', label: 'other', startedAt: 9 },
      threadId,
    );
    page.registry.update(9, 'threadId', resolved('thread-2'));
    vi.advanceTimersByTime(captureRefreshMs);
    expect(page.updates()).toHaveLength(sent);
  });

  it('masks secret values before posting', () => {
    vi.useFakeTimers();
    const page = harness();
    begin(page.registry, [
      { name: 'sessionId', secret: true },
      { name: 'marked', secret: false },
      { name: 'accessToken', secret: false },
      { name: 'callback', secret: false },
      { name: 'later', secret: true },
    ]);
    page.registry.update(shownRun, 'sessionId', resolved('synthetic-session-value'));
    page.registry.update(shownRun, 'marked', resolved('synthetic-marked-value', true));
    page.registry.update(shownRun, 'accessToken', resolved('synthetic-token-value'));
    page.registry.update(
      shownRun,
      'callback',
      resolved('https://user:synthetic-password@hooks.example.test/done'),
    );
    page.feed.start();
    page.registry.update(shownRun, 'later', resolved('synthetic-later-value'));
    vi.advanceTimersByTime(captureRefreshMs);

    expect(page.reset().captures).toEqual([
      { name: 'sessionId', state: 'resolved', text: maskedValue },
      { name: 'marked', state: 'resolved', text: maskedValue },
      { name: 'accessToken', state: 'resolved', text: maskedValue },
      {
        name: 'callback',
        state: 'resolved',
        text: `https://${maskedValue}@hooks.example.test/done`,
      },
      { name: 'later', state: 'pending', text: '' },
    ]);
    expect(page.last().captures?.at(-1)).toEqual({
      name: 'later',
      state: 'resolved',
      text: maskedValue,
    });
    const sent = JSON.stringify(page.posted);
    for (const value of [
      'synthetic-session-value',
      'synthetic-marked-value',
      'synthetic-token-value',
      'synthetic-password',
      'synthetic-later-value',
    ]) {
      expect(sent).not.toContain(value);
    }
  });

  it("masks the run's sensitive values in a failure reason, as its status line does", async () => {
    const secretHost = 'secret-host.example.test';
    const page = harness();
    page.set({ sensitiveValues: [secretHost] });
    begin(page.registry, threadId);
    const text = 'first(type == "RUN_STARTED").threadId';
    const parsed = parseExpression(text, 'capture');
    if (!parsed.ok) {
      throw new Error(parsed.error.message);
    }
    const tracker = new CaptureTracker(
      { id: shownRun, label: 'items', wallStartedAt: 0, sensitiveValues: [secretHost] },
      [{ name: 'threadId', secret: false, expression: parsed.expr, text }],
      (name, result) => {
        page.registry.update(shownRun, name, result);
      },
      missingWorker,
    );
    await tracker.end({ kind: 'failed', message: `Could not resolve ${secretHost}.` });
    page.feed.start();

    expect(page.reset().captures).toEqual([
      {
        name: 'threadId',
        state: 'failed',
        text: `items failed before threadId resolved: Could not resolve ${maskedValue}`,
      },
    ]);
    expect(JSON.stringify(page.posted)).not.toContain(secretHost);
  });

  it('cuts text at 200 characters and sends at most 64', () => {
    const page = harness();
    begin(
      page.registry,
      Array.from({ length: 70 }, (_, at) => ({ name: `value${String(at + 1)}`, secret: false })),
    );
    page.registry.update(shownRun, 'value1', resolved('a'.repeat(1000)));
    page.registry.update(shownRun, 'value2', {
      state: 'failed',
      reason: `the body has no value at ${'b'.repeat(500)}`,
    });
    page.registry.update(shownRun, 'value3', resolved('c'.repeat(200)));
    page.feed.start();

    const captures = page.reset().captures;
    expect(captures).toHaveLength(64);
    expect(captures.at(-1)?.name).toBe('value64');
    expect(captures[0]?.text).toBe(`${'a'.repeat(199)}…`);
    expect(captures[1]?.text).toBe(`the body has no value at ${'b'.repeat(174)}…`);
    expect(captures[2]?.text).toBe('c'.repeat(200));
  });

  it("the strip is hidden for a run that is no longer the request's latest", () => {
    vi.useFakeTimers();
    const page = harness();
    begin(page.registry, threadId);
    page.feed.start();
    expect(page.reset().captures).toHaveLength(1);

    begin(page.registry, threadId, 8);
    vi.advanceTimersByTime(captureRefreshMs);
    expect(page.last().captures).toEqual([]);

    const registry = new CaptureRegistry();
    begin(registry, threadId, 8);
    const history = harness({ registry, readOnly: true });
    history.feed.start();
    expect(history.reset().captures).toEqual([]);
  });

  it('cuts names at 200 characters too', () => {
    const page = harness();
    const name = `n${'a'.repeat(299)}`;
    begin(page.registry, [{ name, secret: false }]);
    page.feed.start();

    expect(page.reset().captures[0]?.name).toBe(`${name.slice(0, 199)}…`);
  });

  it('shows an empty value as "" in the strip, as the inlay hint does', () => {
    const page = harness();
    begin(page.registry, threadId);
    page.registry.update(shownRun, 'threadId', resolved(''));
    page.feed.start();

    expect(page.reset().captures).toEqual([{ name: 'threadId', state: 'resolved', text: '""' }]);
  });

  it("refreshes for a capture change through the panel's timed path", () => {
    vi.useFakeTimers();
    const timed = vi.fn((work: () => void) => {
      work();
    });
    const page = harness({ timed });
    begin(page.registry, threadId);
    page.feed.start();

    page.registry.update(shownRun, 'threadId', resolved('thread-1'));
    vi.advanceTimersByTime(captureRefreshMs);

    expect(timed).toHaveBeenCalledTimes(1);
    expect(page.last().captures).toEqual([
      { name: 'threadId', state: 'resolved', text: 'thread-1' },
    ]);
  });

  it('removes its registry listener and pending refresh when the panel is hidden or disposed', () => {
    vi.useFakeTimers();
    const page = harness();
    begin(page.registry, threadId);
    expect(page.registry.listenerCount).toBe(0);

    page.feed.start();
    page.feed.start();
    expect(page.registry.listenerCount).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    page.registry.update(shownRun, 'threadId', resolved('thread-1'));
    expect(vi.getTimerCount()).toBe(1);

    const sent = page.posted.length;
    page.feed.pause();
    expect(page.registry.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    page.registry.update(shownRun, 'threadId', resolved('thread-2'));
    vi.advanceTimersByTime(captureRefreshMs);
    expect(page.posted).toHaveLength(sent);

    page.feed.start();
    expect(page.registry.listenerCount).toBe(1);
    expect(page.reset().captures).toEqual([
      { name: 'threadId', state: 'resolved', text: 'thread-2' },
    ]);
  });
});

describe('RowCache', () => {
  function row(index: number): PanelRow {
    return { index, time: '', label: '', preview: '', kind: 'json' };
  }

  it('keeps at most its capacity and drops the least recently used row first', () => {
    const cache = new RowCache(3);
    cache.set(row(1));
    cache.set(row(2));
    cache.set(row(3));

    expect(cache.get(1)?.index).toBe(1);
    cache.set(row(4));

    expect(cache.size).toBe(3);
    expect(cache.get(2)).toBeUndefined();
    expect(cache.get(1)?.index).toBe(1);
    for (let index = 5; index < 2000; index += 1) {
      cache.set(row(index));
    }
    expect(cache.size).toBe(3);
  });
});

describe('PanelFeed for a run whose Raw and Reply were dropped from memory', () => {
  const rawStart = `${JSON.stringify({ type: 'RUN_STARTED' })}\n`;
  const written = `${rawStart}${agUi('Hello')}`;

  function compacted(
    options: Parameters<typeof harness>[0] = {},
    overrides: Partial<RunSnapshot> = {},
  ): Harness {
    const page = harness(options);
    page.write(written);
    page.set({ status: 'completed', rawSource: 'spill', replySource: 'spill', ...overrides });
    return page;
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('reads the Raw tail back when its tab is shown and sends it whole once', async () => {
    const page = compacted({ readRaw: () => Promise.resolve('stored raw\n') });
    page.feed.start();
    expect(page.readRaw).not.toHaveBeenCalled();

    page.feed.pick('raw');
    expect(page.last().raw).toBeUndefined();
    await settle();

    expect(page.readRaw).toHaveBeenCalledTimes(1);
    expect(page.last().raw).toEqual({ reset: true, text: 'stored raw\n' });
    const sent = page.updates().length;
    page.feed.refresh();
    expect(page.last().raw).toBeUndefined();
    expect(page.updates().length).toBe(sent + 1);
    expect(page.readRaw).toHaveBeenCalledTimes(1);
  });

  it('counts the characters of the stored Raw it sent like live ones', async () => {
    const page = compacted({ readRaw: () => Promise.resolve('stored raw\n') });
    page.feed.start();
    expect(page.feed.rawChars).toBe(0);

    page.feed.pick('raw');
    await settle();

    expect(page.feed.rawChars).toBe(written.length);
  });

  it('reads the Raw tail again after the page reloads rather than keeping it', async () => {
    const page = compacted({ readRaw: () => Promise.resolve('stored raw\n') });
    page.feed.start();
    page.feed.pick('raw');
    await settle();

    page.feed.pause();
    page.feed.start();
    await settle();

    expect(page.readRaw).toHaveBeenCalledTimes(2);
    expect(page.last().raw).toEqual({ reset: true, text: 'stored raw\n' });
  });

  it('sends only the end of a stored Raw tail that is larger than a message', async () => {
    const big = `${'a'.repeat(700_000)}\n${'b'.repeat(100)}`;
    const page = compacted({ readRaw: () => Promise.resolve(big) });
    page.feed.start();
    page.feed.pick('raw');
    await settle();

    const sent = page.last().raw;
    expect(sent?.reset).toBe(true);
    expect(sent?.text.length).toBeLessThanOrEqual(panelLimits.messageBytes / 2);
    expect(big.endsWith(sent?.text ?? '?')).toBe(true);
  });

  it('does not read Raw that is gone, and says so', () => {
    const page = compacted({}, { rawSource: 'gone' });
    page.feed.start();

    page.feed.pick('raw');

    expect(page.readRaw).not.toHaveBeenCalled();
    expect(page.last().raw).toBeUndefined();
    expect(page.last().status.rawGone).toBe(true);
    expect(page.last().status.replyGone).toBe(false);
  });

  it('says Raw is gone when it could not be read after all', async () => {
    const page = compacted({ readRaw: () => Promise.resolve(undefined) });
    page.feed.start();
    page.feed.pick('raw');
    expect(page.last().status.rawGone).toBe(false);

    await settle();

    expect(page.last().raw).toBeUndefined();
    expect(page.last().status.rawGone).toBe(true);
    expect(page.readRaw).toHaveBeenCalledTimes(1);
  });

  it('ignores a read that finishes after the page was reset', async () => {
    const pending: ((text: string) => void)[] = [];
    const page = compacted({
      readRaw: () =>
        new Promise<string | undefined>((resolve) => {
          pending.push(resolve);
        }),
    });
    page.feed.start();
    page.feed.pick('raw');

    page.feed.pause();
    page.feed.start();
    pending[0]?.('old text');
    pending[1]?.('new text');
    await settle();

    const sent = page.updates().flatMap((update) => (update.raw === undefined ? [] : [update.raw]));
    expect(pending).toHaveLength(2);
    expect(sent).toEqual([{ reset: true, text: 'new text' }]);
  });

  it('reads the Reply back when its tab is shown and sends it whole once', async () => {
    const page = compacted({ readReply: () => Promise.resolve('Hello') });
    page.feed.start();
    expect(page.readReply).not.toHaveBeenCalled();

    page.feed.select('reply');
    await settle();

    expect(page.readReply).toHaveBeenCalledTimes(1);
    expect(page.last().reply).toEqual({ reset: true, text: 'Hello' });
    expect(page.feed.replyChars).toBe(5);
    expect(page.last().status.reply).toBe(true);
    page.feed.refresh();
    expect(page.last().reply).toBeUndefined();
    expect(page.readReply).toHaveBeenCalledTimes(1);
  });

  it('does not read a Reply that is gone, and keeps the tab', () => {
    const page = compacted({}, { replySource: 'gone' });
    page.feed.start();

    page.feed.select('reply');

    expect(page.readReply).not.toHaveBeenCalled();
    expect(page.feed.view).toBe('reply');
    expect(page.last().status.reply).toBe(true);
    expect(page.last().status.replyGone).toBe(true);
  });

  it('says the Reply is gone when it could not be read after all', async () => {
    const page = compacted({ readReply: () => Promise.resolve(undefined) });
    page.feed.start();

    page.feed.select('reply');
    await settle();

    expect(page.last().reply).toBeUndefined();
    expect(page.last().status.replyGone).toBe(true);
  });

  it('keeps the live path for a run that still holds its data', () => {
    const page = harness();
    page.write(`${rawStart}${agUi('Hello')}`);
    page.set({ status: 'completed' });
    page.feed.start();

    page.feed.pick('raw');
    page.feed.select('reply');

    expect(page.readRaw).not.toHaveBeenCalled();
    expect(page.readReply).not.toHaveBeenCalled();
    expect(page.last().reply).toEqual({ reset: true, text: 'Hello' });
  });
});
