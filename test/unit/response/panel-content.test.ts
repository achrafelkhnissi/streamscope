import { describe, expect, it } from 'vitest';
import type { JsonValue, StreamEvent } from '../../../src/events/model';
import { StreamSession } from '../../../src/events/session';
import {
  capTail,
  compactEventJson,
  detailNote,
  eventNote,
  eventText,
  panelBody,
  panelStatus,
  previewBody,
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
      released: false,
      rawGone: false,
      replyGone: false,
    });
  });

  it('counts a run waiting for a captured value as running', () => {
    const waiting = panelStatus(
      snapshot({
        status: 'waiting',
        waitingFor: 'startRun › threadId',
        head: undefined,
        sent: undefined,
      }),
    );

    expect(waiting.state).toBe('waiting');
    expect(waiting.running).toBe(true);
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
      released: false,
      rawGone: false,
      replyGone: false,
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

  it('says when the Raw tail or the Reply of a finished run can no longer be read', () => {
    expect(panelStatus(snapshot({ rawSource: 'spill', replySource: 'spill' }))).toMatchObject({
      rawGone: false,
      replyGone: false,
    });
    expect(panelStatus(snapshot({ rawSource: 'gone' }))).toMatchObject({
      rawGone: true,
      replyGone: false,
    });
    expect(panelStatus(snapshot({ replySource: 'gone' }))).toMatchObject({
      rawGone: false,
      replyGone: true,
    });
  });

  it('says when the run has left history', () => {
    expect(panelStatus(snapshot()).released).toBe(false);
    expect(panelStatus(snapshot({ released: true })).released).toBe(true);
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

describe('panelBody of the beginning of a body', () => {
  it('shows a preview even when what was read is within the inline limit', () => {
    const content = encoder.encode('{\n  "items": [\n    1,\n    2');

    expect(panelBody(content, 'json', 4_000_000, true)).toEqual({
      kind: 'preview',
      language: 'json',
      text: '{\n  "items": [\n    1,\n    2',
      totalBytes: 4_000_000,
    });
  });

  it('keeps showing a body that is whole in full', () => {
    expect(panelBody(encoder.encode('{}'), 'json', 2, false)).toEqual({
      kind: 'text',
      language: 'json',
      text: '{}',
    });
  });
});

describe('previewBody', () => {
  it('formats a body that was read whole like the live body', () => {
    const bytes = encoder.encode('{"a":[1,2]}');

    expect(previewBody(bytes, 'application/json', bytes.length)).toEqual({
      kind: 'text',
      language: 'json',
      text: '{\n  "a": [\n    1,\n    2\n  ]\n}',
    });
  });

  it('previews the beginning of a longer body with the size of the whole', () => {
    const beginning = encoder.encode('{"items":[{"id":1},{"id":2},{"i');

    expect(previewBody(beginning, 'application/json', 9_000_000)).toEqual({
      kind: 'preview',
      language: 'json',
      text: '{\n  "items": [\n    {\n      "id": 1\n    },\n    {\n      "id": 2\n    },\n    {\n      "i',
      totalBytes: 9_000_000,
    });
  });

  it('says a binary body is binary with its whole size', () => {
    const beginning = new Uint8Array(100);

    expect(previewBody(beginning, 'image/png', 3_145_728)).toEqual({
      kind: 'text',
      language: 'plaintext',
      text: 'Binary body (3.0 MB). Use Save Response to keep it.',
    });
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

describe('detailNote', () => {
  it('gives the parse error of a malformed event', () => {
    expect(
      detailNote(
        event('{"type":', { kind: 'malformed', error: 'Unexpected end of JSON input' }),
        4,
      ),
    ).toBe('Event 4 is not valid JSON: Unexpected end of JSON input');
  });

  it('says that only the beginning of an oversize event was kept, as its document does', () => {
    const oversize = event('{"type":"BIG",', { kind: 'oversize' });

    expect(detailNote(oversize, 9)).toBe(eventNote(oversize, 9, false));
  });

  it('says nothing for any other event', () => {
    expect(detailNote(event({ type: 'A' }), 3)).toBeUndefined();
    expect(detailNote(event('plain', { kind: 'text' }), 3)).toBeUndefined();
    expect(detailNote(event('note', { kind: 'comment' }), 3)).toBeUndefined();
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
