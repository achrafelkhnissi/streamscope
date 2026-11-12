import { describe, expect, it } from 'vitest';
import { streamFixtures } from '../../support/stream-fixtures';
import type { StreamEvent } from '../../../src/events/model';
import type { FormatDecision } from '../../../src/streaming/detect';
import { defaultStreamLimits, sniffBytes } from '../../../src/streaming/limits';
import {
  StreamParser,
  parseEventBytes,
  type StreamParserOptions,
  type StreamSink,
  type StreamWarning,
} from '../../../src/streaming/parser';

type Call =
  | { type: 'format'; decision: FormatDecision }
  | { type: 'event'; event: StreamEvent }
  | { type: 'text'; text: string }
  | { type: 'warning'; warning: StreamWarning };

interface Harness {
  parser: StreamParser;
  calls: Call[];
}

const mebibyte = 1024 * 1024;
const byteOrderMark = [0xef, 0xbb, 0xbf];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const baseOptions: StreamParserOptions = {
  contentType: undefined,
  directive: undefined,
  maxEventSize: defaultStreamLimits.maxEventSize,
  typeFields: defaultStreamLimits.typeFields,
  now: () => 0,
};

function encode(text: string): Uint8Array {
  return encoder.encode(text);
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  return Uint8Array.from(parts.flatMap((part) => Array.from(part)));
}

function fixtureBytes(name: string): Uint8Array {
  const fixture = streamFixtures.find((candidate) => candidate.name === name);
  if (fixture === undefined) {
    throw new Error(`Missing fixture ${name}`);
  }
  return fixture.bytes;
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`Nothing at index ${String(index)}`);
  }
  return item;
}

function harness(overrides: Partial<StreamParserOptions> = {}): Harness {
  const calls: Call[] = [];
  const sink: StreamSink = {
    format(decision) {
      calls.push({ type: 'format', decision });
    },
    event(event) {
      calls.push({ type: 'event', event });
    },
    text(text) {
      calls.push({ type: 'text', text });
    },
    warning(warning) {
      calls.push({ type: 'warning', warning });
    },
  };
  return { parser: new StreamParser({ ...baseOptions, ...overrides }, sink), calls };
}

function parseChunks(
  chunks: readonly (string | Uint8Array)[],
  overrides: Partial<StreamParserOptions> = {},
): Call[] {
  const { parser, calls } = harness(overrides);
  for (const chunk of chunks) {
    parser.push(typeof chunk === 'string' ? encode(chunk) : chunk);
  }
  parser.end();
  return calls;
}

function parse(input: string | Uint8Array, overrides: Partial<StreamParserOptions> = {}): Call[] {
  return parseChunks([input], overrides);
}

function byteByByte(bytes: Uint8Array): Uint8Array[] {
  return Array.from(bytes, (byte) => Uint8Array.of(byte));
}

function formatsOf(calls: readonly Call[]): FormatDecision[] {
  return calls.flatMap((call) => (call.type === 'format' ? [call.decision] : []));
}

function eventsOf(calls: readonly Call[]): StreamEvent[] {
  return calls.flatMap((call) => (call.type === 'event' ? [call.event] : []));
}

function warningsOf(calls: readonly Call[]): StreamWarning[] {
  return calls.flatMap((call) => (call.type === 'warning' ? [call.warning] : []));
}

function textOf(calls: readonly Call[]): string {
  return calls.map((call) => (call.type === 'text' ? call.text : '')).join('');
}

function typesOf(calls: readonly Call[]): Call['type'][] {
  return calls.map((call) => call.type);
}

function summary(event: StreamEvent): [number, string, string | undefined] {
  return [event.index, event.kind, event.label];
}

describe('StreamParser decisions', () => {
  it('follows the directive over the content type', () => {
    const calls = parse('{"type":"A"}\ndata: {"type":"B"}\n', {
      directive: 'ndjson',
      contentType: 'text/event-stream',
    });

    expect(formatsOf(calls)).toEqual([
      { format: 'ndjson', reason: 'directive', contentType: 'text/event-stream' },
    ]);
    expect(at(calls, 0).type).toBe('format');
    expect(eventsOf(calls).map(summary)).toEqual([
      [1, 'json', 'A'],
      [2, 'malformed', undefined],
    ]);
    expect(textOf(calls)).toBe('');
  });

  it('follows an sse directive over an ndjson content type', () => {
    const calls = parse('data: {"type":"A"}\n\n', {
      directive: 'sse',
      contentType: 'application/x-ndjson',
    });

    expect(formatsOf(calls)).toEqual([
      { format: 'sse', reason: 'directive', contentType: 'application/x-ndjson' },
    ]);
    expect(eventsOf(calls).map(summary)).toEqual([[1, 'json', 'A']]);
  });

  it('treats the auto directive like no directive', () => {
    const known = parse('x\n', { directive: 'auto', contentType: 'text/event-stream' });
    expect(formatsOf(known)).toEqual([
      { format: 'sse', reason: 'content-type', contentType: 'text/event-stream' },
    ]);

    const sniffed = parse('data: {"type":"A"}\n\n', { directive: 'auto' });
    expect(formatsOf(sniffed)).toEqual([
      { format: 'sse', reason: 'detected', contentType: undefined },
    ]);
  });

  it('decides without bytes for a directive or a known content type', () => {
    const cases: readonly {
      overrides: Partial<StreamParserOptions>;
      expected: FormatDecision;
    }[] = [
      {
        overrides: { directive: 'sse' },
        expected: { format: 'sse', reason: 'directive', contentType: undefined },
      },
      {
        overrides: { directive: 'ndjson', contentType: 'text/event-stream' },
        expected: { format: 'ndjson', reason: 'directive', contentType: 'text/event-stream' },
      },
      {
        overrides: { directive: 'json' },
        expected: { format: 'json', reason: 'directive', contentType: undefined },
      },
      {
        overrides: { directive: 'text' },
        expected: { format: 'text', reason: 'directive', contentType: undefined },
      },
      {
        overrides: { directive: 'raw', contentType: 'application/json' },
        expected: { format: 'raw', reason: 'directive', contentType: 'application/json' },
      },
      {
        overrides: { directive: 'auto', contentType: 'text/event-stream' },
        expected: { format: 'sse', reason: 'content-type', contentType: 'text/event-stream' },
      },
      {
        overrides: { contentType: 'text/event-stream' },
        expected: { format: 'sse', reason: 'content-type', contentType: 'text/event-stream' },
      },
      {
        overrides: { contentType: 'Application/X-NDJSON; charset=utf-8' },
        expected: {
          format: 'ndjson',
          reason: 'content-type',
          contentType: 'application/x-ndjson',
        },
      },
      {
        overrides: { contentType: 'text/html' },
        expected: { format: 'text', reason: 'content-type', contentType: 'text/html' },
      },
    ];
    for (const { overrides, expected } of cases) {
      const { parser, calls } = harness(overrides);
      expect(calls, JSON.stringify(overrides)).toEqual([]);
      parser.end();
      expect(calls, JSON.stringify(overrides)).toEqual([{ type: 'format', decision: expected }]);
    }
  });

  it('emits the decision before any event or text', () => {
    const cases: readonly Partial<StreamParserOptions>[] = [
      { directive: 'ndjson' },
      { directive: 'sse' },
      { directive: 'json' },
      { directive: 'text' },
      { directive: 'raw' },
      { contentType: 'application/x-ndjson' },
      { contentType: 'text/event-stream' },
      { contentType: 'text/html' },
    ];
    for (const overrides of cases) {
      const calls = parse('{"type":"A"}\n', overrides);
      expect(at(calls, 0).type, JSON.stringify(overrides)).toBe('format');
      expect(formatsOf(calls), JSON.stringify(overrides)).toHaveLength(1);
    }
  });

  it('reports the lowercased media type without parameters as the content type', () => {
    const known = parse('x', { contentType: 'Text/HTML; charset=utf-8' });
    expect(formatsOf(known)).toEqual([
      { format: 'text', reason: 'content-type', contentType: 'text/html' },
    ]);

    const sniffed = parse('{"type":"A"}\n', { contentType: 'Application/JSON; charset=utf-8' });
    expect(formatsOf(sniffed)).toEqual([
      { format: 'json', reason: 'detected', contentType: 'application/json' },
    ]);
  });

  it('treats an empty content type as absent', () => {
    const calls = parse('hello\n', { contentType: '' });

    expect(formatsOf(calls)).toEqual([
      { format: 'text', reason: 'detected', contentType: undefined },
    ]);
  });
});

describe('StreamParser sniffing', () => {
  it('sniffs SSE after leading blank lines and comments', () => {
    const calls = parse('\r\n\n: keep-alive\n\ndata: {"type":"A"}\n\n', {
      contentType: 'text/plain',
    });

    expect(formatsOf(calls)).toEqual([
      { format: 'sse', reason: 'detected', contentType: 'text/plain' },
    ]);
    expect(textOf(calls)).toBe('');
    const events = eventsOf(calls);
    expect(events).toHaveLength(2);
    expect(at(events, 0)).toMatchObject({
      index: 1,
      kind: 'comment',
      value: 'keep-alive',
      label: undefined,
      offset: encode('\r\n\n').length,
      length: encode(': keep-alive\n').length,
      line: 3,
    });
    expect(at(events, 1)).toMatchObject({
      index: 2,
      kind: 'json',
      value: { type: 'A' },
      label: 'A',
      offset: encode('\r\n\n: keep-alive\n\n').length,
      length: encode('data: {"type":"A"}\n\n').length,
      line: 5,
    });
  });

  it('replays blank lines kept while sniffing to the SSE interpreter', () => {
    const calls = parse('\n\n\ndata: {"type":"A"}\n\n');

    expect(eventsOf(calls)).toMatchObject([
      { index: 1, kind: 'json', offset: 3, line: 4, label: 'A' },
    ]);
  });

  it('recognises every SSE field prefix on the untrimmed line', () => {
    const lines = [
      'data: {"a":1}',
      'data:{"a":1}',
      'data:',
      'event: ping',
      'id: 7',
      'retry: 100',
      ': note',
      ':note',
      ':',
    ];
    for (const line of lines) {
      const calls = parse(`${line}\n\n`);
      expect(formatsOf(calls), line).toEqual([
        { format: 'sse', reason: 'detected', contentType: undefined },
      ]);
      expect(textOf(calls), line).toBe('');
    }
  });

  it('does not treat an indented or mistyped SSE prefix as SSE', () => {
    const lines = [
      '  data: {"a":1}',
      '\tdata: x',
      ' : note',
      'data {"a":1}',
      'datum: 1',
      'Data: 1',
    ];
    for (const line of lines) {
      const input = `${line}\n\n`;
      const calls = parse(input);
      expect(formatsOf(calls), line).toEqual([
        { format: 'text', reason: 'detected', contentType: undefined },
      ]);
      expect(eventsOf(calls), line).toEqual([]);
      expect(textOf(calls), line).toBe(input);
    }
  });

  it('skips empty and whitespace-only lines before the first meaningful line', () => {
    const input = '  \n\t\n{"a":1}\n';
    const calls = parse(input, { contentType: 'application/json' });

    expect(formatsOf(calls)).toEqual([
      { format: 'json', reason: 'detected', contentType: 'application/json' },
    ]);
    expect(textOf(calls)).toBe(input);
    expect(eventsOf(calls)).toEqual([]);
  });

  it('sniffs JSON from the trimmed start of the first meaningful line', () => {
    for (const input of [' \t{"a":1}\n', '  [1,2]  \n']) {
      const calls = parse(input);
      expect(formatsOf(calls), input).toEqual([
        { format: 'json', reason: 'detected', contentType: undefined },
      ]);
      expect(textOf(calls), input).toBe(input);
    }
  });

  it('waits for a complete first line before deciding', () => {
    const json = harness({ contentType: 'application/json' });
    json.parser.push(encode('{"type":"A"'));
    expect(json.calls).toEqual([]);
    json.parser.push(encode('}'));
    expect(json.calls).toEqual([]);
    json.parser.push(encode('\n'));
    expect(json.calls).toEqual([
      {
        type: 'format',
        decision: { format: 'json', reason: 'detected', contentType: 'application/json' },
      },
      { type: 'text', text: '{"type":"A"}\n' },
    ]);

    const sse = harness();
    sse.parser.push(encode('da'));
    sse.parser.push(encode('ta: {"type":"A"}'));
    expect(sse.calls).toEqual([]);
    sse.parser.push(encode('\n\n'));
    expect(typesOf(sse.calls)).toEqual(['format', 'event']);
  });

  it('treats text/plain digits as text', () => {
    const input = '12345\n67890\n';
    const calls = parse(input, { contentType: 'text/plain' });

    expect(formatsOf(calls)).toEqual([
      { format: 'text', reason: 'detected', contentType: 'text/plain' },
    ]);
    expect(eventsOf(calls)).toEqual([]);
    expect(warningsOf(calls)).toEqual([]);
    expect(textOf(calls)).toBe(input);
  });

  it('treats a bare JSON scalar or plain words as text', () => {
    for (const input of ['123\n', 'true\n', '"quoted"\n', 'hello world\n', 'hello']) {
      const calls = parse(input, { contentType: 'application/json' });
      expect(formatsOf(calls), input).toEqual([
        { format: 'text', reason: 'detected', contentType: 'application/json' },
      ]);
      expect(eventsOf(calls), input).toEqual([]);
      expect(textOf(calls), input).toBe(input);
    }
  });

  it('decides text for an empty body at the end', () => {
    const none = harness();
    expect(none.calls).toEqual([]);
    none.parser.end();
    expect(none.calls).toEqual([
      { type: 'format', decision: { format: 'text', reason: 'detected', contentType: undefined } },
    ]);

    const emptyChunk = harness({ contentType: 'application/json' });
    emptyChunk.parser.push(new Uint8Array(0));
    emptyChunk.parser.end();
    expect(emptyChunk.calls).toEqual([
      {
        type: 'format',
        decision: { format: 'text', reason: 'detected', contentType: 'application/json' },
      },
    ]);
  });

  it('decides text for a body of only blank lines', () => {
    const input = '\n  \r\n\t\n';
    const calls = parse(input);

    expect(formatsOf(calls)).toEqual([
      { format: 'text', reason: 'detected', contentType: undefined },
    ]);
    expect(textOf(calls)).toBe(input);
    expect(eventsOf(calls)).toEqual([]);
  });

  it('decides on the first meaningful line at the end when it has no terminator', () => {
    const calls = parse('hello');

    expect(formatsOf(calls)).toEqual([
      { format: 'text', reason: 'detected', contentType: undefined },
    ]);
    expect(textOf(calls)).toBe('hello');
  });

  it('sniffs through a CR and LF split across chunks', () => {
    const json = harness({ contentType: 'application/json' });
    json.parser.push(encode('{"type":"A"}\r'));
    expect(json.calls).toEqual([]);
    json.parser.push(encode('\n'));
    expect(json.calls).toEqual([
      {
        type: 'format',
        decision: { format: 'json', reason: 'detected', contentType: 'application/json' },
      },
      { type: 'text', text: '{"type":"A"}\r\n' },
    ]);
    json.parser.push(encode('{"type":"B"}\r'));
    expect(json.calls).toHaveLength(2);
    json.parser.push(encode('\n'));
    expect(typesOf(json.calls.slice(2))).toEqual(['format', 'event', 'event']);
    expect(eventsOf(json.calls)).toMatchObject([
      { index: 1, label: 'A', offset: 0, length: 14, line: 1 },
      { index: 2, label: 'B', offset: 14, length: 14, line: 2 },
    ]);

    const sse = harness();
    sse.parser.push(encode('data: {"type":"A"}\r'));
    expect(sse.calls).toEqual([]);
    sse.parser.push(encode('\n\r'));
    expect(typesOf(sse.calls)).toEqual(['format']);
    sse.parser.push(encode('\n'));
    expect(typesOf(sse.calls)).toEqual(['format', 'event']);
    expect(eventsOf(sse.calls)).toMatchObject([{ offset: 0, length: 22, label: 'A' }]);
  });

  it('sniffs through a byte-order mark split across chunks', () => {
    const { parser, calls } = harness();
    parser.push(Uint8Array.of(0xef));
    parser.push(Uint8Array.of(0xbb));
    expect(calls).toEqual([]);
    parser.push(Uint8Array.of(0xbf));
    expect(calls).toEqual([]);
    parser.push(encode(': keep-alive\n\ndata: {"type":"A"}\n\n'));
    parser.end();

    expect(formatsOf(calls)).toEqual([
      { format: 'sse', reason: 'detected', contentType: undefined },
    ]);
    expect(eventsOf(calls)).toMatchObject([
      { kind: 'comment', offset: 3 },
      { kind: 'json', label: 'A', offset: 3 + encode(': keep-alive\n\n').length },
    ]);
  });
});

describe('StreamParser upgrade from single JSON', () => {
  it('upgrades single JSON to NDJSON when a second line arrives later', () => {
    const { parser, calls } = harness({ contentType: 'application/json' });

    parser.push(encode('{"type":"A"}\n'));
    expect(calls).toEqual([
      {
        type: 'format',
        decision: { format: 'json', reason: 'detected', contentType: 'application/json' },
      },
      { type: 'text', text: '{"type":"A"}\n' },
    ]);

    parser.push(encode('{"type":"B"}\n'));
    expect(typesOf(calls.slice(2))).toEqual(['format', 'event', 'event']);
    expect(formatsOf(calls)).toEqual([
      { format: 'json', reason: 'detected', contentType: 'application/json' },
      { format: 'ndjson', reason: 'detected', contentType: 'application/json' },
    ]);
    expect(eventsOf(calls)).toMatchObject([
      {
        index: 1,
        kind: 'json',
        value: { type: 'A' },
        label: 'A',
        offset: 0,
        length: 13,
        line: 1,
        unterminated: false,
      },
      {
        index: 2,
        kind: 'json',
        value: { type: 'B' },
        label: 'B',
        offset: 13,
        length: 13,
        line: 2,
        unterminated: false,
      },
    ]);
  });

  it('parses later lines as NDJSON as they arrive after an upgrade', () => {
    const { parser, calls } = harness({ contentType: 'application/json' });
    parser.push(encode('{"type":"A"}\n{"type":"B"}\n'));
    const before = calls.length;

    parser.push(encode('{"type":"C"}'));
    expect(calls).toHaveLength(before);
    parser.push(encode('\n'));
    expect(calls).toHaveLength(before + 1);
    parser.end();

    expect(eventsOf(calls).map(summary)).toEqual([
      [1, 'json', 'A'],
      [2, 'json', 'B'],
      [3, 'json', 'C'],
    ]);
    expect(formatsOf(calls)).toHaveLength(2);
    expect(textOf(calls.slice(before))).toBe('');
  });

  it('keeps a lone JSON line as single JSON at end', () => {
    const calls = parse('{"type":"A"}\n', { contentType: 'application/json' });

    expect(calls).toEqual([
      {
        type: 'format',
        decision: { format: 'json', reason: 'detected', contentType: 'application/json' },
      },
      { type: 'text', text: '{"type":"A"}\n' },
    ]);
  });

  it('keeps a lone JSON line without a terminator, an array, or trailing blank lines', () => {
    const inputs = ['{"type":"A"}', '[1,2,3]\n', '{"type":"A"}\n\n', '{"type":"A"}\n  \n\r\n'];
    for (const input of inputs) {
      const calls = parse(input, { contentType: 'application/json' });
      expect(formatsOf(calls), input).toEqual([
        { format: 'json', reason: 'detected', contentType: 'application/json' },
      ]);
      expect(eventsOf(calls), input).toEqual([]);
      expect(textOf(calls), input).toBe(input);
    }
  });

  it('upgrades on the next non-empty line and skips blank lines in between', () => {
    const { parser, calls } = harness({ contentType: 'application/json' });
    parser.push(encode('{"type":"A"}\n'));
    parser.push(encode('\n'));
    parser.push(encode('  \n'));
    expect(formatsOf(calls)).toHaveLength(1);
    expect(eventsOf(calls)).toEqual([]);

    parser.push(encode('{"type":"B"}\n'));
    expect(formatsOf(calls).map((decision) => decision.format)).toEqual(['json', 'ndjson']);
    expect(eventsOf(calls)).toMatchObject([
      { index: 1, label: 'A', offset: 0, line: 1 },
      { index: 2, label: 'B', offset: 13 + 1 + 3, line: 4 },
    ]);
  });

  it('upgrades when the first line is CRLF-terminated', () => {
    const calls = parse('{"type":"A"}\r\n\r\n{"type":"B"}\r\n', {
      contentType: 'application/json',
    });

    expect(formatsOf(calls).map((decision) => decision.format)).toEqual(['json', 'ndjson']);
    expect(eventsOf(calls)).toMatchObject([
      { index: 1, label: 'A', offset: 0, length: 14, line: 1 },
      { index: 2, label: 'B', offset: 16, length: 14, line: 3 },
    ]);
  });

  it('upgrades when lines end in a lone CR', () => {
    const calls = parse('{"type":"A"}\r{"type":"B"}\r', { contentType: 'application/json' });

    expect(formatsOf(calls).map((decision) => decision.format)).toEqual(['json', 'ndjson']);
    expect(eventsOf(calls)).toMatchObject([
      { index: 1, label: 'A', offset: 0, length: 13, line: 1, unterminated: false },
      { index: 2, label: 'B', offset: 13, length: 13, line: 2, unterminated: false },
    ]);
  });

  it('upgrades after leading blank lines and keeps their offsets', () => {
    const calls = parse('  \n\t\n{"a":1}\n{"b":2}\n');

    expect(formatsOf(calls).map((decision) => decision.format)).toEqual(['json', 'ndjson']);
    expect(eventsOf(calls)).toMatchObject([
      { index: 1, value: { a: 1 }, offset: 5, length: 8, line: 3 },
      { index: 2, value: { b: 2 }, offset: 13, length: 8, line: 4 },
    ]);
  });

  it('upgrades to a malformed second line and reports it as malformed', () => {
    const calls = parse('{"type":"A"}\nnot json\n', { contentType: 'application/json' });

    expect(formatsOf(calls).map((decision) => decision.format)).toEqual(['json', 'ndjson']);
    expect(eventsOf(calls).map(summary)).toEqual([
      [1, 'json', 'A'],
      [2, 'malformed', undefined],
    ]);
  });

  it('upgrades a JSON array first line', () => {
    const calls = parse('[1,2]\n{"type":"B"}\n');

    expect(eventsOf(calls)).toMatchObject([
      { index: 1, kind: 'json', value: [1, 2], label: undefined },
      { index: 2, kind: 'json', value: { type: 'B' }, label: 'B' },
    ]);
  });

  it('upgrades after a leading byte-order mark without including it in text', () => {
    const calls = parse(
      concat(Uint8Array.from(byteOrderMark), encode('{"type":"A"}\n{"type":"B"}\n')),
    );

    expect(textOf(calls.slice(0, 2))).toBe('{"type":"A"}\n');
    expect(eventsOf(calls)).toMatchObject([
      { index: 1, offset: 3, length: 13 },
      { index: 2, offset: 16, length: 13 },
    ]);
  });

  it('never upgrades pretty-printed JSON', () => {
    const input = '{\n  "a": 1\n}\n{"b":2}\n';
    const chunkings: readonly (readonly (string | Uint8Array)[])[] = [
      [input],
      byteByByte(encode(input)),
    ];
    for (const chunks of chunkings) {
      const calls = parseChunks(chunks, { contentType: 'application/json' });
      expect(formatsOf(calls)).toEqual([
        { format: 'json', reason: 'detected', contentType: 'application/json' },
      ]);
      expect(eventsOf(calls)).toEqual([]);
      expect(warningsOf(calls)).toEqual([]);
      expect(textOf(calls)).toBe(input);
    }
  });

  it('never upgrades when the first line is not complete JSON', () => {
    const inputs = ['{"type":"A",\n{"type":"B"}\n', '[1, 2\n[3]\n', '{"a":1} trailing\n{"b":2}\n'];
    for (const input of inputs) {
      const calls = parse(input, { contentType: 'application/json' });
      expect(formatsOf(calls), input).toEqual([
        { format: 'json', reason: 'detected', contentType: 'application/json' },
      ]);
      expect(eventsOf(calls), input).toEqual([]);
      expect(textOf(calls), input).toBe(input);
    }
  });

  it('never upgrades json from a directive', () => {
    const input = '{"a":1}\n{"b":2}\n';
    const calls = parse(input, { directive: 'json', contentType: 'application/json' });

    expect(formatsOf(calls)).toEqual([
      { format: 'json', reason: 'directive', contentType: 'application/json' },
    ]);
    expect(eventsOf(calls)).toEqual([]);
    expect(textOf(calls)).toBe(input);
    expect(at(calls, 0).type).toBe('format');
  });
});

describe('StreamParser text mode', () => {
  it('emits raw and text directives as decoded text without events', () => {
    const input = '{"a":1}\ndata: x\n\n{"b":2}';
    for (const directive of ['text', 'raw'] as const) {
      const calls = parse(input, { directive });
      expect(formatsOf(calls), directive).toEqual([
        { format: directive, reason: 'directive', contentType: undefined },
      ]);
      expect(eventsOf(calls), directive).toEqual([]);
      expect(textOf(calls), directive).toBe(input);
    }
  });

  it('keeps text/html as text without sniffing', () => {
    const input = '{"a":1}\n{"b":2}\ndata: x\n\n';
    const calls = parse(input, { contentType: 'Text/HTML; charset=utf-8' });

    expect(formatsOf(calls)).toEqual([
      { format: 'text', reason: 'content-type', contentType: 'text/html' },
    ]);
    expect(eventsOf(calls)).toEqual([]);
    expect(textOf(calls)).toBe(input);
  });

  it('emits text as it arrives', () => {
    const { parser, calls } = harness({ contentType: 'text/html' });
    parser.push(encode('hello '));
    expect(textOf(calls)).toBe('hello ');
    parser.push(encode('world'));
    expect(textOf(calls)).toBe('hello world');
  });

  it('decodes multi-byte characters split across chunks', () => {
    const input = 'héllo ✓ 🚀 wörld\nsecond ✓ line 🚀\n';
    for (const options of [
      { contentType: 'text/html' },
      { contentType: 'text/plain' },
      { directive: 'raw' as const },
    ]) {
      const calls = parseChunks(byteByByte(encode(input)), options);
      expect(textOf(calls), JSON.stringify(options)).toBe(input);
      expect(warningsOf(calls), JSON.stringify(options)).toEqual([]);
    }
  });

  it('keeps the terminators of lines seen while sniffing', () => {
    const input = '\n  \nplain line\r\nsecond\rthird\r\nlast without terminator';
    const calls = parse(input, { contentType: 'text/plain' });

    expect(formatsOf(calls)).toEqual([
      { format: 'text', reason: 'detected', contentType: 'text/plain' },
    ]);
    expect(textOf(calls)).toBe(input);
    expect(textOf(parseChunks(byteByByte(encode(input)), { contentType: 'text/plain' }))).toBe(
      input,
    );
  });

  it('never shows a leading byte-order mark in text output', () => {
    const mark = Uint8Array.from(byteOrderMark);
    const body = encode('hello\nworld\n');
    const cases: readonly Partial<StreamParserOptions>[] = [
      { directive: 'text' },
      { directive: 'raw' },
      { contentType: 'text/html' },
      { contentType: 'text/plain' },
      {},
    ];
    for (const options of cases) {
      const whole = parse(concat(mark, body), options);
      expect(textOf(whole), JSON.stringify(options)).toBe('hello\nworld\n');
      const split = parseChunks(
        [Uint8Array.of(0xef), Uint8Array.of(0xbb), concat(Uint8Array.of(0xbf), body)],
        options,
      );
      expect(textOf(split), JSON.stringify(options)).toBe('hello\nworld\n');
      const single = parseChunks(byteByByte(concat(mark, body)), options);
      expect(textOf(single), JSON.stringify(options)).toBe('hello\nworld\n');
    }
  });

  it('removes only one leading byte-order mark', () => {
    const mark = Uint8Array.from(byteOrderMark);
    const bytes = concat(mark, mark, encode('hello\n'));
    for (const options of [{ contentType: 'text/html' }, { contentType: 'text/plain' }]) {
      expect(textOf(parse(bytes, options)), JSON.stringify(options)).toBe('﻿hello\n');
    }
  });

  it('keeps a byte-order mark character that is not at the start', () => {
    const input = 'a﻿b\nc﻿d';
    expect(textOf(parse(input, { contentType: 'text/html' }))).toBe(input);
    expect(textOf(parse(input, { contentType: 'text/plain' }))).toBe(input);
  });

  it('holds no bytes in text mode and reports the bytes held while undecided', () => {
    const decided = harness({ contentType: 'text/html' });
    decided.parser.push(encode('hello'));
    expect(decided.parser.pendingBytes).toBe(0);

    const sniffing = harness();
    expect(sniffing.parser.pendingBytes).toBe(0);
    sniffing.parser.push(encode('abc'));
    expect(sniffing.parser.pendingBytes).toBe(3);
    sniffing.parser.push(encode('\nmore'));
    expect(sniffing.parser.pendingBytes).toBe(0);
    sniffing.parser.push(encode(' and more'));
    expect(sniffing.parser.pendingBytes).toBe(0);

    const lines = harness({ contentType: 'application/x-ndjson' });
    lines.parser.push(encode('{"type":"A"'));
    expect(lines.parser.pendingBytes).toBe(11);
  });

  it('streams a 20 MiB single-line JSON body as text without truncating it', () => {
    const unit = '✓é🚀a';
    const repeats = Math.ceil((20 * mebibyte) / encode(unit).length);
    const input = encode(`{"text":"${unit.repeat(repeats)}"}`);
    expect(input.length).toBeGreaterThanOrEqual(20 * mebibyte);
    const chunkSize = 64 * 1024;
    const { parser, calls } = harness({ contentType: 'application/json' });
    let held = 0;

    for (let start = 0; start < input.length; start += chunkSize) {
      parser.push(input.subarray(start, start + chunkSize));
      held = Math.max(held, parser.pendingBytes);
    }
    parser.end();

    expect(held).toBeLessThanOrEqual(sniffBytes + chunkSize);
    expect(formatsOf(calls)).toEqual([
      { format: 'json', reason: 'detected', contentType: 'application/json' },
    ]);
    expect(eventsOf(calls)).toEqual([]);
    expect(warningsOf(calls)).toEqual([]);
    const text = textOf(calls);
    const expected = decoder.decode(input);
    expect(text.length).toBe(expected.length);
    expect(text === expected).toBe(true);
  }, 60_000);

  it('decides on the prefix after sniffBytes without a newline', () => {
    const long = sniffBytes + 8192;
    const chunkSize = 1024;
    const scenarios: readonly {
      name: string;
      input: string;
      format: FormatDecision['format'];
    }[] = [
      { name: 'sse', input: `data: {"a":"${'x'.repeat(long)}"}\n\n`, format: 'sse' },
      { name: 'json', input: `{"a":"${'x'.repeat(long)}"}\n{"b":2}\n`, format: 'json' },
      { name: 'text', input: `${'abc'.repeat(long)}\nmore\n`, format: 'text' },
    ];
    for (const { name, input, format } of scenarios) {
      const bytes = encode(input);
      const { parser, calls } = harness();
      parser.push(bytes.subarray(0, sniffBytes - 1));
      expect(calls, name).toEqual([]);
      for (let start = sniffBytes - 1; start < bytes.length; start += chunkSize) {
        parser.push(bytes.subarray(start, start + chunkSize));
      }
      expect(formatsOf(calls), name).toEqual([
        { format, reason: 'detected', contentType: undefined },
      ]);
      parser.end();

      expect(formatsOf(calls), name).toHaveLength(1);
      expect(warningsOf(calls), name).toEqual([]);
      if (format === 'sse') {
        expect(textOf(calls), name).toBe('');
        expect(eventsOf(calls), name).toMatchObject([
          {
            index: 1,
            kind: 'json',
            value: { a: 'x'.repeat(long) },
            offset: 0,
            length: bytes.length,
          },
        ]);
      } else {
        expect(eventsOf(calls), name).toEqual([]);
        expect(textOf(calls) === input, name).toBe(true);
      }
    }
  });

  it('decides a first JSON line longer than sniffBytes the same way whole or in pieces', () => {
    for (const terminator of ['\n', '\r\n', '\r']) {
      for (const size of [sniffBytes - 9, sniffBytes - 8, sniffBytes]) {
        const input = `{"a":"${'x'.repeat(size)}"}${terminator}{"b":2}${terminator}`;
        const bytes = encode(input);
        const runs = [[bytes], [bytes.subarray(0, 1000), bytes.subarray(1000)]].map((chunks) => {
          const { parser, calls } = harness({ contentType: 'application/json' });
          for (const chunk of chunks) {
            parser.push(chunk);
          }
          parser.end();
          return { formats: formatsOf(calls), events: eventsOf(calls), text: textOf(calls) };
        });
        const oneByte = harness({ contentType: 'application/json' });
        for (let index = 0; index < bytes.length; index += 1) {
          oneByte.parser.push(bytes.subarray(index, index + 1));
        }
        oneByte.parser.end();
        const label = `${JSON.stringify(terminator)} ${String(size)}`;

        expect(runs[0], label).toEqual(runs[1]);
        expect(runs[0]?.formats, label).toEqual(formatsOf(oneByte.calls));
        expect(runs[0]?.events.length, label).toBe(eventsOf(oneByte.calls).length);
      }
    }
  });
});

describe('StreamParser events', () => {
  it('numbers events from one in emission order and stamps them with the clock', () => {
    let clock = 0;
    const { parser, calls } = harness({
      contentType: 'application/x-ndjson',
      now: () => clock,
    });

    clock = 5;
    parser.push(encode('{"type":"A"}\n'));
    clock = 9;
    parser.push(encode('{"type":"B"}\n{"type":"C"}\n'));
    parser.end();

    expect(eventsOf(calls).map((event) => [event.index, event.time, event.label])).toEqual([
      [1, 5, 'A'],
      [2, 9, 'B'],
      [3, 9, 'C'],
    ]);
  });

  it('labels events from the type fields, then the SSE event name', () => {
    const ndjson = parse('{"kind":"K","type":"T"}\n{"type":3}\n{"other":1}\n["x"]\n', {
      contentType: 'application/x-ndjson',
      typeFields: ['kind', 'type'],
    });
    expect(eventsOf(ndjson).map((event) => event.label)).toEqual(['K', '3', undefined, undefined]);

    const sse = parse(
      'event: ping\ndata: {"n":1}\n\nevent: ping\ndata: {"type":"X"}\n\ndata: {"n":2}\n\n',
      { contentType: 'text/event-stream' },
    );
    expect(eventsOf(sse).map((event) => event.label)).toEqual(['ping', 'X', undefined]);
  });

  it('keeps the SSE fields and markers on events', () => {
    const calls = parse(
      'id: 42\nretry: 3000\nevent: update\ndata: {"n":1}\n\nevent: error\ndata: boom\n\ndata: [DONE]\n\n',
      { contentType: 'text/event-stream' },
    );

    expect(eventsOf(calls)).toMatchObject([
      { kind: 'json', sse: { event: 'update', id: '42', retry: 3000 }, marker: undefined },
      { kind: 'text', value: 'boom', sse: { event: 'error' }, marker: 'error', label: 'error' },
      { kind: 'text', value: '[DONE]', marker: 'done' },
    ]);
  });

  it('skips empty lines and reports a final line without a terminator', () => {
    const calls = parse('{"type":"A"}\n\n  \n{"type":"B"}', {
      contentType: 'application/x-ndjson',
    });

    expect(eventsOf(calls)).toMatchObject([
      { index: 1, label: 'A', offset: 0, line: 1, unterminated: false },
      { index: 2, label: 'B', offset: 13 + 1 + 3, line: 4, unterminated: true },
    ]);
  });

  it('reports malformed JSON lines with their position and keeps going', () => {
    const calls = parse('{"type":"A"}\n{broken\n{"type":"B"}\n', {
      contentType: 'application/x-ndjson',
    });

    const events = eventsOf(calls);
    expect(events.map(summary)).toEqual([
      [1, 'json', 'A'],
      [2, 'malformed', undefined],
      [3, 'json', 'B'],
    ]);
    expect(at(events, 1)).toMatchObject({ value: '{broken', offset: 13, length: 8, line: 2 });
    expect(typeof at(events, 1).error).toBe('string');
    expect(warningsOf(calls)).toEqual([]);
  });

  it('reports an over-limit NDJSON line and resynchronises at the next terminator', () => {
    const long = `{"pad":"${'x'.repeat(100)}"}`;
    const calls = parse(`{"type":"A"}\n${long}\n{"type":"B"}\n`, {
      contentType: 'application/x-ndjson',
      maxEventSize: 32,
    });

    const events = eventsOf(calls);
    expect(events.map(summary)).toEqual([
      [1, 'json', 'A'],
      [2, 'oversize', undefined],
      [3, 'json', 'B'],
    ]);
    expect(at(events, 1)).toMatchObject({
      offset: 13,
      length: encode(`${long}\n`).length,
      line: 2,
    });
    expect(at(events, 1).value).toEqual(expect.stringMatching(/^\{"pad":"x+$/));
    expect(at(events, 2).offset).toBe(13 + encode(`${long}\n`).length);
  });

  it('reports an over-limit SSE event and resynchronises at the next blank line', () => {
    const long = 'y'.repeat(100);
    const calls = parse(`data: {"type":"A"}\n\ndata: ${long}\n\ndata: {"type":"B"}\n\n`, {
      contentType: 'text/event-stream',
      maxEventSize: 32,
    });

    const events = eventsOf(calls);
    expect(events.map(summary)).toEqual([
      [1, 'json', 'A'],
      [2, 'oversize', undefined],
      [3, 'json', 'B'],
    ]);
    expect(at(events, 1)).toMatchObject({ offset: 20, length: 108 });
    expect(at(events, 2).offset).toBe(128);
  });

  it('preserves event order across the fixtures', () => {
    const agUi = [
      'RUN_STARTED',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'RUN_FINISHED',
    ];
    for (const fixture of streamFixtures) {
      const events = eventsOf(parse(fixture.bytes, { contentType: fixture.contentType }));
      expect(
        events.map((event) => event.index),
        fixture.name,
      ).toEqual(events.map((_, index) => index + 1));
      const offsets = events.map((event) => event.offset);
      expect(offsets, fixture.name).toEqual([...offsets].sort((left, right) => left - right));
    }
    const ndjson = eventsOf(
      parse(fixtureBytes('ag-ui.ndjson'), { contentType: 'application/x-ndjson' }),
    );
    const sse = eventsOf(parse(fixtureBytes('ag-ui.sse'), { contentType: 'text/event-stream' }));
    expect(ndjson.map((event) => event.label)).toEqual(agUi);
    expect(sse.map((event) => event.label)).toEqual(agUi);
    expect(sse.map((event) => event.value)).toEqual(ndjson.map((event) => event.value));
  });

  it('keeps exact large integers in event values', () => {
    const events = eventsOf(
      parse(fixtureBytes('edge-cases.ndjson'), { contentType: 'application/x-ndjson' }),
    );

    expect(events.map((event) => event.kind)).toEqual([
      'json',
      'malformed',
      'json',
      'json',
      'json',
    ]);
    expect(at(events, 2).value).toEqual({ type: 'big', id: 12345678901234567890n });
  });
});

describe('StreamParser warnings', () => {
  it('reports invalid UTF-8 once', () => {
    const fixture = fixtureBytes('invalid-utf8.ndjson');
    const calls = parse(concat(fixture, fixture), { contentType: 'application/x-ndjson' });

    expect(warningsOf(calls)).toEqual([{ kind: 'invalid-utf8', offset: 22 }]);
    expect(eventsOf(calls)).toMatchObject([
      { index: 1, kind: 'json', offset: 0 },
      { index: 2, kind: 'json', offset: fixture.length },
    ]);
  });

  it('reports invalid UTF-8 at the offset of the first invalid byte', () => {
    const fixture = fixtureBytes('invalid-utf8.ndjson');
    const bytes = concat(encode('{"type":"A"}\n'), fixture, fixture);
    const options = { contentType: 'application/x-ndjson' };

    expect(warningsOf(parse(bytes, options))).toEqual([{ kind: 'invalid-utf8', offset: 35 }]);
    expect(warningsOf(parseChunks(byteByByte(bytes), options))).toEqual([
      { kind: 'invalid-utf8', offset: 35 },
    ]);
  });

  it('reports invalid UTF-8 once in an SSE stream', () => {
    const bytes = concat(
      encode('data: ok\n\ndata: '),
      Uint8Array.of(0xc3, 0x28),
      encode('\n\ndata: '),
      Uint8Array.of(0xc3, 0x28),
      encode('\n\n'),
    );
    const calls = parse(bytes, { contentType: 'text/event-stream' });

    expect(warningsOf(calls)).toEqual([
      { kind: 'invalid-utf8', offset: encode('data: ok\n\ndata: ').length },
    ]);
    expect(eventsOf(calls)).toHaveLength(3);
  });

  it('reports invalid UTF-8 once in text mode', () => {
    const bytes = concat(
      encode('ok\nabc '),
      Uint8Array.of(0xff),
      encode(' def '),
      Uint8Array.of(0xfe),
      encode('\nmore\n'),
    );
    const cases: readonly Partial<StreamParserOptions>[] = [
      { contentType: 'text/html' },
      { contentType: 'text/plain' },
      { directive: 'raw' },
    ];
    for (const options of cases) {
      for (const chunks of [[bytes], byteByByte(bytes)]) {
        const calls = parseChunks(chunks, options);
        const warnings = warningsOf(calls);
        expect(warnings, JSON.stringify(options)).toHaveLength(1);
        expect(at(warnings, 0).kind, JSON.stringify(options)).toBe('invalid-utf8');
        expect(textOf(calls), JSON.stringify(options)).toContain('�');
      }
    }
  });

  it('reports no warning for valid UTF-8', () => {
    for (const fixture of streamFixtures) {
      if (fixture.name === 'invalid-utf8.ndjson') {
        continue;
      }
      const calls = parse(fixture.bytes, { contentType: fixture.contentType });
      expect(
        warningsOf(calls).filter((warning) => warning.kind === 'invalid-utf8'),
        fixture.name,
      ).toEqual([]);
    }
  });

  it('reports a discarded final SSE event', () => {
    const calls = parse('data: {"type":"A"}\n\ndata: partial\n', {
      contentType: 'text/event-stream',
    });

    expect(eventsOf(calls).map(summary)).toEqual([[1, 'json', 'A']]);
    expect(warningsOf(calls)).toEqual([{ kind: 'discarded-event', offset: 20, length: 14 }]);
    expect(at(calls, calls.length - 1).type).toBe('warning');
  });

  it('reports a discarded final SSE event without a terminator or when sniffed', () => {
    const unterminated = parse('data: {"type":"A"}\n\ndata: partial', {
      contentType: 'text/event-stream',
    });
    expect(warningsOf(unterminated)).toEqual([{ kind: 'discarded-event', offset: 20, length: 13 }]);

    const sniffed = parse('data: {"type":"A"}\n\ndata: partial\n');
    expect(formatsOf(sniffed)).toEqual([
      { format: 'sse', reason: 'detected', contentType: undefined },
    ]);
    expect(warningsOf(sniffed)).toEqual([{ kind: 'discarded-event', offset: 20, length: 14 }]);

    const only = parse('data: {"type":"A"}');
    expect(eventsOf(only)).toEqual([]);
    expect(warningsOf(only)).toEqual([{ kind: 'discarded-event', offset: 0, length: 18 }]);
  });

  it('reports nothing for a final SSE block without data', () => {
    const inputs = [
      'data: {"type":"A"}\n\n',
      'data: {"type":"A"}\n\nid: 7\n',
      'data: {"type":"A"}\n\n: tail',
      'data: {"type":"A"}\n\nretry: 100\nevent: x',
    ];
    for (const input of inputs) {
      const calls = parse(input, { contentType: 'text/event-stream' });
      expect(warningsOf(calls), input).toEqual([]);
    }
  });

  it('reports no discarded event for NDJSON', () => {
    const calls = parse('{"type":"A"}\n{"type":"B"', { contentType: 'application/x-ndjson' });

    expect(warningsOf(calls)).toEqual([]);
    expect(eventsOf(calls).map(summary)).toEqual([
      [1, 'json', 'A'],
      [2, 'malformed', undefined],
    ]);
    expect(at(eventsOf(calls), 1).unterminated).toBe(true);
  });
});

describe('StreamParser stop', () => {
  it('emits nothing after stop', () => {
    const scenarios: readonly {
      name: string;
      options: Partial<StreamParserOptions>;
      before: string;
      after: string;
    }[] = [
      {
        name: 'after an NDJSON event',
        options: { contentType: 'application/x-ndjson' },
        before: '{"type":"A"}\n',
        after: '{"type":"B"}\n{"type":"C"}',
      },
      {
        name: 'before any byte with a directive',
        options: { directive: 'ndjson' },
        before: '',
        after: '{"type":"B"}\n',
      },
      {
        name: 'before any byte with a content type',
        options: { contentType: 'text/html' },
        before: '',
        after: 'hello',
      },
      {
        name: 'while sniffing a partial line',
        options: {},
        before: '{"type":"A"',
        after: '}\n{"type":"B"}\n',
      },
      {
        name: 'while sniffing an SSE line',
        options: { contentType: 'text/plain' },
        before: 'data: {"type":"A"}',
        after: '\n\ndata: {"type":"B"}\n\n',
      },
      {
        name: 'while holding a single JSON line',
        options: { contentType: 'application/json' },
        before: '{"type":"A"}\n',
        after: '{"type":"B"}\n',
      },
      {
        name: 'in text mode',
        options: { contentType: 'text/html' },
        before: 'hello ',
        after: 'world',
      },
      {
        name: 'in sniffed text mode',
        options: { contentType: 'text/plain' },
        before: 'hello\nwor',
        after: 'ld\n',
      },
      {
        name: 'with a pending SSE event',
        options: { contentType: 'text/event-stream' },
        before: 'data: {"type":"A"}\n\ndata: partial\n',
        after: 'more\n',
      },
    ];
    for (const { name, options, before, after } of scenarios) {
      const { parser, calls } = harness(options);
      if (before !== '') {
        parser.push(encode(before));
      }
      const emitted = calls.length;
      parser.stop();
      parser.push(encode(after));
      parser.end();
      parser.stop();
      parser.push(encode(after));
      parser.end();
      expect(calls, name).toHaveLength(emitted);
    }
  });

  it('emits no decision when stopped before the first byte', () => {
    const { parser, calls } = harness({ directive: 'sse' });
    parser.stop();
    parser.end();

    expect(calls).toEqual([]);
  });
});

describe('parseEventBytes', () => {
  const options = { maxEventSize: defaultStreamLimits.maxEventSize, typeFields: ['type'] };

  it('re-parses one event from its raw bytes', () => {
    const bytes = fixtureBytes('ag-ui.ndjson');
    const events = eventsOf(parse(bytes, { contentType: 'application/x-ndjson' }));
    const third = at(events, 2);
    const raw = bytes.subarray(third.offset, third.offset + third.length);

    const parsed = parseEventBytes(raw, 'ndjson', options);

    expect(parsed).toBeDefined();
    expect(parsed?.value).toEqual(third.value);
    expect(parsed?.label).toBe(third.label);
    expect(parsed?.label).toBe('TEXT_MESSAGE_CONTENT');
    expect(parsed).toMatchObject({
      kind: 'json',
      offset: 0,
      length: raw.length,
      line: 1,
      unterminated: false,
      marker: undefined,
      error: undefined,
    });
    expect(parsed).not.toHaveProperty('index');
    expect(parsed).not.toHaveProperty('time');
  });

  it('re-parses one SSE event from its raw bytes', () => {
    const bytes = fixtureBytes('ag-ui.sse');
    const events = eventsOf(parse(bytes, { contentType: 'text/event-stream' }));
    const third = at(events, 2);
    const raw = bytes.subarray(third.offset, third.offset + third.length);

    const parsed = parseEventBytes(raw, 'sse', options);

    expect(parsed?.value).toEqual(third.value);
    expect(parsed?.label).toBe('TEXT_MESSAGE_CONTENT');
    expect(parsed).toMatchObject({ kind: 'json', offset: 0, length: raw.length, line: 1 });
    expect(parsed).not.toHaveProperty('index');
    expect(parsed).not.toHaveProperty('time');
  });

  it('keeps the SSE fields and falls back to the event name for the label', () => {
    const parsed = parseEventBytes(
      encode('id: 42\nevent: ping\nretry: 10\ndata: {"n":1}\n\n'),
      'sse',
      options,
    );

    expect(parsed).toMatchObject({
      kind: 'json',
      value: { n: 1 },
      label: 'ping',
      sse: { event: 'ping', id: '42', retry: 10 },
    });
  });

  it('returns the last event produced by the bytes with offsets relative to them', () => {
    const ndjson = parseEventBytes(encode('{"type":"A"}\n{"type":"B"}\n'), 'ndjson', options);
    expect(ndjson).toMatchObject({ value: { type: 'B' }, label: 'B', offset: 13, line: 2 });

    const sse = parseEventBytes(encode('data: 1\n\ndata: 2\n\n'), 'sse', options);
    expect(sse).toMatchObject({ value: 2, offset: 9, line: 3 });
  });

  it('reports a final line without a terminator as unterminated', () => {
    const parsed = parseEventBytes(encode('{"type":"A"}'), 'ndjson', options);

    expect(parsed).toMatchObject({ kind: 'json', label: 'A', unterminated: true });
  });

  it('returns malformed and oversize events as they are', () => {
    expect(parseEventBytes(encode('not json\n'), 'ndjson', options)).toMatchObject({
      kind: 'malformed',
      value: 'not json',
    });
    const oversize = parseEventBytes(encode(`{"type":"${'a'.repeat(50)}"}\n`), 'ndjson', {
      ...options,
      maxEventSize: 16,
    });
    expect(oversize).toMatchObject({ kind: 'oversize', offset: 0, line: 1 });
  });

  it('returns undefined when the bytes produce no event', () => {
    expect(parseEventBytes(new Uint8Array(0), 'ndjson', options)).toBeUndefined();
    expect(parseEventBytes(encode('\n  \n'), 'ndjson', options)).toBeUndefined();
    expect(parseEventBytes(new Uint8Array(0), 'sse', options)).toBeUndefined();
    expect(parseEventBytes(encode('data: {"type":"A"}\n'), 'sse', options)).toBeUndefined();
  });
});

describe('StreamParser review fixes', () => {
  it('stamps the first line of an upgraded body with its own arrival time', () => {
    let clock = 100;
    const { parser, calls } = harness({ contentType: 'application/json', now: () => clock });
    parser.push(encode('{"type":"RUN_STARTED"}\n'));
    clock = 5100;
    parser.push(encode('{"type":"RUN_FINISHED"}\n'));

    expect(eventsOf(calls).map((event) => [event.label, event.time])).toEqual([
      ['RUN_STARTED', 100],
      ['RUN_FINISHED', 5100],
    ]);
  });

  it('sniffs a body whole even when maxEventSize is below sniffBytes', () => {
    const input = `{"a":"${'x'.repeat(4096)}"}`;
    const { parser, calls } = harness({ contentType: 'application/json', maxEventSize: 1024 });
    for (let start = 0; start < input.length; start += 100) {
      parser.push(encode(input.slice(start, start + 100)));
    }
    parser.end();

    expect(formatsOf(calls).map((decision) => decision.format)).toEqual(['json']);
    expect(textOf(calls)).toBe(input);
  });

  it('reports the exact offset of invalid UTF-8 in a text body', () => {
    const bytes = concat(encode('héllo wörld '), Uint8Array.of(0xc3, 0x28), encode(' more\n'));
    for (const contentType of ['text/plain', 'text/html']) {
      for (const size of [1, 3, bytes.length]) {
        const { parser, calls } = harness({ contentType });
        for (let start = 0; start < bytes.length; start += size) {
          parser.push(bytes.subarray(start, start + size));
        }
        parser.end();

        expect(warningsOf(calls), `${contentType} ${String(size)}`).toEqual([
          { kind: 'invalid-utf8', offset: 14 },
        ]);
      }
    }
  });

  it('reports the exact offset of invalid UTF-8 after a sniffed first line', () => {
    const bytes = concat(
      encode('first line\nsecond '),
      Uint8Array.of(0xc3, 0x28),
      encode(' line\n'),
    );
    for (const size of [1, 2, 5, bytes.length]) {
      const { parser, calls } = harness({ contentType: 'text/plain' });
      for (let start = 0; start < bytes.length; start += size) {
        parser.push(bytes.subarray(start, start + size));
      }
      parser.end();

      expect(warningsOf(calls), String(size)).toEqual([{ kind: 'invalid-utf8', offset: 18 }]);
    }
  });
});
