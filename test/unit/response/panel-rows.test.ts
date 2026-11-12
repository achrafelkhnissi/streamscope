import { describe, expect, it } from 'vitest';
import type { JsonValue, StreamEvent } from '../../../src/events/model';
import { EventStore } from '../../../src/events/store';
import type { PanelRow } from '../../../src/response/panel-protocol';
import { capRows, capText, displayText, panelRow } from '../../../src/response/panel-rows';
import { maxIndexedEvents } from '../../../src/streaming/limits';

const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

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

function storeOf(...events: StreamEvent[]): EventStore {
  const store = new EventStore({
    memoryEvents: 10,
    memoryBytes: 1024,
    maxIndexedEvents,
    spill: undefined,
    reparse: () => undefined,
  });
  for (const item of events) {
    store.append(item);
  }
  return store;
}

function previewOf(value: JsonValue, overrides: Partial<StreamEvent> = {}): string {
  const item = event(1, { value, ...overrides });
  return panelRow(storeOf(item), 1, item).preview;
}

function row(index: number, preview = ''): PanelRow {
  return { index, time: '00:00.000', label: 'label', preview, kind: 'json' };
}

describe('displayText', () => {
  it('removes control and bidi characters from labels and previews', () => {
    expect(displayText('A\u202eevil\u0000\u001b[31m', 100)).toBe('Aevil[31m');
  });

  it('removes C0 and C1 controls except tab', () => {
    expect(displayText('a\tb', 100)).toBe('a\tb');
    expect(displayText('a\u0000b\u001bc\u007fd', 100)).toBe('abcd');
    expect(displayText('a\u0080b\u009bc\u009fd', 100)).toBe('abcd');
  });

  it('removes every bidirectional control', () => {
    const hidden = [
      '\u061c',
      '\u200e',
      '\u200f',
      '\u202a',
      '\u202b',
      '\u202c',
      '\u202d',
      '\u202e',
      '\u2066',
      '\u2067',
      '\u2068',
      '\u2069',
    ];
    for (const character of hidden) {
      expect(displayText(`a${character}b`, 100)).toBe('ab');
    }
  });

  it('turns line breaks into a single space', () => {
    expect(displayText('line one\nline two', 100)).toBe('line one line two');
    for (const lineBreak of ['\n', '\r', '\r\n', '\u0085', '\u2028', '\u2029']) {
      expect(displayText(`a${lineBreak}b`, 100)).toBe('a b');
    }
  });

  it('turns a run of line breaks into one space', () => {
    expect(displayText('a\n\n\r\n\u2028b', 100)).toBe('a b');
    expect(displayText('a\nb\nc', 100)).toBe('a b c');
    expect(displayText('a\n\u0000\nb', 100)).toBe('a  b');
    expect(displayText('\na\n', 100)).toBe(' a ');
  });

  it('counts the space for a line break toward the maximum length', () => {
    expect(displayText('ab\ncd', 4)).toBe('ab c');
    expect(displayText('ab\ncd', 3)).toBe('ab ');
    expect(displayText('ab\r\ncd', 2)).toBe('ab');
  });

  it('keeps the characters around the removed ranges', () => {
    expect(displayText('\u00a0 \u2027\u202f\u2065\u206a\u200d\ufffd', 100)).toBe(
      '\u00a0 \u2027\u202f\u2065\u206a\u200d\ufffd',
    );
  });

  it('keeps emoji sequences and accents', () => {
    const text = '👨\u200d👩\u200d👧 café ✓';

    expect(displayText(text, 100)).toBe(text);
  });

  it('cuts to the maximum length without splitting a surrogate pair', () => {
    const cut = displayText('😀'.repeat(60), 100);

    expect(cut).toBe('😀'.repeat(50));
    expect(loneSurrogate.test(cut)).toBe(false);
    const odd = displayText('😀'.repeat(60), 99);
    expect(odd).toBe('😀'.repeat(49));
    expect(loneSurrogate.test(odd)).toBe(false);
  });

  it('counts only the characters it keeps', () => {
    expect(displayText('\u0000'.repeat(50) + 'abcdef', 3)).toBe('abc');
    expect(displayText('ab', 0)).toBe('');
  });

  it('returns text that fits unchanged', () => {
    expect(displayText('short', 100)).toBe('short');
    expect(displayText('', 100)).toBe('');
  });

  it('looks at no more than eight times the maximum length of the input, and at least 256 characters', () => {
    const bound = 200 * 8;
    const bidi = String.fromCharCode(0x202e);

    expect(displayText('\u0000'.repeat(bound) + 'abc', 200)).toBe('');
    expect(displayText('\u0000'.repeat(bound + 1) + 'abc', 200)).toBe('');
    expect(displayText('\u0000'.repeat(bound - 1) + 'abc', 200)).toBe('a');
    expect(displayText(bidi.repeat(bound) + 'abc', 200)).toBe('');
    expect(displayText(bidi.repeat(bound - 2) + 'abc', 200)).toBe('ab');
    expect(displayText('x'.repeat(bound) + 'abc', 200)).toBe('x'.repeat(200));
    expect(displayText('\u0000'.repeat(256) + 'abc', 3)).toBe('');
    expect(displayText('\u0000'.repeat(255) + 'abc', 3)).toBe('a');
    expect(displayText('\u0000'.repeat(50) + 'abc', 3)).toBe('abc');
    expect(displayText('abc', 0)).toBe('');
  });

  it('looks at no more than that of a run of line breaks', () => {
    const bound = 200 * 8;

    expect(displayText('\n'.repeat(bound + 1) + 'abc', 200)).toBe(' ');
    expect(displayText('\r\n'.repeat(bound) + 'abc', 200)).toBe(' ');
    expect(displayText('\n'.repeat(bound - 1) + 'abc', 200)).toBe(' a');
    expect(displayText('a\n'.repeat(bound), 200)).toBe('a '.repeat(100));
  });

  it('never splits a surrogate pair at the bound', () => {
    const bound = 200 * 8;

    expect(displayText('\u0000'.repeat(bound - 2) + '😀', 200)).toBe('😀');
    expect(displayText('\u0000'.repeat(bound - 1) + '😀', 200)).toBe('');
    expect(displayText('\u0000'.repeat(bound) + '😀', 200)).toBe('');
  });
});

describe('panelRow', () => {
  it('summarises an event with its index, kind, label and compact JSON', () => {
    const first = event(1, { value: { type: 'RUN_STARTED', n: 1, ok: [true, null] } });

    expect(panelRow(storeOf(first), 1, first)).toEqual({
      index: 1,
      time: '00:00.010',
      label: 't-1',
      preview: '{"type":"RUN_STARTED","n":1,"ok":[true,null]}',
      kind: 'json',
    });
  });

  it('shows the time since the request as minutes, seconds and milliseconds', () => {
    const store = storeOf(
      event(1, { time: 250 }),
      event(2, { time: 61_234 }),
      event(3, { time: 3_600_007 }),
    );

    expect(panelRow(store, 1, undefined).time).toBe('00:00.250');
    expect(panelRow(store, 2, undefined).time).toBe('01:01.234');
    expect(panelRow(store, 3, undefined).time).toBe('60:00.007');
  });

  it('rounds fractional milliseconds', () => {
    const store = storeOf(
      event(1, { time: 1234.6 }),
      event(2, { time: 2345.4 }),
      event(3, { time: 3000 }),
    );

    expect(panelRow(store, 1, undefined).time).toBe('00:01.235');
    expect(panelRow(store, 2, undefined).time).toBe('00:02.345');
    expect(panelRow(store, 3, undefined).time).toBe('00:03.000');
  });

  it('takes the time, label and kind from the store summary when the event is not in memory', () => {
    const store = storeOf(
      event(1, { time: 100 }),
      event(2, { time: 2500, kind: 'text', label: 'hello', value: 'hi' }),
    );

    expect(panelRow(store, 2, undefined)).toEqual({
      index: 2,
      time: '00:02.500',
      label: 'hello',
      preview: '',
      kind: 'text',
    });
  });

  it('uses an empty label when the event has none', () => {
    const item = event(1, { label: undefined, value: 'plain', kind: 'text' });

    expect(panelRow(storeOf(item), 1, item).label).toBe('');
  });

  it('strips control and bidi characters from the label', () => {
    const item = event(1, { label: 'a\u202eb\u001bc' });

    expect(panelRow(storeOf(item), 1, item).label).toBe('abc');
  });

  it('describes an index the store no longer knows without throwing', () => {
    const store = storeOf(event(1));

    expect(panelRow(store, 9, undefined)).toEqual({
      index: 9,
      time: '',
      label: '',
      preview: '',
      kind: 'text',
    });
  });

  it('serialises bigint values as their digits', () => {
    expect(previewOf({ id: 12345678901234567890n, list: [-9007199254740993n] })).toBe(
      '{"id":12345678901234567890,"list":[-9007199254740993]}',
    );
    expect(previewOf(12345678901234567890n)).toBe('12345678901234567890');
  });

  it('matches JSON.stringify for every JSON type', () => {
    const value: JsonValue = {
      a: null,
      b: [true, false, 1.5, -0, 1e21, 'q"uote\\ \n'],
      c: { nested: { empty: {}, list: [] } },
      '': 'empty key',
    };

    expect(previewOf(value)).toBe(JSON.stringify(value));
    expect(previewOf('text')).toBe('"text"');
    expect(previewOf(null)).toBe('null');
    expect(previewOf(7)).toBe('7');
  });

  it('shows text events as they are, without quotes', () => {
    expect(previewOf('hello world', { kind: 'text' })).toBe('hello world');
    expect(previewOf('{"broken', { kind: 'malformed' })).toBe('{"broken');
    expect(previewOf(': keep-alive', { kind: 'comment' })).toBe(': keep-alive');
    expect(previewOf('big…', { kind: 'oversize' })).toBe('big…');
  });

  it('shows the lines of a multi-line text event separated by a space', () => {
    expect(previewOf('line one\nline two\r\nline three', { kind: 'text' })).toBe(
      'line one line two line three',
    );
    expect(previewOf('data\u2028more', { kind: 'comment' })).toBe('data more');
  });

  it('leaves the preview of a hostile event empty without reading all of it', () => {
    const nulls = '\u0000'.repeat(1_000_000);

    expect(previewOf(nulls + 'abc', { kind: 'text' })).toBe('');
    expect(previewOf('\n'.repeat(1_000_000) + 'abc', { kind: 'malformed' })).toBe(' ');
    expect(previewOf(nulls + 'abc', { kind: 'comment' })).toBe('');
  });

  it('strips control and bidi characters from the preview', () => {
    expect(previewOf('a\u001b[31mb\u202ec', { kind: 'text' })).toBe('a[31mbc');
    expect(previewOf({ text: 'a\u202eb' })).toBe('{"text":"ab"}');
  });

  it('cuts the preview to 200 characters without splitting a surrogate pair', () => {
    const json = previewOf({ text: '😀'.repeat(300) });
    const text = previewOf('😀'.repeat(300), { kind: 'text' });

    expect(json.length).toBeLessThanOrEqual(200);
    expect(json.length).toBeGreaterThanOrEqual(199);
    expect(json.startsWith('{"text":"😀')).toBe(true);
    expect(loneSurrogate.test(json)).toBe(false);
    expect(text).toBe('😀'.repeat(100));
    expect(previewOf('x'.repeat(500), { kind: 'text' })).toBe('x'.repeat(200));
    expect(previewOf({ a: 'x'.repeat(500) })).toBe(`{"a":"${'x'.repeat(194)}`);
  });

  it('keeps the preview of an event of any size to its first 200 characters', () => {
    const big = { type: 'big', data: 'y'.repeat(5_000_000), more: [1, 2, 3] };

    expect(previewOf(big)).toBe(JSON.stringify(big).slice(0, 200));
  });

  it('reads only the start of a large array', () => {
    let reads = 0;
    const list = new Proxy(new Array<number>(1_000_000).fill(1), {
      get(target, property, receiver) {
        reads += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const preview = previewOf(list);

    expect(preview).toBe(JSON.stringify(new Array<number>(300).fill(1)).slice(0, 200));
    expect(reads).toBeLessThan(500);
  });

  it('reads only the start of a large object', () => {
    let reads = 0;
    const fields = Object.fromEntries(
      Array.from({ length: 50_000 }, (_, index) => [`key${String(index)}`, index]),
    );
    const object = new Proxy(fields, {
      get(target, property, receiver) {
        reads += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const preview = previewOf(object);

    expect(preview.startsWith('{"key0":0,"key1":1,')).toBe(true);
    expect(preview).toHaveLength(200);
    expect(reads).toBeLessThan(500);
  });

  it('does not recurse deeper than the preview is long', () => {
    let deep: JsonValue = 1;
    for (let level = 0; level < 100_000; level += 1) {
      deep = [deep];
    }

    expect(previewOf(deep)).toBe('['.repeat(200));
  });

  it('keeps an own __proto__ key from a parsed event', () => {
    const value = JSON.parse('{"__proto__":{"a":1},"b":2}') as JsonValue;

    expect(previewOf(value)).toBe('{"__proto__":{"a":1},"b":2}');
  });
});

describe('capRows', () => {
  it('returns every row when they fit', () => {
    const rows = [row(1), row(2), row(3)];

    expect(capRows(rows, 1_000_000)).toEqual(rows);
  });

  it('keeps the newest rows that fit in the byte cap', () => {
    const rows = [1, 2, 3, 4, 5].map((index) => row(index, 'x'.repeat(100)));
    const cap = Buffer.byteLength(JSON.stringify(rows.slice(-2)));

    expect(capRows(rows, cap).map((kept) => kept.index)).toEqual([4, 5]);
    expect(capRows(rows, cap - 1).map((kept) => kept.index)).toEqual([5]);
    expect(capRows(rows, cap + 200).map((kept) => kept.index)).toEqual([3, 4, 5]);
  });

  it('measures the JSON encoding in UTF-8 bytes', () => {
    const rows = [row(1, 'é'.repeat(100)), row(2, 'é'.repeat(100))];
    const both = Buffer.byteLength(JSON.stringify(rows));

    expect(capRows(rows, both)).toHaveLength(2);
    expect(capRows(rows, both - 1)).toHaveLength(1);
    expect(both).toBeGreaterThan(JSON.stringify(rows).length);
  });

  it('keeps nothing when not even the newest row fits', () => {
    expect(capRows([row(1, 'x'.repeat(100))], 50)).toEqual([]);
    expect(capRows([], 50)).toEqual([]);
  });

  it('keeps the rows in their original order and leaves the input alone', () => {
    const rows = [row(1), row(2), row(3)];

    const kept = capRows(rows, 1_000_000);

    expect(kept.map((item) => item.index)).toEqual([1, 2, 3]);
    expect(kept).not.toBe(rows);
    expect(rows).toHaveLength(3);
  });

  it('keeps as many of the newest rows as fit', () => {
    const rows = Array.from({ length: 100_000 }, (_, index) => row(index + 1));
    const kept = capRows(rows, 4096);

    expect(kept.at(-1)?.index).toBe(100_000);
    expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(4096);
    expect(
      Buffer.byteLength(JSON.stringify([row(100_000 - kept.length), ...kept])),
    ).toBeGreaterThan(4096);
  });
});

describe('capText', () => {
  it('returns text that fits unchanged', () => {
    expect(capText('hello', 5)).toEqual({ text: 'hello', cut: false });
    expect(capText('hello', 100)).toEqual({ text: 'hello', cut: false });
    expect(capText('', 0)).toEqual({ text: '', cut: false });
  });

  it('cuts ASCII text at the byte cap', () => {
    expect(capText('abcdef', 4)).toEqual({ text: 'abcd', cut: true });
    expect(capText('abcdef', 0)).toEqual({ text: '', cut: true });
  });

  it('cuts on a character boundary', () => {
    expect(capText('ééééé', 5)).toEqual({ text: 'éé', cut: true });
    expect(capText('ééééé', 6)).toEqual({ text: 'ééé', cut: true });
    expect(capText('€€€', 7)).toEqual({ text: '€€', cut: true });
  });

  it('never splits a surrogate pair', () => {
    for (let cap = 0; cap <= 9; cap += 1) {
      const { text, cut } = capText('😀😀', cap);

      expect(loneSurrogate.test(text)).toBe(false);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(cap);
      expect(Buffer.byteLength(text)).toBeGreaterThan(cap - 4);
      expect(cut).toBe(cap < 8);
    }
    expect(capText('a😀', 4)).toEqual({ text: 'a', cut: true });
  });

  it('measures bytes, not characters', () => {
    const text = '日本語'.repeat(100);

    expect(capText(text, 900)).toEqual({ text, cut: false });
    expect(capText(text, 899)).toEqual({ text: '日本語'.repeat(99) + '日本', cut: true });
  });

  it('cuts a large text to at most the cap', () => {
    const text = 'é'.repeat(3_000_000);

    const { text: kept, cut } = capText(text, 2_097_152);

    expect(cut).toBe(true);
    expect(Buffer.byteLength(kept)).toBe(2_097_152);
  });
});
