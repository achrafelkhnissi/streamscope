import { describe, expect, it } from 'vitest';
import { iRegexpProblem } from '../../../src/expressions/iregexp';

describe('iRegexpProblem', () => {
  it.each([
    '',
    'a',
    'abc',
    'a|b',
    'a|',
    '|a',
    '()',
    '(|a)',
    '(a|b)+c?',
    'a*',
    'a+',
    'a?',
    'a{2}',
    'a{2,}',
    'a{2,3}',
    'a{0}',
    '.',
    'a.b',
    String.raw`\.`,
    String.raw`\(\)\*\+\-\?`,
    String.raw`\[\\\]\^`,
    String.raw`\n\r\t`,
    String.raw`\{\|\}`,
    String.raw`\p{L}`,
    String.raw`\p{Lu}\P{Nd}\p{Zs}\p{Cn}`,
    '[a-z]',
    '[^a-z]',
    '[-a]',
    '[a-]',
    '[a-z-]',
    '[-]',
    '[--]',
    '[^-]',
    '[a^]',
    '[.]',
    '[(]',
    String.raw`[\]]`,
    String.raw`[\[]`,
    String.raw`[\p{L}0-9]`,
    String.raw`[\n\t]`,
    String.raw`[\--a]`,
    '^abc$',
    '$',
    'é',
    '😀',
    '[😀-😃]',
    ',-/:;<=>@_`~',
  ])('accepts %s', (pattern) => {
    expect(iRegexpProblem(pattern)).toBeUndefined();
  });

  it.each([
    [String.raw`\d`, 'The escape `\\d` is not part of I-Regexp (RFC 9485).'],
    [String.raw`\D`, 'The escape `\\D` is not part of I-Regexp (RFC 9485).'],
    [String.raw`\w`, 'The escape `\\w` is not part of I-Regexp (RFC 9485).'],
    [String.raw`\s`, 'The escape `\\s` is not part of I-Regexp (RFC 9485).'],
    [String.raw`\S`, 'The escape `\\S` is not part of I-Regexp (RFC 9485).'],
    [String.raw`\b`, 'The escape `\\b` is not part of I-Regexp (RFC 9485).'],
    [String.raw`\B`, 'The escape `\\B` is not part of I-Regexp (RFC 9485).'],
    [String.raw`\1`, 'The escape `\\1` is not part of I-Regexp (RFC 9485).'],
    [String.raw`\0`, 'The escape `\\0` is not part of I-Regexp (RFC 9485).'],
    [String.raw`\k<n>`, 'The escape `\\k` is not part of I-Regexp (RFC 9485).'],
    [String.raw`\x41`, 'The escape `\\x` is not part of I-Regexp (RFC 9485).'],
    [String.raw`\u0041`, 'The escape `\\u` is not part of I-Regexp (RFC 9485).'],
    [String.raw`\/`, 'The escape `\\/` is not part of I-Regexp (RFC 9485).'],
    [String.raw`\$`, 'The escape `\\$` is not part of I-Regexp (RFC 9485).'],
    [String.raw`\😀`, 'The escape `\\😀` is not part of I-Regexp (RFC 9485).'],
    [String.raw`a\d+`, 'The escape `\\d` is not part of I-Regexp (RFC 9485).'],
    [String.raw`[\d]`, 'The escape `\\d` is not part of I-Regexp (RFC 9485).'],
    [String.raw`[a\w]`, 'The escape `\\w` is not part of I-Regexp (RFC 9485).'],
    ['a\\', 'A backslash at the end of the regular expression has nothing to escape.'],
    [String.raw`\p`, 'This Unicode property escape is not valid in I-Regexp (RFC 9485).'],
    [String.raw`\pL`, 'This Unicode property escape is not valid in I-Regexp (RFC 9485).'],
    [String.raw`\p{`, 'This Unicode property escape is not valid in I-Regexp (RFC 9485).'],
    [String.raw`\p{Lu`, 'This Unicode property escape is not valid in I-Regexp (RFC 9485).'],
    [String.raw`\p{Xx}`, 'This Unicode property escape is not valid in I-Regexp (RFC 9485).'],
    [
      String.raw`\p{IsBasicLatin}`,
      'This Unicode property escape is not valid in I-Regexp (RFC 9485).',
    ],
    [String.raw`\P{Cs}`, 'This Unicode property escape is not valid in I-Regexp (RFC 9485).'],
    [String.raw`[\p{Greek}]`, 'This Unicode property escape is not valid in I-Regexp (RFC 9485).'],
  ])('rejects the escape in %s', (pattern, message) => {
    expect(iRegexpProblem(pattern)).toBe(message);
  });

  it.each(['(?:a)', '(?<name>a)', '(?=a)', '(?!a)', '(?<=a)', '(?<!a)', '(?i)a', '(?i:a)', 'a(?'])(
    'rejects the group syntax in %s',
    (pattern) => {
      expect(iRegexpProblem(pattern)).toBe(
        'Group syntax such as `(?:…)` and `(?<name>…)` is not part of I-Regexp (RFC 9485).',
      );
    },
  );

  it.each(['a*?', 'a+?', 'a??', 'a{1,2}?', 'a{2}?', '(a)*?', '[a]+?', 'a.*?b'])(
    'rejects the lazy quantifier in %s',
    (pattern) => {
      expect(iRegexpProblem(pattern)).toBe(
        'Lazy quantifiers such as `*?` are not part of I-Regexp (RFC 9485).',
      );
    },
  );

  it.each([
    '*',
    '+a',
    '?',
    'a**',
    'a+*',
    'a*+',
    'a{2}*',
    'a{2}{3}',
    '(*a)',
    'a|*',
    '{2}',
    '(a|{2})',
  ])('rejects a quantifier with nothing to repeat in %s', (pattern) => {
    expect(iRegexpProblem(pattern)).toBe('Nothing to repeat.');
  });

  it.each(['a{', 'a{,2}', 'a{2', 'a{2,x}', 'a{x}', 'a{ 2}', 'a{2 }', 'a{-1}'])(
    'rejects the broken quantifier in %s',
    (pattern) => {
      expect(iRegexpProblem(pattern)).toBe(
        'A `{` must start a quantifier such as `{2}`, `{2,}` or `{2,3}` in I-Regexp (RFC 9485).',
      );
    },
  );

  it.each([
    ['a}', '}'],
    ['}', '}'],
    ['a]', ']'],
    [']', ']'],
  ])('rejects the unescaped character in %s', (pattern, char) => {
    expect(iRegexpProblem(pattern)).toBe(
      `The character \`${char}\` must be escaped in I-Regexp (RFC 9485).`,
    );
  });

  it('rejects unbalanced groups', () => {
    expect(iRegexpProblem('(a')).toBe('Unterminated group.');
    expect(iRegexpProblem('((a)')).toBe('Unterminated group.');
    expect(iRegexpProblem('a)')).toBe('Unmatched `)`.');
    expect(iRegexpProblem('(a))')).toBe('Unmatched `)`.');
  });

  it.each(['[', '[a', '[^', '[a-', '[a-z', '[\\]'])(
    'rejects the unterminated class in %s',
    (pattern) => {
      expect(iRegexpProblem(pattern)).toBeDefined();
    },
  );

  it.each([
    '[]',
    '[^]',
    '[]a]',
    '[a-b-c]',
    '[--a]',
    '[[]',
    '[a[]',
    '[a-\\p{L}]',
    '[\\p{L}-z]',
    '[\\d-z]',
    '[a-\\d]',
    '[a\\]',
  ])('rejects the character class %s', (pattern) => {
    expect(iRegexpProblem(pattern)).toBeDefined();
  });

  it('rejects a lone surrogate', () => {
    expect(iRegexpProblem('a\ud800')).toBe('A lone surrogate is not valid in I-Regexp.');
    expect(iRegexpProblem('[\udc00]')).toBe('A lone surrogate is not valid in I-Regexp.');
  });

  it('checks a long pattern in linear time', () => {
    const start = performance.now();

    expect(iRegexpProblem('a'.repeat(1_000_000))).toBeUndefined();
    expect(iRegexpProblem('(a|b)*'.repeat(100_000))).toBeUndefined();
    expect(iRegexpProblem(`${'('.repeat(100_000)}${')'.repeat(100_000)}`)).toBeUndefined();

    expect(performance.now() - start).toBeLessThan(1000);
  });
});
