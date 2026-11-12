import { createParser } from 'eventsource-parser';
import { describe, expect, it } from 'vitest';
import { everySplit } from '../../support/chunks';
import { streamFixtures } from '../../support/stream-fixtures';
import type { JsonValue, ParsedEvent } from '../../../src/events/model';
import { LineFramer, type FramedLine } from '../../../src/streaming/framer';
import { parseJson } from '../../../src/streaming/json';
import { previewBytes } from '../../../src/streaming/limits';
import { SseInterpreter } from '../../../src/streaming/sse';

interface Range {
  offset: number;
  length: number;
}

interface Position extends Range {
  line: number;
}

interface Outcome {
  events: ParsedEvent[];
  discarded: Range | undefined;
}

interface Limits {
  maxEventBytes: number;
  maxLineBytes: number;
}

interface Comparable {
  event: string | undefined;
  id: string | undefined;
  value: JsonValue;
}

const roomy: Limits = { maxEventBytes: 4096, maxLineBytes: 4096 };
const tight: Limits = { maxEventBytes: 32, maxLineBytes: 32 };
const bomLength = 3;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

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

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`Nothing at index ${String(index)}`);
  }
  return item;
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

function run(chunks: readonly Uint8Array[], limits: Limits = roomy): Outcome {
  const interpreter = new SseInterpreter(limits.maxEventBytes);
  const events: ParsedEvent[] = [];
  for (const line of frameChunks(chunks, limits.maxLineBytes)) {
    const event = interpreter.line(line);
    if (event !== undefined) {
      events.push(event);
    }
  }
  return { events, discarded: interpreter.end() };
}

function outcomeOf(text: string, limits: Limits = roomy): Outcome {
  return run([encode(text)], limits);
}

function eventsOf(text: string, limits: Limits = roomy): ParsedEvent[] {
  return outcomeOf(text, limits).events;
}

function dataEventsOf(text: string, limits: Limits = roomy): ParsedEvent[] {
  return eventsOf(text, limits).filter((event) => event.kind !== 'comment');
}

function perLine(text: string, limits: Limits = roomy): (ParsedEvent | undefined)[] {
  const interpreter = new SseInterpreter(limits.maxEventBytes);
  return frameChunks([encode(text)], limits.maxLineBytes).map((line) => interpreter.line(line));
}

function fields(
  event?: string,
  id?: string,
  retry?: number,
): { event: string | undefined; id: string | undefined; retry: number | undefined } {
  return { event, id, retry };
}

function position(event: ParsedEvent): Position {
  return { offset: event.offset, length: event.length, line: event.line };
}

function values(events: readonly ParsedEvent[]): JsonValue[] {
  return events.map((event) => event.value);
}

function textOf(event: ParsedEvent): string {
  if (typeof event.value !== 'string') {
    throw new Error('Expected a text value');
  }
  return event.value;
}

function typeField(value: JsonValue): JsonValue | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return (value as { readonly [key: string]: JsonValue })['type'];
  }
  return undefined;
}

function blockRanges(blocks: readonly string[], start: number): Position[] {
  let offset = start;
  let line = 1;
  return blocks.map((block) => {
    const range = { offset, length: encode(block).length, line };
    offset += range.length;
    line += block.split(/\r\n|\r|\n/).length - 1;
    return range;
  });
}

function referenceMessages(bytes: Uint8Array): Comparable[] {
  const messages: Comparable[] = [];
  const parser = createParser({
    onEvent: (message) => {
      const parsed = parseJson(message.data);
      messages.push({
        event: message.event,
        id: message.id,
        value: parsed.ok ? parsed.value : message.data,
      });
    },
  });
  parser.feed(new TextDecoder().decode(bytes));
  parser.reset({ consume: true });
  return messages;
}

function comparable(events: readonly ParsedEvent[]): Comparable[] {
  return events
    .filter((event) => event.kind === 'json' || event.kind === 'text')
    .map((event) => ({ event: event.sse?.event, id: event.sse?.id, value: event.value }));
}

const edgeCases = fixtureBytes('edge-cases.sse');
const edgeBlocks = [
  ': keep-alive\ndata: line one\ndata: line two\r\ndata: line three\r\r\n',
  'data:no-space\n\n',
  'id: a\0b\ndata: {"type":"with-null-id"}\n\n',
  'retry: 10a\nretry: 3000\ndata: retried\n\n',
  'event: error\r\ndata: {"type":"error","message":"synthetic failure"}\r\n\r\n',
  'data\n\n',
  'id: 7\n\n',
  'data: café ✓ 🚀\r\r',
  'data: partial\n',
];
const edgeRanges = blockRanges(edgeBlocks, bomLength);
const dispatchedBlocks = [0, 1, 2, 3, 4, 5, 7];
const sseFixtures = streamFixtures.filter((fixture) => fixture.format === 'sse');

const tightPayloads = Array.from({ length: 10 }, (_, index) => String(index).repeat(3));
const tightBlock = `${tightPayloads.map((payload) => `data: ${payload}\n`).join('')}\n`;
const afterEvent = 'data: {"type":"after"}\n\n';
const hugeLine = `data: ${'x'.repeat(100)}\n`;

describe('SseInterpreter', () => {
  it('describes the edge-case fixture as its blocks', () => {
    expect(`﻿${edgeBlocks.join('')}`).toBe(decoder.decode(edgeCases));
    expect(edgeRanges.map((range) => range.line)).toEqual([1, 6, 8, 11, 15, 18, 20, 22, 24]);
  });

  it('dispatches events at blank lines with WHATWG field rules', () => {
    const dispatched = run([edgeCases]).events.filter((event) => event.kind !== 'comment');

    expect(dispatched.map((event) => event.kind)).toEqual([
      'text',
      'text',
      'json',
      'text',
      'json',
      'text',
      'text',
    ]);
    expect(values(dispatched)).toEqual([
      'line one\nline two\nline three',
      'no-space',
      { type: 'with-null-id' },
      'retried',
      { type: 'error', message: 'synthetic failure' },
      '',
      'café ✓ 🚀',
    ]);
    expect(dispatched.map((event) => event.sse)).toStrictEqual([
      fields(),
      fields(),
      fields(),
      fields(undefined, undefined, 3000),
      fields('error'),
      fields(),
      fields(),
    ]);
    expect(dispatched.map(position)).toEqual(
      dispatchedBlocks.map((index) => at(edgeRanges, index)),
    );
    expect(dispatched.map((event) => event.line)).toEqual([1, 6, 8, 11, 15, 18, 22]);
  });

  it('gives the first fixture event the offset, length and line of its whole block', () => {
    const first = at(run([edgeCases]).events, 1);
    const block = at(edgeRanges, 0);

    expect(block.offset).toBe(bomLength);
    expect(decoder.decode(edgeCases.subarray(block.offset, block.offset + block.length))).toBe(
      at(edgeBlocks, 0),
    );
    expect(first).toStrictEqual({
      offset: bomLength,
      length: block.length,
      line: 1,
      kind: 'text',
      value: 'line one\nline two\nline three',
      sse: fields(),
      marker: undefined,
      error: undefined,
      unterminated: false,
    });
  });

  it('dispatches nothing for a block without data', () => {
    const inputs = ['id: 1\n\n', 'event: a\n\n', 'retry: 5\n\n', 'foo: x\n\n', 'data_: x\n\n'];
    for (const input of inputs) {
      expect(outcomeOf(`${input}${input}`), JSON.stringify(input)).toStrictEqual({
        events: [],
        discarded: undefined,
      });
    }
    expect(dataEventsOf('id: 5\n\ndata: x\n\n').map((event) => event.sse)).toStrictEqual([
      fields(),
    ]);
  });

  it('ignores blank lines before and between events', () => {
    const events = eventsOf('\n\n\ndata: x\n\n\n\n\ndata: y\n\n');

    expect(events.map(position)).toEqual([
      { offset: 3, length: 9, line: 4 },
      { offset: 15, length: 9, line: 9 },
    ]);
    expect(values(events)).toEqual(['x', 'y']);
  });

  it('ignores a blank line made of any terminator before the first event', () => {
    const events = eventsOf('\n\r\n\rdata: x\n\n');

    expect(events.map(position)).toEqual([{ offset: 4, length: 9, line: 4 }]);
  });

  it('removes only the final newline from joined data', () => {
    expect(values(eventsOf('data: a\n\n'))).toEqual(['a']);
    expect(values(eventsOf('data: a\ndata: b\n\n'))).toEqual(['a\nb']);
    expect(values(eventsOf('data:\ndata:\n\n'))).toEqual(['\n']);
  });

  const valueCases: readonly (readonly [name: string, input: string, value: string])[] = [
    ['removes one leading space', 'data: x\n\n', 'x'],
    ['keeps a value without a space', 'data:x\n\n', 'x'],
    ['keeps the second leading space', 'data:  x\n\n', ' x'],
    ['keeps a leading tab', 'data:\tx\n\n', '\tx'],
    ['keeps trailing spaces', 'data: x \n\n', 'x '],
    ['splits at the first colon only', 'data: a: b\n\n', 'a: b'],
    ['reads an empty value after the colon', 'data:\n\n', ''],
    ['reads a line without a colon as an empty value', 'data\n\n', ''],
  ];

  it.each(valueCases)('parses the data value: %s', (_name, input, value) => {
    const events = eventsOf(input);

    expect(events).toHaveLength(1);
    expect(at(events, 0).kind).toBe('text');
    expect(at(events, 0).value).toBe(value);
  });

  it('ignores unknown fields and fields whose name differs in case or spacing', () => {
    const input = 'Data: x\n\nDATA: x\n\ndata : x\n\n data: x\n\nfoo: bar\n\nfoo\n\n';

    expect(outcomeOf(input)).toStrictEqual({ events: [], discarded: undefined });
  });

  it('ignores unknown fields inside a block with data', () => {
    const events = eventsOf('foo: bar\ndata: x\nbaz\n\n');

    expect(events).toHaveLength(1);
    expect(at(events, 0).value).toBe('x');
    expect(at(events, 0).sse).toStrictEqual(fields());
  });

  const fieldCases: readonly (readonly [
    name: string,
    input: string,
    sse: ReturnType<typeof fields>,
  ])[] = [
    ['an id', 'id: 1\ndata: x\n\n', fields(undefined, '1')],
    ['an id without a space', 'id:a b\ndata: x\n\n', fields(undefined, 'a b')],
    ['an empty id', 'id:\ndata: x\n\n', fields(undefined, '')],
    ['an id line without a colon', 'id\ndata: x\n\n', fields(undefined, '')],
    ['the last of two ids', 'id: 1\nid: 2\ndata: x\n\n', fields(undefined, '2')],
    ['an id with a null character', 'id: a\u0000b\ndata: x\n\n', fields()],
    [
      'an earlier id kept after a null id',
      'id: 1\nid: a\u0000b\ndata: x\n\n',
      fields(undefined, '1'),
    ],
    ['an event type', 'event: ping\ndata: x\n\n', fields('ping')],
    ['the last of two event types', 'event: a\nevent: b\ndata: x\n\n', fields('b')],
    ['an id after the data', 'data: x\nid: late\n\n', fields(undefined, 'late')],
    ['a retry', 'retry: 3000\ndata: x\n\n', fields(undefined, undefined, 3000)],
    ['a zero retry', 'retry:0\ndata: x\n\n', fields(undefined, undefined, 0)],
    ['a retry with leading zeros', 'retry: 007\ndata: x\n\n', fields(undefined, undefined, 7)],
    ['a retry with letters', 'retry: 10a\ndata: x\n\n', fields()],
    ['a negative retry', 'retry: -5\ndata: x\n\n', fields()],
    ['a fractional retry', 'retry: 1.5\ndata: x\n\n', fields()],
    ['a retry with a second leading space', 'retry:  5\ndata: x\n\n', fields()],
    ['an empty retry', 'retry:\ndata: x\n\n', fields()],
    ['a retry line without a colon', 'retry\ndata: x\n\n', fields()],
    ['a retry with non-ASCII digits', 'retry: ١٢٣\ndata: x\n\n', fields()],
    [
      'a valid retry kept after an invalid one',
      'retry: 5\nretry: 10a\ndata: x\n\n',
      fields(undefined, undefined, 5),
    ],
    [
      'the last of two valid retries',
      'retry: 5\nretry: 6\ndata: x\n\n',
      fields(undefined, undefined, 6),
    ],
    ['all three fields', 'id: 9\nevent: e\nretry: 4\ndata: x\n\n', fields('e', '9', 4)],
  ];

  it.each(fieldCases)('reads %s', (_name, input, sse) => {
    const events = eventsOf(input);

    expect(events).toHaveLength(1);
    expect(at(events, 0).sse).toStrictEqual(sse);
  });

  it('reports comments as comment events', () => {
    const comment = at(run([edgeCases]).events, 0);

    expect(comment).toStrictEqual({
      offset: bomLength,
      length: encode(': keep-alive\n').length,
      line: 1,
      kind: 'comment',
      value: 'keep-alive',
      sse: undefined,
      marker: undefined,
      error: undefined,
      unterminated: false,
    });
  });

  it('removes only one leading space from a comment', () => {
    const inputs: readonly (readonly [string, string])[] = [
      [':x\n', 'x'],
      [': x\n', 'x'],
      [':  x\n', ' x'],
      [':\n', ''],
      [': a: b\n', 'a: b'],
    ];
    for (const [input, value] of inputs) {
      const [only] = eventsOf(input);
      expect(only?.kind, JSON.stringify(input)).toBe('comment');
      expect(only?.value, JSON.stringify(input)).toBe(value);
    }
  });

  it('returns a comment immediately and keeps the block it sits in open', () => {
    const results = perLine('data: a\n: ping\ndata: b\n\n');

    expect(results.map((event) => event?.kind)).toEqual([undefined, 'comment', undefined, 'text']);
    expect(at(results, 1)).toMatchObject({ offset: 8, length: 7, line: 2, value: 'ping' });
    expect(at(results, 3)).toMatchObject({ offset: 0, length: 24, line: 1, value: 'a\nb' });
  });

  it('keeps comment events and data events in stream order', () => {
    const events = eventsOf(': one\ndata: a\n\n: two\n\ndata: b\n: three\n\n');

    expect(events.map((event) => event.kind)).toEqual([
      'comment',
      'text',
      'comment',
      'comment',
      'text',
    ]);
    expect(values(events)).toEqual(['one', 'a', 'two', 'three', 'b']);
  });

  it('starts the next block after a comment-only block', () => {
    const events = eventsOf(': ping\n\ndata: x\n\n');

    expect(events.map(position)).toEqual([
      { offset: 0, length: 7, line: 1 },
      { offset: 8, length: 9, line: 3 },
    ]);
  });

  it('flags an unterminated comment', () => {
    const events = eventsOf('data: a\n\n: tail');

    expect(events.map((event) => event.kind)).toEqual(['text', 'comment']);
    expect(events.map((event) => event.unterminated)).toEqual([false, true]);
    expect(at(events, 1).value).toBe('tail');
    expect(outcomeOf('data: a\n\n: tail').discarded).toBeUndefined();
  });

  it('marks [DONE] and error events', () => {
    const chat = run([fixtureBytes('openai-chat.sse')]).events;

    expect(chat.map((event) => event.kind)).toEqual(['json', 'json', 'json', 'text']);
    expect(chat.map((event) => event.marker)).toEqual([undefined, undefined, undefined, 'done']);
    expect(at(chat, 3).value).toBe('[DONE]');

    const edge = run([edgeCases]).events;
    expect(edge.map((event) => event.marker)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'error',
      undefined,
      undefined,
    ]);
    const failure = at(edge, 5);
    expect(failure.kind).toBe('json');
    expect(failure.value).toEqual({ type: 'error', message: 'synthetic failure' });
    expect(failure.sse).toStrictEqual(fields('error'));
  });

  it('prefers the error marker and marks [DONE] under any event type', () => {
    expect(at(eventsOf('event: error\ndata: [DONE]\n\n'), 0).marker).toBe('error');
    expect(at(eventsOf('event: error\ndata: not json\n\n'), 0).marker).toBe('error');
    expect(at(eventsOf('event: message\ndata: [DONE]\n\n'), 0).marker).toBe('done');
  });

  it('marks only data that is exactly [DONE]', () => {
    const inputs = [
      'data: [DONE]\ndata: more\n\n',
      'data: [DONE] \n\n',
      'data: "[DONE]"\n\n',
      'data: [done]\n\n',
      'data: x [DONE]\n\n',
      'event: message\ndata: x\n\n',
    ];
    for (const input of inputs) {
      expect(at(eventsOf(input), 0).marker, JSON.stringify(input)).toBeUndefined();
    }
  });

  it('records each block own id and event type', () => {
    const events = run([edgeCases]).events;
    const afterIdBlock = at(events, 7);

    expect(afterIdBlock.line).toBe(22);
    expect(afterIdBlock.sse?.id).toBeUndefined();
    expect(afterIdBlock.sse).toStrictEqual(fields());
    expect(at(events, 6).sse).toStrictEqual(fields());
    expect(at(events, 5).sse?.event).toBe('error');
  });

  it('does not carry id, event type or retry into the next block', () => {
    const events = eventsOf('id: 1\nevent: a\nretry: 5\ndata: x\n\ndata: y\n\n');

    expect(events.map((event) => event.sse)).toStrictEqual([fields('a', '1', 5), fields()]);
  });

  it('does not carry the fields of a block without data into the next block', () => {
    const events = eventsOf('id: 5\nevent: z\nretry: 9\n\ndata: x\n\n');

    expect(events.map((event) => event.sse)).toStrictEqual([fields()]);
  });

  it('reads the event type of named events', () => {
    for (const name of ['openai-responses.sse', 'anthropic.sse']) {
      const events = run([fixtureBytes(name)]).events;

      expect(events.length, name).toBeGreaterThan(0);
      for (const event of events) {
        expect(event.kind, name).toBe('json');
        expect(event.sse?.event, name).toBe(typeField(event.value));
        expect(event.sse?.id, name).toBeUndefined();
        expect(event.marker, name).toBeUndefined();
      }
    }
  });

  it('reports data that is not JSON as a text event and keeps going', () => {
    const input = 'data: {"type":"broken",\n\ndata: {"type":"ok"}\n\n';
    const events = eventsOf(input);

    expect(events.map((event) => event.kind)).toEqual(['text', 'json']);
    expect(values(events)).toEqual(['{"type":"broken",', { type: 'ok' }]);
    expect(events.map((event) => event.error)).toEqual([undefined, undefined]);
    expect(events.map(position)).toEqual([
      { offset: 0, length: encode('data: {"type":"broken",\n\n').length, line: 1 },
      {
        offset: encode('data: {"type":"broken",\n\n').length,
        length: encode('data: {"type":"ok"}\n\n').length,
        line: 3,
      },
    ]);
  });

  it('parses joined multi-line data as JSON', () => {
    const events = eventsOf('data: {\ndata:   "n": 1\ndata: }\n\n');

    expect(events).toHaveLength(1);
    expect(at(events, 0).kind).toBe('json');
    expect(at(events, 0).value).toEqual({ n: 1 });
  });

  it('turns any JSON value into a json event', () => {
    const events = eventsOf(
      'data: 42\n\ndata: "s"\n\ndata: null\n\ndata: true\n\ndata: [1,2]\n\ndata: {"id":12345678901234567890}\n\n',
    );

    expect(events.map((event) => event.kind)).toEqual(Array<string>(6).fill('json'));
    expect(values(events)).toEqual([42, 's', null, true, [1, 2], { id: 12345678901234567890n }]);
  });

  it('keeps the order of events', () => {
    const events = eventsOf('data: 1\n\ndata: 2\n\ndata: 3\n\ndata: 4\n\n');

    expect(values(events)).toEqual([1, 2, 3, 4]);
    expect(events.map((event) => event.offset)).toEqual([0, 9, 18, 27]);
    expect(events.map((event) => event.line)).toEqual([1, 3, 5, 7]);
  });

  it('reads LF, CRLF and lone CR terminators alike', () => {
    const events = eventsOf('data: a\n\ndata: b\r\n\r\ndata: c\r\r');

    expect(events.map(position)).toEqual([
      { offset: 0, length: 9, line: 1 },
      { offset: 9, length: 11, line: 3 },
      { offset: 20, length: 9, line: 5 },
    ]);
    expect(values(events)).toEqual(['a', 'b', 'c']);
    expect(events.map((event) => event.unterminated)).toEqual([false, false, false]);
  });

  it('reads blocks that use only lone CR terminators', () => {
    const events = eventsOf('data: a\r\rdata: b\r\r');

    expect(events.map(position)).toEqual([
      { offset: 0, length: 9, line: 1 },
      { offset: 9, length: 9, line: 3 },
    ]);
    expect(values(events)).toEqual(['a', 'b']);
  });

  it('joins a CR at the end of one chunk with an LF at the start of the next', () => {
    const splits: readonly (readonly string[])[] = [
      ['data: a\r\n\r', '\ndata: b\r\n\r\n'],
      ['data: a\r', '\n\r\ndata: b\r\n\r\n'],
      ['data: a\r\n', '\r', '\ndata: b\r\n\r', '\n'],
    ];
    for (const chunks of splits) {
      const events = run(chunks.map(encode)).events;

      expect(events.map(position), JSON.stringify(chunks)).toEqual([
        { offset: 0, length: 11, line: 1 },
        { offset: 11, length: 11, line: 3 },
      ]);
      expect(values(events)).toEqual(['a', 'b']);
    }
  });

  it('skips a leading byte-order mark and counts offsets from the bytes', () => {
    const events = run([encode('﻿data: x\n\n')]).events;

    expect(events.map(position)).toEqual([{ offset: bomLength, length: 9, line: 1 }]);
    expect(values(events)).toEqual(['x']);
  });

  it('reports an incomplete final event as discarded', () => {
    const outcome = run([edgeCases]);
    const partial = at(edgeRanges, 8);

    expect(partial.length).toBe(encode('data: partial\n').length);
    expect(outcome.discarded).toStrictEqual({ offset: partial.offset, length: partial.length });
    expect(outcome.discarded).toStrictEqual({
      offset: edgeCases.length - encode('data: partial\n').length,
      length: encode('data: partial\n').length,
    });
    expect(values(outcome.events)).not.toContain('partial');
  });

  it('reports a final block without any terminator as discarded', () => {
    const outcome = outcomeOf('data: a\n\ndata: tail');

    expect(values(outcome.events)).toEqual(['a']);
    expect(outcome.discarded).toStrictEqual({ offset: 9, length: 10 });
  });

  it('covers every line of an incomplete block when reporting it as discarded', () => {
    expect(outcomeOf('data: a\ndata: b\n').discarded).toStrictEqual({ offset: 0, length: 16 });
    expect(outcomeOf('id: 1\ndata: a\nevent: x\n').discarded).toStrictEqual({
      offset: 0,
      length: 23,
    });
    expect(outcomeOf('\n\ndata: a\r').discarded).toStrictEqual({ offset: 2, length: 8 });
  });

  it('starts a discarded block at its first line, even when that is a comment', () => {
    const outcome = outcomeOf('data: z\n\n: c\ndata: x\n');

    expect(outcome.events.map((event) => event.kind)).toEqual(['text', 'comment']);
    expect(outcome.discarded).toStrictEqual({ offset: 9, length: 12 });
  });

  it('counts a leading byte-order mark out of the discarded range', () => {
    expect(run([encode('﻿data: a\n')]).discarded).toStrictEqual({
      offset: bomLength,
      length: 8,
    });
  });

  it('discards nothing when the stream ends at a blank line or in a block without data', () => {
    const inputs = [
      '',
      'data: a\n\n',
      'data: a\r\r',
      'id: 1\n',
      'event: x\nretry: 5\n',
      ': c\n',
      '\n\n',
    ];
    for (const input of inputs) {
      expect(outcomeOf(input).discarded, JSON.stringify(input)).toBeUndefined();
    }
  });

  it('starts a fresh block after each blank line', () => {
    const outcome = outcomeOf('data: a\n\nid: 1\n');

    expect(values(outcome.events)).toEqual(['a']);
    expect(outcome.discarded).toBeUndefined();
  });
});

describe('SseInterpreter size limits', () => {
  it('turns an event over the size limit into one oversize event', () => {
    expect(
      encode(
        at(
          tightPayloads.map((payload) => `data: ${payload}\n`),
          0,
        ),
      ),
    ).toHaveLength(10);
    const events = eventsOf(`${tightBlock}${afterEvent}`, tight);

    expect(events).toHaveLength(2);
    const huge = at(events, 0);
    expect(huge).toMatchObject({
      offset: 0,
      length: encode(tightBlock).length,
      line: 1,
      kind: 'oversize',
      error: undefined,
      unterminated: false,
    });
    expect(encode(tightBlock)).toHaveLength(101);
    const preview = textOf(huge);
    expect(preview).not.toBe('');
    expect(preview.startsWith('000')).toBe(true);
    expect(`${tightPayloads.join('\n')}\n`.startsWith(preview)).toBe(true);

    const after = at(events, 1);
    expect(after.kind).toBe('json');
    expect(after.value).toEqual({ type: 'after' });
    expect(after.error).toBeUndefined();
    expect(after.offset).toBe(101);
    expect(after.line).toBe(12);
    expect(after.length).toBe(encode(afterEvent).length);
    expect(after.sse).toStrictEqual(fields());
  });

  it('keeps a block whose data lines add up to exactly the limit', () => {
    const events = eventsOf(`data: ${'a'.repeat(9)}\ndata: ${'b'.repeat(9)}\n\n`, tight);

    expect(events).toHaveLength(1);
    expect(at(events, 0).kind).toBe('text');
    expect(at(events, 0).value).toBe(`${'a'.repeat(9)}\n${'b'.repeat(9)}`);
  });

  it('turns a block one byte over the limit into an oversize event', () => {
    const events = eventsOf(`data: ${'a'.repeat(9)}\ndata: ${'b'.repeat(10)}\n\n`, tight);

    expect(events).toHaveLength(1);
    expect(at(events, 0).kind).toBe('oversize');
    expect(at(events, 0).offset).toBe(0);
    expect(at(events, 0).length).toBe(16 + 17 + 1);
    expect(textOf(at(events, 0))).not.toBe('');
  });

  it('counts only data lines toward the size limit', () => {
    const input = `event: ${'e'.repeat(16)}\nid: ${'i'.repeat(20)}\nfoo: ${'f'.repeat(20)}\ndata: x\n\n`;
    const events = eventsOf(input, tight);

    expect(events).toHaveLength(1);
    expect(at(events, 0).kind).toBe('text');
    expect(at(events, 0).value).toBe('x');
    expect(at(events, 0).sse).toStrictEqual(fields('e'.repeat(16), 'i'.repeat(20)));
  });

  it('drops data that arrives after the block went over the limit', () => {
    const events = eventsOf(`${tightBlock.slice(0, 40)}data: zzz\n\n${afterEvent}`, tight);

    expect(events.map((event) => event.kind)).toEqual(['oversize', 'json']);
    expect(textOf(at(events, 0))).not.toContain('zzz');
    expect(at(events, 0).length).toBe(40 + 10 + 1);
  });

  it('cuts the preview of an oversize event to the preview limit', () => {
    const payload = 'a'.repeat(2000);
    const input = `data: ${payload}\ndata: ${payload}\ndata: ${payload}\n\n`;
    const events = eventsOf(input, { maxEventBytes: 4096, maxLineBytes: 8192 });

    expect(events).toHaveLength(1);
    expect(at(events, 0).kind).toBe('oversize');
    expect(at(events, 0).value).toBe('a'.repeat(previewBytes));
    expect(at(events, 0).length).toBe(encode(input).length);
  });

  it('does not let an oversize block leak its fields into the next block', () => {
    const events = eventsOf(`id: 9\nevent: z\nretry: 7\n${tightBlock}data: ok\n\n`, tight);

    expect(events.map((event) => event.kind)).toEqual(['oversize', 'text']);
    expect(at(events, 1).sse).toStrictEqual(fields());
    expect(at(events, 1).value).toBe('ok');
  });

  it('parses the block after an oversize block with its own fields', () => {
    const events = eventsOf(`${tightBlock}id: 2\nevent: e\nretry: 7\ndata: ok\n\n`, tight);

    expect(events.map((event) => event.kind)).toEqual(['oversize', 'text']);
    expect(at(events, 1).sse).toStrictEqual(fields('e', '2', 7));
  });

  it('turns an oversize framed line at the start of a block into one oversize event', () => {
    const input = `${hugeLine}\n${afterEvent}`;
    const lines = frameChunks([encode(input)], tight.maxLineBytes);
    const events = eventsOf(input, tight);

    expect(at(lines, 0).kind).toBe('oversize');
    expect(events).toHaveLength(2);
    expect(at(events, 0)).toMatchObject({
      offset: 0,
      length: encode(hugeLine).length + 1,
      line: 1,
      kind: 'oversize',
      error: undefined,
      unterminated: false,
    });
    expect(at(events, 0).value).toBe('x'.repeat(tight.maxLineBytes - 'data: '.length));

    const after = at(events, 1);
    expect(after.kind).toBe('json');
    expect(after.value).toEqual({ type: 'after' });
    expect(after.offset).toBe(encode(hugeLine).length + 1);
    expect(after.line).toBe(3);
  });

  it('turns an oversize framed line after data into one oversize event', () => {
    const input = `data: aaa\n${hugeLine}data: ccc\n\n${afterEvent}`;
    const events = eventsOf(input, tight);

    expect(events.map((event) => event.kind)).toEqual(['oversize', 'json']);
    expect(at(events, 0).offset).toBe(0);
    expect(at(events, 0).length).toBe(encode(`data: aaa\n${hugeLine}data: ccc\n\n`).length);
    expect(at(events, 0).line).toBe(1);
    const preview = textOf(at(events, 0));
    expect(preview).not.toBe('');
    expect(preview.startsWith('aaa')).toBe(true);
    expect(at(events, 1).value).toEqual({ type: 'after' });
  });

  it('turns an oversize framed line of another field into one oversize event', () => {
    const input = `id: ${'i'.repeat(100)}\n\n${afterEvent}`;
    const events = eventsOf(input, tight);

    expect(events.map((event) => event.kind)).toEqual(['oversize', 'json']);
    expect(at(events, 0).offset).toBe(0);
    expect(at(events, 0).length).toBe(encode(`id: ${'i'.repeat(100)}\n\n`).length);
    expect(textOf(at(events, 0))).not.toBe('');
    expect(at(events, 1).sse).toStrictEqual(fields());
  });

  it('reports an oversize block without a blank line as discarded', () => {
    const outcome = outcomeOf(tightBlock.slice(0, 50), tight);

    expect(outcome.events).toEqual([]);
    expect(outcome.discarded).toStrictEqual({ offset: 0, length: 50 });
  });

  it('reports an oversize framed line without a blank line as discarded', () => {
    const outcome = outcomeOf(`data: a\n\n${hugeLine}`, tight);

    expect(values(outcome.events)).toEqual(['a']);
    expect(outcome.discarded).toStrictEqual({ offset: 9, length: encode(hugeLine).length });
  });

  it('parses normally again after the oversize block has been dispatched', () => {
    const input = `${tightBlock}${afterEvent}${tightBlock}${afterEvent}`;
    const events = eventsOf(input, tight);

    expect(events.map((event) => event.kind)).toEqual(['oversize', 'json', 'oversize', 'json']);
    expect(events.map((event) => event.offset)).toEqual([0, 101, 101 + 24, 101 + 24 + 101]);
  });
});

describe('SseInterpreter against eventsource-parser', () => {
  it('matches eventsource-parser on every SSE fixture', () => {
    expect(sseFixtures.length).toBeGreaterThan(0);
    for (const fixture of sseFixtures) {
      const expected = referenceMessages(fixture.bytes);
      const actual = comparable(run([fixture.bytes]).events);

      expect(expected.length, fixture.name).toBeGreaterThan(0);
      expect(actual, fixture.name).toStrictEqual(expected);
    }
  });

  const referenceInputs: readonly string[] = [
    'id: 1\nevent: a\ndata: x\n\ndata: y\n\n',
    'data:  two\n\n',
    'data:\ndata:\n\n',
    'data: a: b\n\n',
    'Data: x\n\n',
    'data : x\n\n',
    'foo: bar\n\n',
    'id:\ndata: x\n\n',
    'id: 1\nid: a\u0000b\ndata: x\n\n',
    'id: 1\nid: 2\nevent: p\nevent: q\ndata: x\n\n',
    'data: a\r\rdata: b\r\r',
    'data: a\r\n\r\ndata: b\n\n',
    '\n\n\ndata: x\n\n',
    'data: a\n\n\n\ndata: b\n\n',
    ': c\ndata: x\n: d\ndata: y\n\n',
    'id: 5\n\ndata: x\n\n',
    'event: error\ndata: [DONE]\n\n',
    'data: 1\ndata: 2\n\n',
    'data: {\ndata: "n": 1\ndata: }\n\n',
    'data: 42\n\ndata: null\n\n',
  ];

  it.each(referenceInputs.map((input) => [JSON.stringify(input), input] as const))(
    'matches eventsource-parser on %s',
    (_label, input) => {
      const bytes = encode(input);

      expect(comparable(run([bytes]).events)).toStrictEqual(referenceMessages(bytes));
    },
  );
});

describe('SseInterpreter at every byte boundary', () => {
  const extraCases: readonly (readonly [name: string, bytes: Uint8Array, limits: Limits])[] = [
    ['a byte-order mark and a comment', encode('﻿: ping\ndata: x\n\n'), roomy],
    ['multi-byte characters', encode('data: é✓🚀\r\n\r\ndata: 日本語\n\n'), roomy],
    ['comments inside a block', encode('data: a\n: ping\ndata: b\n\n'), roomy],
    ['mixed terminators ending in a CR', encode('data: a\n\ndata: b\r\n\r\ndata: c\r\r'), roomy],
    ['an incomplete final block', encode('data: a\n\ndata: tail'), roomy],
    ['a block over the size limit', encode(`${tightBlock}${afterEvent}`), tight],
    ['an oversize line first in a block', encode(`${hugeLine}\n${afterEvent}`), tight],
    [
      'an oversize line after data',
      encode(`data: aaa\n${hugeLine}data: ccc\n\n${afterEvent}`),
      tight,
    ],
    ['an incomplete oversize block', encode(`data: a\n\n${tightBlock.slice(0, 50)}`), tight],
  ];
  const cases = [
    ...sseFixtures.map((fixture) => [fixture.name, fixture.bytes, roomy] as const),
    ...extraCases,
  ];

  it.each(cases)(
    'gives identical events and end results for every chunking of %s',
    (_name, bytes, limits) => {
      const expected = run([bytes], limits);

      expect(expected.events.length).toBeGreaterThan(0);
      for (const chunks of everySplit(bytes)) {
        const sizes = chunks.map((chunk) => chunk.length).join('+');
        expect(run(chunks, limits), `chunks ${sizes}`).toStrictEqual(expected);
      }
    },
  );

  it('discards the same incomplete block for every chunking of the edge-case fixture', () => {
    const partial = at(edgeRanges, 8);

    for (const chunks of everySplit(edgeCases)) {
      const sizes = chunks.map((chunk) => chunk.length).join('+');
      expect(run(chunks).discarded, `chunks ${sizes}`).toStrictEqual({
        offset: partial.offset,
        length: partial.length,
      });
    }
  });
});
