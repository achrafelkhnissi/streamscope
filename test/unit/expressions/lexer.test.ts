import { describe, expect, it } from 'vitest';
import { Lexer, type Token } from '../../../src/expressions/lexer';

function tokens(text: string): Token[] {
  const lexer = new Lexer(text);
  const result: Token[] = [];
  for (;;) {
    const token = lexer.next();
    result.push(token);
    if (token.kind === 'end' || token.kind === 'error') {
      return result;
    }
  }
}

function span(start: number, end: number): { start: number; end: number } {
  return { start, end };
}

describe('Lexer', () => {
  it('tokenizes every operator, keyword and literal with its span', () => {
    expect(tokens('first(a.b == -1.5e2) | default("x")')).toStrictEqual([
      { kind: 'identifier', text: 'first', span: span(0, 5) },
      { kind: 'punctuation', text: '(', span: span(5, 6) },
      { kind: 'identifier', text: 'a', span: span(6, 7) },
      { kind: 'punctuation', text: '.', span: span(7, 8) },
      { kind: 'identifier', text: 'b', span: span(8, 9) },
      { kind: 'punctuation', text: '==', span: span(10, 12) },
      { kind: 'number', value: -150, span: span(13, 19) },
      { kind: 'punctuation', text: ')', span: span(19, 20) },
      { kind: 'punctuation', text: '|', span: span(21, 22) },
      { kind: 'identifier', text: 'default', span: span(23, 30) },
      { kind: 'punctuation', text: '(', span: span(30, 31) },
      { kind: 'string', value: 'x', span: span(31, 34) },
      { kind: 'punctuation', text: ')', span: span(34, 35) },
      { kind: 'end', span: span(35, 35) },
    ]);

    expect(tokens('== != < <= > >= && || ! | . , ( ) [ ] * ? @')).toStrictEqual([
      { kind: 'punctuation', text: '==', span: span(0, 2) },
      { kind: 'punctuation', text: '!=', span: span(3, 5) },
      { kind: 'punctuation', text: '<', span: span(6, 7) },
      { kind: 'punctuation', text: '<=', span: span(8, 10) },
      { kind: 'punctuation', text: '>', span: span(11, 12) },
      { kind: 'punctuation', text: '>=', span: span(13, 15) },
      { kind: 'punctuation', text: '&&', span: span(16, 18) },
      { kind: 'punctuation', text: '||', span: span(19, 21) },
      { kind: 'punctuation', text: '!', span: span(22, 23) },
      { kind: 'punctuation', text: '|', span: span(24, 25) },
      { kind: 'punctuation', text: '.', span: span(26, 27) },
      { kind: 'punctuation', text: ',', span: span(28, 29) },
      { kind: 'punctuation', text: '(', span: span(30, 31) },
      { kind: 'punctuation', text: ')', span: span(32, 33) },
      { kind: 'punctuation', text: '[', span: span(34, 35) },
      { kind: 'punctuation', text: ']', span: span(36, 37) },
      { kind: 'punctuation', text: '*', span: span(38, 39) },
      { kind: 'punctuation', text: '?', span: span(40, 41) },
      { kind: 'at', name: '', span: span(42, 43) },
      { kind: 'end', span: span(43, 43) },
    ]);

    expect(tokens('true false null in contains startsWith matches')).toStrictEqual([
      { kind: 'keyword', text: 'true', span: span(0, 4) },
      { kind: 'keyword', text: 'false', span: span(5, 10) },
      { kind: 'keyword', text: 'null', span: span(11, 15) },
      { kind: 'keyword', text: 'in', span: span(16, 18) },
      { kind: 'keyword', text: 'contains', span: span(19, 27) },
      { kind: 'keyword', text: 'startsWith', span: span(28, 38) },
      { kind: 'keyword', text: 'matches', span: span(39, 46) },
      { kind: 'end', span: span(46, 46) },
    ]);

    expect(tokens('@ @sse @other')).toStrictEqual([
      { kind: 'at', name: '', span: span(0, 1) },
      { kind: 'at', name: 'sse', span: span(2, 6) },
      { kind: 'at', name: 'other', span: span(7, 13) },
      { kind: 'end', span: span(13, 13) },
    ]);
  });

  it('reads identifiers made of letters, digits, underscores and dollar signs', () => {
    expect(tokens('_a $b c1 contain')).toStrictEqual([
      { kind: 'identifier', text: '_a', span: span(0, 2) },
      { kind: 'identifier', text: '$b', span: span(3, 5) },
      { kind: 'identifier', text: 'c1', span: span(6, 8) },
      { kind: 'identifier', text: 'contain', span: span(9, 16) },
      { kind: 'end', span: span(16, 16) },
    ]);
  });

  it('skips spaces, tabs and line breaks and gives the end token the text length', () => {
    expect(tokens(' \t\r\n a \n')).toStrictEqual([
      { kind: 'identifier', text: 'a', span: span(5, 6) },
      { kind: 'end', span: span(8, 8) },
    ]);
    expect(tokens('')).toStrictEqual([{ kind: 'end', span: span(0, 0) }]);
  });

  it('keeps integers beyond 2^53 as bigint', () => {
    expect(tokens('12345678901234567890')).toStrictEqual([
      { kind: 'number', value: 12345678901234567890n, span: span(0, 20) },
      { kind: 'end', span: span(20, 20) },
    ]);
    expect(tokens('-12345678901234567890')).toStrictEqual([
      { kind: 'number', value: -12345678901234567890n, span: span(0, 21) },
      { kind: 'end', span: span(21, 21) },
    ]);
  });

  it('switches to bigint exactly at the first integer beyond the safe range', () => {
    const values = tokens(
      '9007199254740991 9007199254740992 -9007199254740991 -9007199254740992',
    ).flatMap((token) => (token.kind === 'number' ? [token.value] : []));

    expect(values).toStrictEqual([
      9007199254740991,
      9007199254740992n,
      -9007199254740991,
      -9007199254740992n,
    ]);
  });

  it('keeps decimals, exponents and zero as numbers', () => {
    const values = tokens(
      '0 -0 1.5 -2.25 1e3 1E+3 2.5e-2 12345678901234567890.5 12345678901234567890e0',
    ).flatMap((token) => (token.kind === 'number' ? [token.value] : []));

    expect(values).toStrictEqual([
      0, -0, 1.5, -2.25, 1000, 1000, 0.025, 12345678901234567890.5, 12345678901234567890,
    ]);
  });

  it('rejects a number that is not finite, but keeps a huge integer as bigint', () => {
    expect(tokens('1e999')).toStrictEqual([
      { kind: 'error', message: 'The number is too large.', span: span(0, 5) },
    ]);
    expect(tokens('a == -2.5E+400')[2]).toStrictEqual({
      kind: 'error',
      message: 'The number is too large.',
      span: span(5, 14),
    });
    expect(tokens('1'.repeat(400))).toStrictEqual([
      { kind: 'number', value: BigInt('1'.repeat(400)), span: span(0, 400) },
      { kind: 'end', span: span(400, 400) },
    ]);
  });

  it('ends a number where JSON number syntax ends', () => {
    expect(tokens('01 1. 1e')).toStrictEqual([
      { kind: 'number', value: 0, span: span(0, 1) },
      { kind: 'number', value: 1, span: span(1, 2) },
      { kind: 'number', value: 1, span: span(3, 4) },
      { kind: 'punctuation', text: '.', span: span(4, 5) },
      { kind: 'number', value: 1, span: span(6, 7) },
      { kind: 'identifier', text: 'e', span: span(7, 8) },
      { kind: 'end', span: span(8, 8) },
    ]);
  });

  it('reads both quote styles and JSON escapes', () => {
    const cases: [string, string][] = [
      ['"plain"', 'plain'],
      ["'single'", 'single'],
      ['""', ''],
      [`"it's"`, "it's"],
      [`'say "hi"'`, 'say "hi"'],
      [String.raw`"\"\\\/\b\f\n\r\t"`, '"\\/\b\f\n\r\t'],
      [String.raw`'it\'s'`, "it's"],
      [String.raw`'\"'`, '"'],
      [String.raw`"éé😀"`, 'éé😀'],
      ['"naïve 日本語"', 'naïve 日本語'],
    ];

    for (const [source, value] of cases) {
      expect(tokens(source), source).toStrictEqual([
        { kind: 'string', value, span: span(0, source.length) },
        { kind: 'end', span: span(source.length, source.length) },
      ]);
    }
  });

  it('reports an unterminated string from its opening quote to the end of the text', () => {
    expect(tokens('"abc')).toStrictEqual([
      { kind: 'error', message: 'Unterminated string.', span: span(0, 4) },
    ]);
    expect(tokens(`a == 'abc`)).toStrictEqual([
      { kind: 'identifier', text: 'a', span: span(0, 1) },
      { kind: 'punctuation', text: '==', span: span(2, 4) },
      { kind: 'error', message: 'Unterminated string.', span: span(5, 9) },
    ]);
    expect(tokens('"abc\\')).toStrictEqual([
      { kind: 'error', message: 'Unterminated string.', span: span(0, 5) },
    ]);
  });

  it('reports an invalid escape over the escape itself', () => {
    expect(tokens(String.raw`"a\qb"`)).toStrictEqual([
      { kind: 'error', message: 'Invalid escape sequence.', span: span(2, 4) },
    ]);
    expect(tokens(String.raw`"\u12G4"`)).toStrictEqual([
      { kind: 'error', message: 'Invalid escape sequence.', span: span(1, 5) },
    ]);
    expect(tokens(String.raw`"\u"`)).toStrictEqual([
      { kind: 'error', message: 'Invalid escape sequence.', span: span(1, 3) },
    ]);
  });

  it('reads a regex with flags i, m, s and u, and rejects g', () => {
    expect(tokens('/ab+c/imsu')).toStrictEqual([
      { kind: 'regex', pattern: 'ab+c', flags: 'imsu', span: span(0, 10) },
      { kind: 'end', span: span(10, 10) },
    ]);
    expect(tokens('/ab/ ')).toStrictEqual([
      { kind: 'regex', pattern: 'ab', flags: '', span: span(0, 4) },
      { kind: 'end', span: span(5, 5) },
    ]);
    expect(tokens('/a/g')).toStrictEqual([
      {
        kind: 'error',
        message: 'Unsupported regular expression flag `g`. Supported flags are i, m, s and u.',
        span: span(3, 4),
      },
    ]);
    expect(tokens('/a/ig')).toStrictEqual([
      {
        kind: 'error',
        message: 'Unsupported regular expression flag `g`. Supported flags are i, m, s and u.',
        span: span(4, 5),
      },
    ]);
    expect(tokens('/a/ii')).toStrictEqual([
      { kind: 'error', message: 'Duplicate regular expression flag `i`.', span: span(4, 5) },
    ]);
  });

  it('keeps escapes and slashes inside a character class in the pattern', () => {
    expect(tokens(String.raw`/a\/b/`)).toStrictEqual([
      { kind: 'regex', pattern: String.raw`a\/b`, flags: '', span: span(0, 6) },
      { kind: 'end', span: span(6, 6) },
    ]);
    expect(tokens('/[/]x/')).toStrictEqual([
      { kind: 'regex', pattern: '[/]x', flags: '', span: span(0, 6) },
      { kind: 'end', span: span(6, 6) },
    ]);
    expect(tokens(String.raw`/[\]/]/`)).toStrictEqual([
      { kind: 'regex', pattern: String.raw`[\]/]`, flags: '', span: span(0, 7) },
      { kind: 'end', span: span(7, 7) },
    ]);
  });

  it('reports an unterminated regex from its opening slash to the end of the text', () => {
    expect(tokens('/abc')).toStrictEqual([
      { kind: 'error', message: 'Unterminated regular expression.', span: span(0, 4) },
    ]);
    expect(tokens('/[/]')).toStrictEqual([
      { kind: 'error', message: 'Unterminated regular expression.', span: span(0, 4) },
    ]);
    expect(tokens(String.raw`/a\/`)).toStrictEqual([
      { kind: 'error', message: 'Unterminated regular expression.', span: span(0, 4) },
    ]);
  });

  it('reports a character that starts no token and stops there', () => {
    expect(tokens('a # b')).toStrictEqual([
      { kind: 'identifier', text: 'a', span: span(0, 1) },
      { kind: 'error', message: 'Unexpected `#`.', span: span(2, 3) },
    ]);
    expect(tokens('a = 1')[1]).toStrictEqual({
      kind: 'error',
      message: 'Unexpected `=`.',
      span: span(2, 3),
    });
    expect(tokens('a & b')[1]).toStrictEqual({
      kind: 'error',
      message: 'Unexpected `&`.',
      span: span(2, 3),
    });
    expect(tokens('- 1')[0]).toStrictEqual({
      kind: 'error',
      message: 'Unexpected `-`.',
      span: span(0, 1),
    });
    expect(tokens('a 😀')[1]).toStrictEqual({
      kind: 'error',
      message: 'Unexpected `😀`.',
      span: span(2, 4),
    });
  });

  it('returns the end token again after the end of the text', () => {
    const lexer = new Lexer('a');

    lexer.next();

    expect(lexer.next()).toStrictEqual({ kind: 'end', span: span(1, 1) });
    expect(lexer.next()).toStrictEqual({ kind: 'end', span: span(1, 1) });
  });

  it('returns the end token after an error', () => {
    const lexer = new Lexer('# a');

    expect(lexer.next().kind).toBe('error');
    expect(lexer.next()).toStrictEqual({ kind: 'end', span: span(3, 3) });
  });
});
