import { describe, expect, it } from 'vitest';
import { everySplit } from '../../support/chunks';
import { LineFramer, type FramedLine } from '../../../src/streaming/framer';
import { previewBytes } from '../../../src/streaming/limits';

type Terminator = FramedLine['terminator'];
type OversizeLine = Extract<FramedLine, { kind: 'oversize' }>;
type Piece = readonly [text: string, terminator: Terminator];

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const bomBytes = [0xef, 0xbb, 0xbf];

function encode(text: string): Uint8Array {
  return encoder.encode(text);
}

function decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

function bytesOf(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  return Uint8Array.from(parts.flatMap((part) => [...part]));
}

function chunked(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let start = 0; start < bytes.length; start += size) {
    chunks.push(bytes.subarray(start, start + size));
  }
  return chunks;
}

function splitLabel(chunks: readonly Uint8Array[]): string {
  return chunks.map((chunk) => chunk.length).join('+');
}

function takeLines(framer: LineFramer): FramedLine[] {
  const lines: FramedLine[] = [];
  for (let line = framer.next(); line !== undefined; line = framer.next()) {
    lines.push(line);
  }
  return lines;
}

function frame(chunks: readonly Uint8Array[], maxLineBytes = 1024): FramedLine[] {
  const framer = new LineFramer(maxLineBytes);
  const lines: FramedLine[] = [];
  for (const chunk of chunks) {
    framer.push(chunk);
    lines.push(...takeLines(framer));
  }
  const last = framer.end();
  if (last !== undefined) {
    lines.push(last);
  }
  return lines;
}

function frameBuffered(chunks: readonly Uint8Array[], maxLineBytes = 1024): FramedLine[] {
  const framer = new LineFramer(maxLineBytes);
  for (const chunk of chunks) {
    framer.push(chunk);
  }
  const lines = takeLines(framer);
  const last = framer.end();
  if (last !== undefined) {
    lines.push(last);
  }
  return lines;
}

function expectedLine(
  text: string,
  terminator: Terminator,
  offset: number,
  length: number,
  number: number,
  invalidUtf8 = false,
): FramedLine {
  return { kind: 'line', text, terminator, offset, length, number, invalidUtf8 };
}

function expectedLines(pieces: readonly Piece[], start = 0): FramedLine[] {
  let offset = start;
  return pieces.map(([text, terminator], index) => {
    const length = encode(text).length + encode(terminator).length;
    const line = expectedLine(text, terminator, offset, length, index + 1);
    offset += length;
    return line;
  });
}

function joinPieces(pieces: readonly Piece[]): Uint8Array {
  return encode(pieces.map(([text, terminator]) => text + terminator).join(''));
}

function oversizeAt(lines: readonly FramedLine[], index: number): OversizeLine {
  const line = lines[index];
  if (line?.kind !== 'oversize') {
    throw new Error(`line ${String(index)} is not an oversize record`);
  }
  return line;
}

function withoutPreview(lines: readonly FramedLine[]): unknown[] {
  return lines.map((line) => {
    if (line.kind !== 'oversize') {
      return line;
    }
    const { kind, terminator, offset, length, number } = line;
    return { kind, terminator, offset, length, number };
  });
}

describe('LineFramer', () => {
  it('splits on LF, CRLF and lone CR with byte offsets and lengths', () => {
    const framer = new LineFramer(1024);
    framer.push(encode('a\nbb\r\nc\rd'));

    expect(framer.next()).toEqual(expectedLine('a', '\n', 0, 2, 1));
    expect(framer.next()).toEqual(expectedLine('bb', '\r\n', 2, 4, 2));
    expect(framer.next()).toEqual(expectedLine('c', '\r', 6, 2, 3));
    expect(framer.next()).toBeUndefined();
    expect(framer.end()).toEqual(expectedLine('d', '', 8, 1, 4));
  });

  it('joins a CR at the end of one chunk with an LF at the start of the next', () => {
    const framer = new LineFramer(1024);

    framer.push(encode('a\r'));
    expect(framer.next()).toBeUndefined();

    framer.push(encode('\nb'));
    expect(framer.next()).toEqual(expectedLine('a', '\r\n', 0, 3, 1));
    expect(framer.next()).toBeUndefined();
    expect(framer.end()).toEqual(expectedLine('b', '', 3, 1, 2));
  });

  it('ends a line at a CR when the next chunk starts with another byte', () => {
    const framer = new LineFramer(1024);

    framer.push(encode('a\r'));
    expect(framer.next()).toBeUndefined();

    framer.push(encode('b\n'));
    expect(framer.next()).toEqual(expectedLine('a', '\r', 0, 2, 1));
    expect(framer.next()).toEqual(expectedLine('b', '\n', 2, 2, 2));
    expect(framer.next()).toBeUndefined();
    expect(framer.end()).toBeUndefined();
  });

  it('treats CR CR LF as two terminators for every chunking', () => {
    const expected = [
      expectedLine('a', '\r', 0, 2, 1),
      expectedLine('', '\r\n', 2, 2, 2),
      expectedLine('b', '\n', 4, 2, 3),
    ];

    for (const chunks of everySplit(encode('a\r\r\nb\n'))) {
      expect(frame(chunks), splitLabel(chunks)).toEqual(expected);
    }
  });

  it('treats a trailing CR as a terminator at end', () => {
    const framer = new LineFramer(1024);
    framer.push(encode('a\r'));

    expect(framer.next()).toBeUndefined();
    expect(framer.end()).toEqual(expectedLine('a', '\r', 0, 2, 1));
  });

  it('returns an unterminated final line from end() with an empty terminator', () => {
    const framer = new LineFramer(1024);
    framer.push(encode('a\nlast'));

    expect(framer.next()).toEqual(expectedLine('a', '\n', 0, 2, 1));
    expect(framer.next()).toBeUndefined();
    expect(framer.end()).toEqual(expectedLine('last', '', 2, 4, 2));
  });

  it('returns no final line when the input ends with a terminator or is empty', () => {
    for (const input of ['a\n', 'a\r\n']) {
      const framer = new LineFramer(1024);
      framer.push(encode(input));

      expect(takeLines(framer)).toHaveLength(1);
      expect(framer.end(), input).toBeUndefined();
    }

    const empty = new LineFramer(1024);
    expect(empty.next()).toBeUndefined();
    expect(empty.end()).toBeUndefined();
  });

  it('ignores empty chunks, including between a CR and an LF', () => {
    const lines = frame([
      new Uint8Array(0),
      encode('a\r'),
      new Uint8Array(0),
      encode('\nb\n'),
      new Uint8Array(0),
    ]);

    expect(lines).toEqual([expectedLine('a', '\r\n', 0, 3, 1), expectedLine('b', '\n', 3, 2, 2)]);
  });

  it('rebuilds a multi-byte character split across chunks', () => {
    const lines = frame([bytesOf(0xc3), bytesOf(0xa9, 0x0a)]);

    expect(lines).toEqual([expectedLine('é', '\n', 0, 3, 1)]);
  });

  it('rebuilds three-byte and four-byte characters split at every byte', () => {
    const pieces: Piece[] = [
      ['✓ done', '\n'],
      ['🚀', '\r\n'],
    ];
    const expected = expectedLines(pieces);

    for (const chunks of everySplit(joinPieces(pieces))) {
      expect(frame(chunks), splitLabel(chunks)).toEqual(expected);
    }
  });

  it('skips a leading BOM even when it is split', () => {
    const lines = frame([bytesOf(0xef), bytesOf(0xbb, 0xbf, 0x61, 0x0a)]);

    expect(lines).toEqual([expectedLine('a', '\n', 3, 2, 1)]);
  });

  it('skips a leading BOM before an empty first line for every chunking', () => {
    const input = concat(bytesOf(...bomBytes), encode('\na'));
    const expected = [expectedLine('', '\n', 3, 1, 1), expectedLine('a', '', 4, 1, 2)];

    for (const chunks of everySplit(input)) {
      expect(frame(chunks), splitLabel(chunks)).toEqual(expected);
    }
  });

  it('emits nothing for a stream that holds only a BOM', () => {
    for (const chunks of everySplit(bytesOf(...bomBytes))) {
      expect(frame(chunks), splitLabel(chunks)).toEqual([]);
    }
  });

  it('does not mistake a partial BOM prefix for a BOM', () => {
    const lines = frame([bytesOf(0xef), bytesOf(0xbb, 0x61, 0x0a)]);

    expect(lines).toEqual([expectedLine('�a', '\n', 0, 4, 1, true)]);
  });

  it('keeps a BOM that is not at the start of the stream', () => {
    const lines = frame([encode('a\n'), concat(bytesOf(...bomBytes), encode('b\n'))]);

    expect(lines).toEqual([expectedLine('a', '\n', 0, 2, 1), expectedLine('﻿b', '\n', 2, 5, 2)]);
  });

  it('skips an oversize line and resynchronises at the next terminator', () => {
    const maxLineBytes = 8;
    const framer = new LineFramer(maxLineBytes);
    const lines: FramedLine[] = [];

    for (const chunk of chunked(encode('0123456789ABCDEF\nok\n'), 3)) {
      framer.push(chunk);
      expect(framer.pendingBytes).toBeLessThanOrEqual(maxLineBytes + 3);
      lines.push(...takeLines(framer));
      expect(framer.pendingBytes).toBeLessThanOrEqual(maxLineBytes + 3);
    }

    expect(framer.end()).toBeUndefined();
    expect(withoutPreview(lines)).toEqual([
      { kind: 'oversize', terminator: '\n', offset: 0, length: 17, number: 1 },
      expectedLine('ok', '\n', 17, 3, 2),
    ]);
    const { preview } = oversizeAt(lines, 0);
    expect(preview.length).toBeGreaterThan(0);
    expect('0123456789ABCDEF'.startsWith(preview)).toBe(true);
  });

  it('keeps the held bytes bounded while skipping a long line', () => {
    const maxLineBytes = 8;
    const input = encode(`${'x'.repeat(500)}\nok\n`);

    for (const size of [1, 2, 3]) {
      const framer = new LineFramer(maxLineBytes);
      const lines: FramedLine[] = [];
      for (const chunk of chunked(input, size)) {
        framer.push(chunk);
        expect(framer.pendingBytes, `chunk size ${String(size)}`).toBeLessThanOrEqual(
          maxLineBytes + 3,
        );
        lines.push(...takeLines(framer));
      }

      expect(withoutPreview(lines), `chunk size ${String(size)}`).toEqual([
        { kind: 'oversize', terminator: '\n', offset: 0, length: 501, number: 1 },
        expectedLine('ok', '\n', 501, 3, 2),
      ]);
    }
  });

  it('resynchronises after an oversize line ended by a CRLF split across chunks', () => {
    const source = '0123456789ABCDEF';

    for (const chunks of everySplit(encode(`${source}\r\nok\n`))) {
      const lines = frame(chunks, 8);

      expect(withoutPreview(lines), splitLabel(chunks)).toEqual([
        { kind: 'oversize', terminator: '\r\n', offset: 0, length: 18, number: 1 },
        expectedLine('ok', '\n', 18, 3, 2),
      ]);
      expect(source.startsWith(oversizeAt(lines, 0).preview), splitLabel(chunks)).toBe(true);
    }
  });

  it('reports an oversize line that ends the stream from end()', () => {
    for (const [input, terminator, length] of [
      ['0123456789', '', 10],
      ['0123456789\r', '\r', 11],
    ] as const) {
      for (const chunks of everySplit(encode(input))) {
        expect(withoutPreview(frame(chunks, 8)), `${input} ${splitLabel(chunks)}`).toEqual([
          { kind: 'oversize', terminator, offset: 0, length, number: 1 },
        ]);
      }
    }
  });

  it('accepts a line of exactly maxLineBytes and rejects one byte more', () => {
    const exact = [
      expectedLine('01234567', '\r\n', 0, 10, 1),
      expectedLine('abcdefgh', '\n', 10, 9, 2),
      expectedLine('01234567', '', 19, 8, 3),
    ];

    for (const chunks of everySplit(encode('01234567\r\nabcdefgh\n01234567'))) {
      expect(frame(chunks, 8), splitLabel(chunks)).toEqual(exact);
    }
    expect(frame([encode('éééé\n')], 8)).toEqual([expectedLine('éééé', '\n', 0, 9, 1)]);

    expect(withoutPreview(frame([encode('012345678\n')], 8))).toEqual([
      { kind: 'oversize', terminator: '\n', offset: 0, length: 10, number: 1 },
    ]);
    expect(withoutPreview(frame([encode('ééééé\n')], 8))).toEqual([
      { kind: 'oversize', terminator: '\n', offset: 0, length: 11, number: 1 },
    ]);
  });

  it('previews at most previewBytes and drops a cut multi-byte character', () => {
    const tail = 'b'.repeat(1100);

    for (const character of ['é', '✓', '🚀']) {
      const width = encode(character).length;
      for (let fitting = 0; fitting <= width; fitting += 1) {
        const prefix = 'a'.repeat(previewBytes - fitting);
        const input = encode(`${prefix}${character}${tail}\n`);
        const expectedPreview = fitting === width ? prefix + character : prefix;

        for (const chunks of [[input], chunked(input, 700), chunked(input, 1)]) {
          const label = `${character} ${String(fitting)} ${String(chunks.length)}`;
          const lines = frame(chunks, 2048);
          const { preview } = oversizeAt(lines, 0);

          expect(lines, label).toHaveLength(1);
          expect(preview, label).toBe(expectedPreview);
          expect(preview, label).not.toContain('�');
          expect(encode(preview).length, label).toBeLessThanOrEqual(previewBytes);
          expect(withoutPreview(lines), label).toEqual([
            { kind: 'oversize', terminator: '\n', offset: 0, length: input.length, number: 1 },
          ]);
        }
      }
    }
  });

  it('reports the same oversize record for every chunking', () => {
    const prefix = 'x'.repeat(previewBytes - 1);
    const input = encode(`${prefix}é${'y'.repeat(1100)}\nok\r\n`);
    const lineLength = input.length - 4;

    for (const chunks of everySplit(input)) {
      const lines = frame(chunks, 2048);

      expect(withoutPreview(lines), splitLabel(chunks)).toEqual([
        { kind: 'oversize', terminator: '\n', offset: 0, length: lineLength, number: 1 },
        expectedLine('ok', '\r\n', lineLength, 4, 2),
      ]);
      expect(oversizeAt(lines, 0).preview, splitLabel(chunks)).toBe(prefix);
    }
  });

  it('flags invalid UTF-8 but not a literal U+FFFD', () => {
    expect(frame([bytesOf(0xc3, 0x28, 0x0a)])).toEqual([expectedLine('�(', '\n', 0, 3, 1, true)]);
    expect(frame([bytesOf(0xef, 0xbf, 0xbd, 0x0a)])).toEqual([
      expectedLine('�', '\n', 0, 4, 1, false),
    ]);
  });

  it('flags every kind of invalid byte sequence and only the line that holds it', () => {
    const invalid = [[0xff], [0x80], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf0, 0x9f, 0x9a]];

    for (const sequence of invalid) {
      const input = concat(bytesOf(0x61, ...sequence, 0x0a), encode('🚀\n'));
      const lines = frame([input]);

      expect(
        lines.map((line) => (line.kind === 'line' ? line.invalidUtf8 : undefined)),
        sequence.join(','),
      ).toEqual([true, false]);
    }
  });

  it('flags a character cut off at the end of an unterminated line', () => {
    const lines = frame([bytesOf(0x61, 0xc3)]);

    expect(lines).toEqual([expectedLine('a�', '', 0, 2, 1, true)]);
  });

  it('numbers every line including empty ones', () => {
    const framer = new LineFramer(1024);
    framer.push(encode('a\n\n\r\nb\r\rc'));
    const lines = takeLines(framer);
    const last = framer.end();

    expect(last).toEqual(expectedLine('c', '', 8, 1, 6));
    expect(lines).toEqual([
      expectedLine('a', '\n', 0, 2, 1),
      expectedLine('', '\n', 2, 1, 2),
      expectedLine('', '\r\n', 3, 2, 3),
      expectedLine('b', '\r', 5, 2, 4),
      expectedLine('', '\r', 7, 1, 5),
    ]);
  });

  it('returns the unconsumed bytes and stops framing', () => {
    const framer = new LineFramer(1024);
    framer.push(encode('a\nbc'));

    expect(framer.next()).toEqual(expectedLine('a', '\n', 0, 2, 1));
    expect(decode(framer.takeRemaining())).toBe('bc');
    expect(framer.pendingBytes).toBe(0);
    expect(framer.next()).toBeUndefined();
    expect(framer.end()).toBeUndefined();
  });

  it('returns the partial line together with the chunks it has not read', () => {
    const framer = new LineFramer(1024);
    framer.push(encode('a\nb'));
    framer.push(encode('c\nd'));
    framer.push(encode('\ne'));

    expect(framer.next()).toEqual(expectedLine('a', '\n', 0, 2, 1));
    expect(decode(framer.takeRemaining())).toBe('bc\nd\ne');
  });

  it('returns a partial line that spans chunks', () => {
    const framer = new LineFramer(1024);
    framer.push(encode('a\nb'));
    framer.push(encode('c'));

    expect(framer.next()).toEqual(expectedLine('a', '\n', 0, 2, 1));
    expect(framer.next()).toBeUndefined();
    expect(decode(framer.takeRemaining())).toBe('bc');
  });

  it('returns a pending CR among the remaining bytes', () => {
    const framer = new LineFramer(1024);
    framer.push(encode('a\r'));

    expect(framer.next()).toBeUndefined();
    expect(decode(framer.takeRemaining())).toBe('a\r');
  });

  it('returns no bytes when everything has been consumed', () => {
    const framer = new LineFramer(1024);
    expect(framer.takeRemaining()).toHaveLength(0);

    const consumed = new LineFramer(1024);
    consumed.push(encode('a\n'));
    expect(consumed.next()).toEqual(expectedLine('a', '\n', 0, 2, 1));
    expect(consumed.takeRemaining()).toHaveLength(0);
  });

  it('peeks at the unconsumed bytes without consuming them', () => {
    const framer = new LineFramer(1024);
    framer.push(encode('a\nbc'));
    framer.push(encode('de'));

    expect(framer.next()).toEqual(expectedLine('a', '\n', 0, 2, 1));
    expect(framer.next()).toBeUndefined();
    expect(decode(framer.peek(3))).toBe('bcd');
    expect(decode(framer.peek(10))).toBe('bcde');
    expect(framer.pendingBytes).toBe(4);

    framer.push(encode('f\n'));
    expect(decode(framer.peek(10))).toBe('bcdef\n');
    expect(framer.next()).toEqual(expectedLine('bcdef', '\n', 2, 6, 2));
  });

  it('reports the bytes it holds', () => {
    const framer = new LineFramer(1024);
    expect(framer.pendingBytes).toBe(0);

    framer.push(encode('abc'));
    expect(framer.next()).toBeUndefined();
    expect(framer.pendingBytes).toBe(3);

    framer.push(encode('d\ne'));
    expect(framer.next()).toEqual(expectedLine('abcd', '\n', 0, 5, 1));
    expect(framer.next()).toBeUndefined();
    expect(framer.pendingBytes).toBe(1);

    expect(decode(framer.takeRemaining())).toBe('e');
    expect(framer.pendingBytes).toBe(0);
  });

  it('gives the same lines for every chunking of mixed line endings, a BOM and multi-byte characters', () => {
    const pieces: Piece[] = [
      ['é1', '\n'],
      ['two', '\r\n'],
      ['three', '\r'],
      ['✓ 🚀', '\n'],
      ['', '\n'],
      ['', '\r\n'],
      ['﻿kept', '\n'],
      ['{"type":"RUN_STARTED","threadId":"thread-1"}', '\r\n'],
      ['last é', ''],
    ];
    const input = concat(bytesOf(...bomBytes), joinPieces(pieces));
    const expected = expectedLines(pieces, bomBytes.length);

    for (const chunks of everySplit(input)) {
      expect(frame(chunks), splitLabel(chunks)).toEqual(expected);
      expect(frameBuffered(chunks), `${splitLabel(chunks)} buffered`).toEqual(expected);
    }
  });

  it('gives the same lines for every chunking when the input ends with a CR', () => {
    const pieces: Piece[] = [
      ['x', '\r\n'],
      ['é', '\r'],
    ];
    const expected = expectedLines(pieces);

    for (const chunks of everySplit(joinPieces(pieces))) {
      expect(frame(chunks), splitLabel(chunks)).toEqual(expected);
      expect(frameBuffered(chunks), `${splitLabel(chunks)} buffered`).toEqual(expected);
    }
  });
});
