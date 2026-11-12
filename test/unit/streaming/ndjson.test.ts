import { describe, expect, it } from 'vitest';
import { everySplit } from '../../support/chunks';
import { streamFixtures } from '../../support/stream-fixtures';
import type { ParsedEvent } from '../../../src/events/model';
import { LineFramer, type FramedLine } from '../../../src/streaming/framer';
import { parseJson } from '../../../src/streaming/json';
import { ndjsonEvent } from '../../../src/streaming/ndjson';

type OversizeLine = Extract<FramedLine, { kind: 'oversize' }>;

const roomy = 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode(text: string): Uint8Array {
  return encoder.encode(text);
}

function fixtureBytes(name: string): Uint8Array {
  const fixture = streamFixtures.find((candidate) => candidate.name === name);
  if (fixture === undefined) {
    throw new Error(`Missing fixture ${name}`);
  }
  return fixture.bytes;
}

function frameChunks(chunks: readonly Uint8Array[], maxLineBytes: number): FramedLine[] {
  const framer = new LineFramer(maxLineBytes);
  const lines: FramedLine[] = [];
  for (const chunk of chunks) {
    framer.push(chunk);
    for (let line = framer.next(); line !== undefined; line = framer.next()) {
      lines.push(line);
    }
  }
  const last = framer.end();
  if (last !== undefined) {
    lines.push(last);
  }
  return lines;
}

function frameAll(bytes: Uint8Array, maxLineBytes: number): FramedLine[] {
  return frameChunks([bytes], maxLineBytes);
}

function interpret(lines: readonly FramedLine[]): ParsedEvent[] {
  return lines.flatMap((line) => {
    const event = ndjsonEvent(line);
    return event === undefined ? [] : [event];
  });
}

function eventsOf(bytes: Uint8Array, maxLineBytes = roomy): ParsedEvent[] {
  return interpret(frameAll(bytes, maxLineBytes));
}

function eventAt(events: readonly ParsedEvent[], index: number): ParsedEvent {
  const event = events[index];
  if (event === undefined) {
    throw new Error(`No event at index ${String(index)}`);
  }
  return event;
}

function textOf(event: ParsedEvent): string {
  if (typeof event.value !== 'string') {
    throw new Error('Expected a text value');
  }
  return event.value;
}

function oversizeLineAt(lines: readonly FramedLine[], index: number): OversizeLine {
  const line = lines[index];
  if (line?.kind !== 'oversize') {
    throw new Error(`Expected an oversize line at index ${String(index)}`);
  }
  return line;
}

const edgeCases = fixtureBytes('edge-cases.ndjson');
const edgeCasesText = decoder.decode(edgeCases);
const brokenText = '{"type":"broken",';
const brokenOffset = encode(edgeCasesText.slice(0, edgeCasesText.indexOf(brokenText))).length;
const brokenLength = encode(`${brokenText}\r\n`).length;

const prefix = '{"type":"huge","text":"';
const suffix = '"}';
const oversizeLine = `${prefix}${'a'.repeat(100 - prefix.length - suffix.length)}${suffix}`;
const oversizeInput = `${oversizeLine}\n{"type":"after"}\n`;
const oversizeLimit = 32;

const terminatorPieces = [
  ['{"n":1}', '\n'],
  ['{"n":2}', '\r\n'],
  ['{"n":3}', '\r'],
  ['{"n":4}', '\r'],
] as const;
const terminatorInput = terminatorPieces
  .map(([text, terminator]) => `${text}${terminator}`)
  .join('');

describe('ndjsonEvent', () => {
  it('parses each AG-UI line into a json event', () => {
    const events = eventsOf(fixtureBytes('ag-ui.ndjson'));

    expect(events).toHaveLength(8);
    expect(events.map((event) => event.kind)).toEqual(Array<string>(8).fill('json'));
    expect(events.map((event) => event.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(eventAt(events, 0).value).toMatchObject({ threadId: 'thread-1' });
    expect(events.map((event) => event.value)).toMatchObject([
      { type: 'RUN_STARTED' },
      { type: 'TEXT_MESSAGE_START' },
      { type: 'TEXT_MESSAGE_CONTENT', delta: 'Héllo' },
      { type: 'TEXT_MESSAGE_CONTENT', delta: ', wörld' },
      { type: 'TEXT_MESSAGE_CONTENT', delta: ' 🚀' },
      { type: 'TEXT_MESSAGE_CONTENT', delta: '✓' },
      { type: 'TEXT_MESSAGE_END' },
      { type: 'RUN_FINISHED', threadId: 'thread-1' },
    ]);
  });

  it('returns a complete event for a json line', () => {
    const line = '{"type":"RUN_STARTED","threadId":"thread-1"}';
    const events = eventsOf(encode(`${line}\n`));

    expect(events).toStrictEqual([
      {
        offset: 0,
        length: encode(line).length + 1,
        line: 1,
        kind: 'json',
        value: { type: 'RUN_STARTED', threadId: 'thread-1' },
        sse: undefined,
        marker: undefined,
        error: undefined,
        unterminated: false,
      },
    ]);
  });

  it('uses byte offsets and lengths that include the terminator', () => {
    const text = decoder.decode(fixtureBytes('ag-ui.ndjson'));
    const rows = text.split('\n').slice(0, -1);
    let offset = 0;
    const expected = rows.map((row, index) => {
      const length = encode(row).length + 1;
      const entry = { offset, length, line: index + 1 };
      offset += length;
      return entry;
    });

    const events = eventsOf(fixtureBytes('ag-ui.ndjson'));

    expect(
      events.map((event) => ({ offset: event.offset, length: event.length, line: event.line })),
    ).toEqual(expected);
  });

  it('copies offset, length and line number from the framed line', () => {
    const inputs: readonly (readonly [Uint8Array, number])[] = [
      [edgeCases, roomy],
      [fixtureBytes('ag-ui.ndjson'), roomy],
      [encode(oversizeInput), oversizeLimit],
    ];
    for (const [input, max] of inputs) {
      for (const line of frameAll(input, max)) {
        const event = ndjsonEvent(line);
        if (event !== undefined) {
          expect({ offset: event.offset, length: event.length, line: event.line }).toEqual({
            offset: line.offset,
            length: line.length,
            line: line.number,
          });
        }
      }
    }
  });

  it('ignores empty and whitespace-only lines', () => {
    const input = encode('\n   \n\t\n{"type":"one"}\n \t \n{"type":"two"}\n\n');
    const events = eventsOf(input);

    expect(events.map((event) => event.line)).toEqual([4, 6]);
    expect(events.map((event) => event.value)).toEqual([{ type: 'one' }, { type: 'two' }]);
    expect(frameAll(input, roomy).map((line) => ndjsonEvent(line)?.kind)).toEqual([
      undefined,
      undefined,
      undefined,
      'json',
      undefined,
      'json',
      undefined,
    ]);
  });

  it('ignores empty and whitespace-only lines with any terminator', () => {
    const events = eventsOf(encode('\r\n   \r\t\n{"type":"one"}\n  '));

    expect(events.map((event) => event.line)).toEqual([4]);
    expect(events.map((event) => event.unterminated)).toEqual([false]);
  });

  it('ignores empty and whitespace-only lines in the edge-case fixture', () => {
    const events = eventsOf(edgeCases);

    expect(events.map((event) => event.line)).toEqual([1, 4, 5, 6, 7]);
  });

  it('reports a malformed line with its line number, offset and message and continues', () => {
    const events = eventsOf(edgeCases);
    const malformed = events.filter((event) => event.kind === 'malformed');

    expect(malformed).toHaveLength(1);
    const broken = eventAt(malformed, 0);
    expect(broken.line).toBe(4);
    expect(broken.offset).toBe(brokenOffset);
    expect(broken.length).toBe(brokenLength);
    expect(broken.value).toBe(brokenText);
    expect(broken.error).toBeTypeOf('string');
    expect(broken.error).not.toBe('');
    const parsed = parseJson(brokenText);
    expect(parsed.ok).toBe(false);
    expect(broken.error).toBe(parsed.ok ? undefined : parsed.message);
    expect(broken.sse).toBeUndefined();
    expect(broken.marker).toBeUndefined();
    expect(broken.unterminated).toBe(false);

    const next = eventAt(events, events.indexOf(broken) + 1);
    expect(next.kind).toBe('json');
    expect(next.line).toBe(5);
    expect(next.offset).toBe(brokenOffset + brokenLength);
  });

  it('reports every malformed line and keeps the event order', () => {
    const events = eventsOf(encode('{bad\n{"ok":1}\nnot json\n{"ok":2}\n'));

    expect(events.map((event) => event.kind)).toEqual(['malformed', 'json', 'malformed', 'json']);
    expect(events.map((event) => event.line)).toEqual([1, 2, 3, 4]);
    expect(events.map((event) => event.offset)).toEqual([0, 5, 14, 23]);
    expect(events.map((event) => event.value)).toEqual(['{bad', { ok: 1 }, 'not json', { ok: 2 }]);
    expect(events.map((event) => event.error === undefined)).toEqual([false, true, false, true]);
  });

  it('treats any JSON value on a line as a json event', () => {
    const events = eventsOf(encode('42\n"text"\nnull\ntrue\n[]\n  {"type":"padded"}  \n'));

    expect(events.map((event) => event.kind)).toEqual(Array<string>(6).fill('json'));
    expect(events.map((event) => event.value)).toEqual([
      42,
      'text',
      null,
      true,
      [],
      { type: 'padded' },
    ]);
  });

  it('keeps the digits of a big integer', () => {
    const big = eventAt(eventsOf(edgeCases), 2);

    expect(big.kind).toBe('json');
    expect(big.line).toBe(5);
    expect(big.value).toEqual({ type: 'big', id: 12345678901234567890n });
  });

  it('flags an unterminated final line', () => {
    const events = eventsOf(edgeCases);
    const unterminated = events.filter((event) => event.unterminated);

    expect(unterminated).toHaveLength(1);
    expect(eventAt(unterminated, 0).value).toEqual({ type: 'last' });
    expect(eventAt(unterminated, 0).line).toBe(7);
    expect(events.map((event) => event.unterminated)).toEqual([false, false, false, false, true]);
  });

  it('flags an unterminated malformed final line', () => {
    const events = eventsOf(encode('{"type":"first"}\n{"type":"cut"'));

    expect(events.map((event) => event.kind)).toEqual(['json', 'malformed']);
    expect(events.map((event) => event.unterminated)).toEqual([false, true]);
  });

  it('treats a final lone CR as a terminator', () => {
    const events = eventsOf(encode('{"n":1}\r'));

    expect(events).toHaveLength(1);
    expect(eventAt(events, 0).unterminated).toBe(false);
  });

  it('reads LF, CRLF and lone CR terminators alike', () => {
    let offset = 0;
    const expected = terminatorPieces.map(([text, terminator], index) => {
      const length = encode(`${text}${terminator}`).length;
      const entry = { offset, length, line: index + 1, value: { n: index + 1 } };
      offset += length;
      return entry;
    });

    const events = eventsOf(encode(terminatorInput));

    expect(
      events.map((event) => ({
        offset: event.offset,
        length: event.length,
        line: event.line,
        value: event.value,
      })),
    ).toEqual(expected);
    expect(events.map((event) => event.unterminated)).toEqual([false, false, false, false]);
  });

  it('joins a CR at the end of one chunk with an LF at the start of the next', () => {
    const lines = frameChunks([encode('{"n":1}\r'), encode('\n{"n":2}\n')], roomy);
    const events = interpret(lines);

    expect(events.map((event) => event.line)).toEqual([1, 2]);
    expect(events.map((event) => event.offset)).toEqual([0, 9]);
    expect(events.map((event) => event.length)).toEqual([9, 8]);
  });

  it('parses the first line after a byte-order mark', () => {
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...encode('{"type":"first"}\n')]);
    const lines = frameAll(bytes, roomy);
    const events = interpret(lines);

    expect(events).toHaveLength(1);
    expect(eventAt(events, 0).kind).toBe('json');
    expect(eventAt(events, 0).value).toEqual({ type: 'first' });
    expect(eventAt(events, 0).offset).toBe(lines[0]?.offset);
  });

  it('turns an oversize line into an oversize event with a preview', () => {
    expect(encode(oversizeLine)).toHaveLength(100);
    const lines = frameAll(encode(oversizeInput), oversizeLimit);
    const events = interpret(lines);

    expect(events).toHaveLength(2);
    const huge = eventAt(events, 0);
    expect(huge).toStrictEqual({
      offset: 0,
      length: 101,
      line: 1,
      kind: 'oversize',
      value: expect.any(String) as unknown,
      sse: undefined,
      marker: undefined,
      error: undefined,
      unterminated: false,
    });
    const preview = textOf(huge);
    expect(preview).not.toBe('');
    expect(oversizeLine.startsWith(preview)).toBe(true);
    expect(preview).toBe(oversizeLineAt(lines, 0).preview);

    const after = eventAt(events, 1);
    expect(after.kind).toBe('json');
    expect(after.value).toEqual({ type: 'after' });
    expect(after.line).toBe(2);
    expect(after.offset).toBe(101);
    expect(after.error).toBeUndefined();
  });

  it('flags an unterminated oversize final line', () => {
    const events = eventsOf(encode(`{"type":"ok"}\n${oversizeLine}`), oversizeLimit);

    expect(events.map((event) => event.kind)).toEqual(['json', 'oversize']);
    expect(events.map((event) => event.unterminated)).toEqual([false, true]);
  });
});

describe('ndjsonEvent at every byte boundary', () => {
  const cases: readonly (readonly [
    name: string,
    bytes: Uint8Array,
    maxLineBytes: number,
    count: number,
  ])[] = [
    ['ag-ui.ndjson', fixtureBytes('ag-ui.ndjson'), roomy, 8],
    ['edge-cases.ndjson', edgeCases, roomy, 5],
    ['mixed terminators ending in a CR', encode(terminatorInput), roomy, 4],
    [
      'a leading byte-order mark',
      Uint8Array.from([0xef, 0xbb, 0xbf, ...encode('{"type":"first"}\n{"type":"second"}')]),
      roomy,
      2,
    ],
    [
      'an oversize line between two json lines',
      encode(`{"type":"ok"}\n${oversizeLine}\n{"type":"after"}`),
      oversizeLimit,
      3,
    ],
  ];

  it.each(cases)('gives identical events for every chunking of %s', (_name, bytes, max, count) => {
    const expected = eventsOf(bytes, max);

    expect(expected).toHaveLength(count);
    for (const chunks of everySplit(bytes)) {
      const sizes = chunks.map((chunk) => chunk.length).join('+');
      expect(interpret(frameChunks(chunks, max)), `chunks ${sizes}`).toStrictEqual(expected);
    }
  });
});
