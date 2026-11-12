import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamSession } from '../../../src/events/session';
import { SpillArea, type SpillFile } from '../../../src/events/spill';
import {
  PanelFeed,
  readBackBytes,
  readsInFlight,
  RowCache,
} from '../../../src/response/panel-feed';
import type { StreamEvent } from '../../../src/events/model';
import {
  panelLimits,
  type PanelRow,
  type PanelView,
  type ToPanel,
} from '../../../src/response/panel-protocol';
import { RawTail } from '../../../src/runs/raw-tail';
import type { RunSnapshot } from '../../../src/runs/run';
import { snapshot } from './fixtures';

const encoder = new TextEncoder();
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

type Update = Extract<ToPanel, { type: 'update' }>;

interface Harness {
  posted: ToPanel[];
  feed: PanelFeed;
  write(text: string): void;
  set(overrides: Partial<RunSnapshot>): void;
  session: StreamSession;
  updates(): Update[];
  last(): Update;
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
  const feed = new PanelFeed(
    { id: 7, snapshot: () => current },
    {
      readOnly: options.readOnly ?? false,
      streamView: options.streamView ?? 'events',
      post: (message) => posted.push(message),
    },
  );
  const updates = (): Update[] =>
    posted.filter((message): message is Update => message.type === 'update');
  return {
    posted,
    feed,
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

    expect(page.posted[0]).toMatchObject({ type: 'reset', view: 'body', body: { kind: 'none' } });
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
    page.session.store.release();

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
    page.session.store.release();
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
    page.session.store.release();
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
    page.session.store.release();
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
    page.session.store.release();
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
