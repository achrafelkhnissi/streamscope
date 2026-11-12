import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import { everySplit, randomSplits } from '../../support/chunks';
import { streamFixtures } from '../../support/stream-fixtures';
import type { StreamEvent } from '../../../src/events/model';
import type { FormatDecision } from '../../../src/streaming/detect';
import { defaultStreamLimits } from '../../../src/streaming/limits';
import {
  StreamParser,
  type StreamParserOptions,
  type StreamSink,
  type StreamWarning,
} from '../../../src/streaming/parser';

type Call =
  | { type: 'format'; decision: FormatDecision }
  | { type: 'event'; event: StreamEvent }
  | { type: 'text'; text: string }
  | { type: 'warning'; warning: StreamWarning };

interface Outcome {
  format: FormatDecision | undefined;
  events: StreamEvent[];
  warnings: StreamWarning[];
  text: string;
}

interface Input {
  name: string;
  bytes: Uint8Array;
  options: Partial<StreamParserOptions>;
}

const encoder = new TextEncoder();
const mark = Uint8Array.from([0xef, 0xbb, 0xbf]);
const randomSplitCount = 200;
const randomSplitSeed = 1;

function encode(text: string): Uint8Array {
  return encoder.encode(text);
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  return Uint8Array.from(parts.flatMap((part) => Array.from(part)));
}

function collect(): { sink: StreamSink; calls: Call[] } {
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
  return { sink, calls };
}

function outcomeOf(calls: readonly Call[]): Outcome {
  let lastFormat = -1;
  calls.forEach((call, index) => {
    if (call.type === 'format') {
      lastFormat = index;
    }
  });
  const decided = calls[lastFormat];
  return {
    format: decided?.type === 'format' ? decided.decision : undefined,
    events: calls.flatMap((call) => (call.type === 'event' ? [{ ...call.event, time: 0 }] : [])),
    warnings: calls.flatMap((call) => (call.type === 'warning' ? [call.warning] : [])),
    text: calls
      .slice(lastFormat + 1)
      .map((call) => (call.type === 'text' ? call.text : ''))
      .join(''),
  };
}

function run(chunks: readonly Uint8Array[], options: Partial<StreamParserOptions>): Outcome {
  const { sink, calls } = collect();
  const parser = new StreamParser(
    {
      contentType: undefined,
      directive: undefined,
      maxEventSize: defaultStreamLimits.maxEventSize,
      typeFields: defaultStreamLimits.typeFields,
      now: () => 0,
      ...options,
    },
    sink,
  );
  for (const chunk of chunks) {
    parser.push(chunk);
  }
  parser.end();
  return outcomeOf(calls);
}

function describeChunks(chunks: readonly Uint8Array[]): string {
  const sizes = chunks.slice(0, 12).map((chunk) => String(chunk.length));
  const more = chunks.length > sizes.length ? `, … (${String(chunks.length)} chunks)` : '';
  return `[${sizes.join(', ')}${more}]`;
}

function expectSameForEverySplit(inputs: readonly Input[]): void {
  for (const input of inputs) {
    const expected = run([input.bytes], input.options);
    const chunkings = [
      ...everySplit(input.bytes),
      ...randomSplits(input.bytes, randomSplitSeed, randomSplitCount),
    ];
    for (const chunks of chunkings) {
      const actual = run(chunks, input.options);
      if (!isDeepStrictEqual(actual, expected)) {
        expect(actual, `${input.name} split into ${describeChunks(chunks)}`).toStrictEqual(
          expected,
        );
      }
    }
  }
}

const fixtureInputs: readonly Input[] = streamFixtures.flatMap((fixture) => {
  const sniffed =
    fixture.format === 'ndjson'
      ? { label: 'application/json', contentType: 'application/json' }
      : { label: 'no content type', contentType: undefined };
  return [
    {
      name: `${fixture.name} as ${fixture.contentType}`,
      bytes: fixture.bytes,
      options: { contentType: fixture.contentType },
    },
    {
      name: `${fixture.name} as ${sniffed.label}`,
      bytes: fixture.bytes,
      options: { contentType: sniffed.contentType },
    },
  ];
});

const longPad = 'x'.repeat(100);

const edgeInputs: readonly Input[] = [
  {
    name: 'pretty-printed JSON',
    bytes: encode('{\n  "a": 1\n}\n{"b":2}\n'),
    options: { contentType: 'application/json' },
  },
  { name: 'single JSON line', bytes: encode('{"type":"A"}\n'), options: {} },
  {
    name: 'single JSON line without a terminator',
    bytes: encode('{"type":"A"}'),
    options: { contentType: 'application/json' },
  },
  {
    name: 'single JSON line followed by blank lines',
    bytes: encode('{"type":"A"}\r\n  \r\n\r\n'),
    options: { contentType: 'application/json' },
  },
  {
    name: 'upgrade with CRLF lines and a final line without a terminator',
    bytes: encode('{"type":"A"}\r\n\r\n{"type":"B"}\r\n{"type":"C"}'),
    options: { contentType: 'application/json' },
  },
  {
    name: 'upgrade with lone CR lines',
    bytes: encode('{"type":"A"}\r{"type":"B"}\r'),
    options: {},
  },
  {
    name: 'upgrade after whitespace-only lines',
    bytes: encode('  \n\t\n{"a":1}\n{"b":2}\n'),
    options: {},
  },
  {
    name: 'upgrade with a malformed second line',
    bytes: encode('[1,2]\nnot json\n{"type":"C"}\n'),
    options: { contentType: 'application/json' },
  },
  {
    name: 'SSE after blank lines and comments',
    bytes: encode('\r\n\n: keep-alive\r\n\r\ndata: {"type":"A"}\r\n\r\ndata: partial'),
    options: { contentType: 'text/plain' },
  },
  {
    name: 'SSE with a byte-order mark and no content type',
    bytes: concat(mark, encode(': hello\ndata: {"type":"A"}\n\n')),
    options: {},
  },
  {
    name: 'SSE with invalid UTF-8',
    bytes: concat(encode('data: ok\n\ndata: '), Uint8Array.of(0xc3, 0x28), encode('\n\n')),
    options: {},
  },
  {
    name: 'NDJSON with a byte-order mark and an upgrade',
    bytes: concat(mark, encode('{"type":"A"}\r\n{"type":"B"}\r\n')),
    options: { contentType: 'application/json' },
  },
  {
    name: 'NDJSON lines over the size limit',
    bytes: encode(`{"type":"A"}\n{"pad":"${longPad}"}\r\n{"type":"B"}\n`),
    options: { contentType: 'application/x-ndjson', maxEventSize: 32 },
  },
  {
    name: 'SSE events over the size limit',
    bytes: encode(`data: {"type":"A"}\n\ndata: ${longPad}\n\ndata: {"type":"B"}\n\n`),
    options: { contentType: 'text/event-stream', maxEventSize: 32 },
  },
  {
    name: 'multi-byte text with mixed line endings',
    bytes: encode('héllo ✓ 🚀\nsecond line\r\nthird\rfourth ✓'),
    options: { contentType: 'text/plain' },
  },
  {
    name: 'multi-byte text from text/html',
    bytes: encode('héllo ✓ 🚀\r\nwörld\r'),
    options: { contentType: 'text/html' },
  },
  {
    name: 'byte-order mark before text',
    bytes: concat(mark, encode('hello\nwörld ✓')),
    options: { contentType: 'text/plain' },
  },
  {
    name: 'byte-order mark before text with a directive',
    bytes: concat(mark, encode('hello\nwörld ✓')),
    options: { directive: 'text' },
  },
  {
    name: 'raw directive with JSON lines',
    bytes: encode('{"a":1}\n{"b":2}\n'),
    options: { directive: 'raw' },
  },
  {
    name: 'json directive with two JSON lines',
    bytes: encode('{"a":1}\n{"b":2}\n'),
    options: { directive: 'json' },
  },
  {
    name: 'ndjson directive over an SSE content type',
    bytes: encode('{"type":"A"}\ndata: x\n{"type":"B"}'),
    options: { directive: 'ndjson', contentType: 'text/event-stream' },
  },
  { name: 'whitespace-only body', bytes: encode('\n  \r\n\t\n'), options: {} },
  { name: 'empty body', bytes: new Uint8Array(0), options: { contentType: 'application/json' } },
];

describe('StreamParser byte boundaries', () => {
  it('gives identical results for every split of every fixture', () => {
    expectSameForEverySplit(fixtureInputs);
  }, 60_000);

  it('gives identical results for every split of the edge-case inputs', () => {
    expectSameForEverySplit(edgeInputs);
  }, 60_000);

  it('gives identical results for every split of two leading byte-order marks', () => {
    const bytes = concat(mark, mark, encode('hello\n'));
    expectSameForEverySplit([
      { name: 'two marks before text/html', bytes, options: { contentType: 'text/html' } },
      { name: 'two marks before text/plain', bytes, options: { contentType: 'text/plain' } },
      { name: 'two marks with a text directive', bytes, options: { directive: 'text' } },
    ]);
  }, 60_000);

  it('detects the format of every fixture from its content type or by sniffing', () => {
    for (const fixture of streamFixtures) {
      const declared = run([fixture.bytes], { contentType: fixture.contentType });
      expect(declared.format, fixture.name).toEqual({
        format: fixture.format,
        reason: 'content-type',
        contentType: fixture.contentType,
      });
      expect(declared.events.length, fixture.name).toBeGreaterThan(0);

      const sniffedFormat =
        fixture.format === 'sse' || fixture.name !== 'invalid-utf8.ndjson'
          ? fixture.format
          : 'json';
      const sniffed = run([fixture.bytes], {
        contentType: fixture.format === 'ndjson' ? 'application/json' : undefined,
      });
      expect(sniffed.format?.format, fixture.name).toBe(sniffedFormat);
      expect(sniffed.format?.reason, fixture.name).toBe('detected');
      if (sniffedFormat !== 'json') {
        expect(sniffed.events, fixture.name).toEqual(declared.events);
        expect(sniffed.warnings, fixture.name).toEqual(declared.warnings);
      }
    }
  });
});
