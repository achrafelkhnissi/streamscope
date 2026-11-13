import { describe, expect, it } from 'vitest';
import { rawTail, rawTokens, splitLines } from '../../../src/webview/raw-colour';

function joined(line: string): string {
  return rawTokens(line)
    .map((token) => token.text)
    .join('');
}

describe('rawTokens', () => {
  it('colours the keys, strings, numbers and literals of a JSON line', () => {
    const line = '{"type":"RUN_STARTED","n":1,"ok":true}';

    expect(rawTokens(line)).toEqual([
      { kind: 'plain', text: '{' },
      { kind: 'key', text: '"type"' },
      { kind: 'plain', text: ':' },
      { kind: 'string', text: '"RUN_STARTED"' },
      { kind: 'plain', text: ',' },
      { kind: 'key', text: '"n"' },
      { kind: 'plain', text: ':' },
      { kind: 'number', text: '1' },
      { kind: 'plain', text: ',' },
      { kind: 'key', text: '"ok"' },
      { kind: 'plain', text: ':' },
      { kind: 'literal', text: 'true' },
      { kind: 'plain', text: '}' },
    ]);
    expect(joined(line)).toBe(line);
  });

  it('starts an SSE data line with a field token', () => {
    expect(rawTokens('data: {"a":1}')).toEqual([
      { kind: 'field', text: 'data' },
      { kind: 'plain', text: ': {' },
      { kind: 'key', text: '"a"' },
      { kind: 'plain', text: ':' },
      { kind: 'number', text: '1' },
      { kind: 'plain', text: '}' },
    ]);
  });

  it('colours the other SSE field names', () => {
    expect(rawTokens('event: message')).toEqual([
      { kind: 'field', text: 'event' },
      { kind: 'plain', text: ': message' },
    ]);
    expect(rawTokens('retry: 3000')).toEqual([
      { kind: 'field', text: 'retry' },
      { kind: 'plain', text: ': ' },
      { kind: 'number', text: '3000' },
    ]);
    expect(rawTokens('id')).toEqual([{ kind: 'field', text: 'id' }]);
  });

  it('makes an SSE comment line one comment token', () => {
    expect(rawTokens(': keep-alive')).toEqual([{ kind: 'comment', text: ': keep-alive' }]);
  });

  it('does not take a word that starts like a field name for a field', () => {
    expect(rawTokens('database: x')).toEqual([{ kind: 'plain', text: 'database: x' }]);
    expect(rawTokens('identity')).toEqual([{ kind: 'plain', text: 'identity' }]);
  });

  it('does not colour digits or literals inside words', () => {
    expect(rawTokens('abc123 nullable x1')).toEqual([
      { kind: 'plain', text: 'abc123 nullable x1' },
    ]);
  });

  it('colours negative, decimal and exponent numbers', () => {
    expect(rawTokens('[-1.5e3,2,null]')).toEqual([
      { kind: 'plain', text: '[' },
      { kind: 'number', text: '-1.5e3' },
      { kind: 'plain', text: ',' },
      { kind: 'number', text: '2' },
      { kind: 'plain', text: ',' },
      { kind: 'literal', text: 'null' },
      { kind: 'plain', text: ']' },
    ]);
  });

  it('keeps escaped quotes inside a string', () => {
    expect(rawTokens('"say \\"hi\\"" : 1')).toEqual([
      { kind: 'key', text: '"say \\"hi\\""' },
      { kind: 'plain', text: ' : ' },
      { kind: 'number', text: '1' },
    ]);
  });

  it('colours a string cut off at the end of the line', () => {
    expect(rawTokens('{"a":"abc')).toEqual([
      { kind: 'plain', text: '{' },
      { kind: 'key', text: '"a"' },
      { kind: 'plain', text: ':' },
      { kind: 'string', text: '"abc' },
    ]);
  });

  it('gives no tokens for an empty line', () => {
    expect(rawTokens('')).toEqual([]);
  });

  it('always joins back to the line', () => {
    for (const line of [
      'data: [DONE]',
      '{"a":"\\\\","b":[1,2,{"c":false}]}',
      '"unterminated \\',
      ':',
      'event:',
      'id: 42',
      '  {"x": -0.5E-7 }  ',
      'plain text with "quotes and \\" escapes',
      '😀 "é" 1e',
    ]) {
      expect(joined(line)).toBe(line);
    }
  });
});

describe('splitLines', () => {
  it('splits text into finished lines and the line still being written', () => {
    expect(splitLines('', 'a\nb\nc')).toEqual({ lines: ['a', 'b'], open: 'c' });
  });

  it('continues the line still being written', () => {
    expect(splitLines('x', 'y\nz')).toEqual({ lines: ['xy'], open: 'z' });
    expect(splitLines('x', 'y')).toEqual({ lines: [], open: 'xy' });
  });

  it('ends lines at CRLF, LF and a lone CR', () => {
    expect(splitLines('', 'a\r\nb\nc\rd\n')).toEqual({ lines: ['a', 'b', 'c', 'd'], open: '' });
  });

  it('waits for the next text before ending a line at a trailing CR', () => {
    expect(splitLines('', 'a\r')).toEqual({ lines: [], open: 'a\r' });
    expect(splitLines('a\r', '\nb')).toEqual({ lines: ['a'], open: 'b' });
    expect(splitLines('a\r', 'b')).toEqual({ lines: ['a'], open: 'b' });
  });

  it('keeps empty lines', () => {
    expect(splitLines('', '\n\nx')).toEqual({ lines: ['', ''], open: 'x' });
  });
});

describe('rawTail', () => {
  it('keeps everything that fits', () => {
    expect(rawTail({ lines: ['ab', 'c'], open: 'd' }, 6, 10)).toEqual({
      lines: ['ab', 'c'],
      open: 'd',
      cut: false,
    });
  });

  it('drops the oldest lines past the character limit, counting each line break', () => {
    expect(rawTail({ lines: ['aaaa', 'bb', 'c'], open: '' }, 5, 10)).toEqual({
      lines: ['bb', 'c'],
      open: '',
      cut: true,
    });
  });

  it('keeps the end of the oldest line that partly fits', () => {
    expect(rawTail({ lines: ['abcd', 'bb', 'c'], open: '' }, 7, 10)).toEqual({
      lines: ['d', 'bb', 'c'],
      open: '',
      cut: true,
    });
  });

  it('keeps the end of a line still being written that is longer than the limit', () => {
    expect(rawTail({ lines: ['a'], open: 'abcdefgh' }, 4, 10)).toEqual({
      lines: [],
      open: 'efgh',
      cut: true,
    });
  });

  it('keeps at most the given number of lines, counting the line still being written', () => {
    expect(rawTail({ lines: ['a', 'b', 'c'], open: 'd' }, 100, 3)).toEqual({
      lines: ['b', 'c'],
      open: 'd',
      cut: true,
    });
    expect(rawTail({ lines: ['a', 'b', 'c'], open: '' }, 100, 3)).toEqual({
      lines: ['a', 'b', 'c'],
      open: '',
      cut: false,
    });
  });
});
