import { describe, expect, it } from 'vitest';
import type { JsonValue, StreamEvent } from '../../../src/events/model';
import { StreamSession } from '../../../src/events/session';
import {
  capTail,
  compactEventJson,
  eventNote,
  eventText,
  panelBody,
  panelStatus,
} from '../../../src/response/panel-content';
import { panelLimits } from '../../../src/response/panel-protocol';
import { snapshot } from './fixtures';

const encoder = new TextEncoder();

function session(contentType: string, bytes: Uint8Array | string): StreamSession {
  const created = new StreamSession({
    contentType,
    directive: undefined,
    spill: undefined,
    now: () => 5,
    onUpdate: () => undefined,
    onText: () => undefined,
  });
  created.write(typeof bytes === 'string' ? encoder.encode(bytes) : bytes);
  created.end();
  return created;
}

function lines(count: number, make: (index: number) => object): string {
  return Array.from({ length: count }, (_, index) => `${JSON.stringify(make(index))}\n`).join('');
}

function event(value: JsonValue, overrides: Partial<StreamEvent> = {}): StreamEvent {
  return {
    index: 1,
    time: 0,
    offset: 0,
    length: 1,
    line: 1,
    kind: 'json',
    value,
    label: undefined,
    sse: undefined,
    marker: undefined,
    error: undefined,
    unterminated: false,
    ...overrides,
  };
}

describe('panelStatus', () => {
  it('describes a live stream with its status line, events, bytes and time', () => {
    const stream = session(
      'application/x-ndjson',
      lines(3, (index) => ({ type: 'PART', index })),
    );

    expect(
      panelStatus(
        snapshot({
          status: 'receiving',
          bodyKept: false,
          stream,
          receivedBytes: 12_400,
          elapsedMs: 2100,
        }),
      ),
    ).toEqual({
      state: 'receiving',
      text: '200 OK · 3 events · 12.1 KB · 2.1 s',
      running: true,
      events: 3,
      warnings: 0,
      format: 'NDJSON (server said application/x-ndjson)',
      reply: false,
      replyCut: false,
    });
  });

  it('gives the size and time of a body response', () => {
    expect(panelStatus(snapshot())).toEqual({
      state: 'completed',
      text: '200 OK · 1.2 KB · 120 ms',
      running: false,
      events: 0,
      warnings: 0,
      format: undefined,
      reply: false,
      replyCut: false,
    });
  });

  it('names a single event in the singular', () => {
    const stream = session(
      'application/x-ndjson',
      lines(1, () => ({ type: 'ONLY' })),
    );

    expect(panelStatus(snapshot({ bodyKept: false, stream, receivedBytes: 16 })).text).toBe(
      '200 OK · 1 event · 16 B · 120 ms',
    );
  });

  it('adds why a stream failed after what arrived', () => {
    const stream = session(
      'application/x-ndjson',
      lines(2, (index) => ({ index })),
    );

    expect(
      panelStatus(
        snapshot({
          status: 'failed',
          bodyKept: false,
          stream,
          receivedBytes: 24,
          failure: { kind: 'premature-close', message: 'The connection closed early.' },
        }),
      ).text,
    ).toBe('200 OK · 2 events · 24 B · 120 ms · The connection closed early.');
  });

  it('says why a run failed before any response', () => {
    expect(
      panelStatus(
        snapshot({
          status: 'failed',
          head: undefined,
          receivedBytes: 0,
          failure: { kind: 'refused', message: 'Connection refused.' },
        }),
      ).text,
    ).toBe('120 ms · Connection refused.');
  });

  it('says when the raw data of a stream is not saved', () => {
    const stream = session(
      'application/x-ndjson',
      lines(1, () => ({ type: 'ONLY' })),
    );
    const text = (rawData: 'saved' | 'stopped' | 'removed' | 'unsaved'): string =>
      panelStatus(snapshot({ bodyKept: false, stream, receivedBytes: 16, rawData })).text;

    expect(text('saved')).toBe('200 OK · 1 event · 16 B · 120 ms');
    expect(text('unsaved')).toBe('200 OK · 1 event · 16 B · 120 ms · raw data not saved');
    expect(text('stopped')).toBe('200 OK · 1 event · 16 B · 120 ms · raw data no longer saved');
    expect(text('removed')).toBe('200 OK · 1 event · 16 B · 120 ms · raw data removed');
    expect(panelStatus(snapshot({ rawData: 'unsaved' })).text).toBe('200 OK · 1.2 KB · 120 ms');
  });

  it('reports a recognised reply and the stream warnings', () => {
    const text = lines(2, (index) =>
      index === 0
        ? { type: 'RUN_STARTED' }
        : { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'Hi' },
    );
    const bytes = Buffer.concat([Buffer.from(text), Buffer.from([0xff, 0x0a])]);
    const stream = session('application/x-ndjson', bytes);

    const status = panelStatus(snapshot({ bodyKept: false, stream }));

    expect(status.reply).toBe(true);
    expect(status.warnings).toBe(1);
  });

  it('says when the reply was cut off', () => {
    const text = lines(2, (index) =>
      index === 0
        ? { type: 'RUN_STARTED' }
        : { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'x'.repeat(1_048_577) },
    );
    const stream = session('application/x-ndjson', text);

    const status = panelStatus(snapshot({ bodyKept: false, stream }));

    expect(status.reply).toBe(true);
    expect(status.replyCut).toBe(true);
  });

  it('masks sensitive values in the status text', () => {
    expect(
      panelStatus(
        snapshot({
          status: 'failed',
          head: undefined,
          failure: { kind: 'invalid-request', message: 'Bad value synthetic-secret-value.' },
          sensitiveValues: ['synthetic-secret-value'],
        }),
      ).text,
    ).toBe('120 ms · Bad value ••••••.');
  });

  it('says why a run was not sent', () => {
    const status = panelStatus(
      snapshot({
        status: 'blocked',
        head: undefined,
        problems: [
          {
            message: 'Missing value.',
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
          },
        ],
      }),
    );

    expect(status.text).toBe('120 ms · Missing value.');
    expect(status.running).toBe(false);
  });
});

describe('panelBody', () => {
  it('shows a body within the inline limit in full', () => {
    const text = '{\n  "items": []\n}';

    expect(panelBody(encoder.encode(text), 'json', 20)).toEqual({
      kind: 'text',
      language: 'json',
      text,
    });
  });

  it('shows the first lines of a larger body as a preview', () => {
    const line = `${'x'.repeat(99)}\n`;
    const content = encoder.encode(line.repeat(20_000));
    expect(content.length).toBeGreaterThan(panelLimits.inlineBodyBytes);

    const body = panelBody(content, 'plaintext', 3_000_000);

    expect(body).toEqual({
      kind: 'preview',
      language: 'plaintext',
      text: line.repeat(panelLimits.previewLines).slice(0, -1),
      totalBytes: 3_000_000,
    });
  });

  it('cuts a preview of one long line at the inline limit on a character boundary', () => {
    const content = encoder.encode('é'.repeat(panelLimits.inlineBodyBytes));

    const body = panelBody(content, 'plaintext', content.length);

    expect(body.kind).toBe('preview');
    const text = body.kind === 'preview' ? body.text : '';
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(panelLimits.inlineBodyBytes);
    expect(Buffer.byteLength(text)).toBeGreaterThan(panelLimits.inlineBodyBytes - 4);
    expect(text).not.toContain('�');
  });
});

describe('eventText', () => {
  it('pretty-prints a JSON event with two spaces', () => {
    const value = { type: 'RUN_STARTED', nested: { list: [1, 'two', null, true], empty: {} } };

    expect(eventText(event(value), 10_000)).toEqual({
      text: JSON.stringify(value, null, 2),
      truncated: false,
    });
  });

  it('keeps large integers exact', () => {
    expect(eventText(event({ id: 12345678901234567890n }), 10_000).text).toBe(
      '{\n  "id": 12345678901234567890\n}',
    );
  });

  it('shows empty containers on one line', () => {
    expect(eventText(event({ a: [], b: {} }), 100).text).toBe('{\n  "a": [],\n  "b": {}\n}');
  });

  it('shows a text event as it was sent', () => {
    expect(eventText(event('line one\nline two', { kind: 'text' }), 100)).toEqual({
      text: 'line one\nline two',
      truncated: false,
    });
  });

  it('stops at the limit and says the text was cut', () => {
    const wide = event({ items: Array.from({ length: 100_000 }, (_, index) => ({ index })) });

    const shown = eventText(wide, 1000);

    expect(shown.truncated).toBe(true);
    expect(shown.text.length).toBeLessThanOrEqual(1000);
    expect(JSON.stringify(wide.value, null, 2).startsWith(shown.text)).toBe(true);
    expect(eventText(event('x'.repeat(50), { kind: 'text' }), 10)).toEqual({
      text: 'x'.repeat(10),
      truncated: true,
    });
  });
});

describe('compactEventJson', () => {
  it('writes an event value as compact JSON with large integers exact', () => {
    expect(compactEventJson({ id: 12345678901234567890n, list: [1, 'two', null] })).toBe(
      '{"id":12345678901234567890,"list":[1,"two",null]}',
    );
  });
});

describe('eventNote', () => {
  it('says nothing for an event shown in full', () => {
    expect(eventNote(event({ type: 'A' }), 3, false)).toBeUndefined();
  });

  it('says when an event document is cut off', () => {
    expect(eventNote(event({ type: 'A' }), 3, true)).toBe(
      'Event 3 is too large to show in full here; this is its beginning.',
    );
  });

  it('says when only the beginning of an oversize event was kept', () => {
    expect(eventNote(event('{"type":"BIG",', { kind: 'oversize' }), 9, false)).toBe(
      'Event 9 is larger than streamscope.stream.maxEventSize, so only its beginning was kept.',
    );
  });
});

describe('capTail', () => {
  it('keeps text within the limit whole', () => {
    expect(capTail('abc', 10)).toEqual({ text: 'abc', cut: false });
  });

  it('keeps the newest bytes without splitting a character', () => {
    const text = `${'é'.repeat(10)}end`;

    const kept = capTail(text, 8);

    expect(kept.cut).toBe(true);
    expect(text.endsWith(kept.text)).toBe(true);
    expect(Buffer.byteLength(kept.text)).toBeLessThanOrEqual(8);
    expect(kept.text).toBe('ééend');
  });
});
