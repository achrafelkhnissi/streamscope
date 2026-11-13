import { describe, expect, it } from 'vitest';
import { checkPattern } from '../../../src/expressions/regex';

const nestedRepetition =
  'This regular expression can take very long on some inputs, because a repeated group contains another repetition. Rewrite it without nested repetition.';
const repeatedAlternatives =
  'This regular expression can take very long on some inputs, because a repeated group contains alternatives. Rewrite it without alternatives inside a repeated group.';
const backreference =
  'This regular expression uses a backreference, which can take very long on some inputs. Rewrite it without one.';
const lookaround =
  'This regular expression uses lookahead or lookbehind, which can take very long on some inputs. Rewrite it without lookaround.';
const tooLong = 'A regular expression is at most 500 characters.';

describe('checkPattern', () => {
  it('accepts plain patterns', () => {
    const patterns = [
      '',
      'abc',
      String.raw`id=(\d+)`,
      String.raw`"token":"([^"]+)"`,
      '^[a-z]+$',
      '(foo|bar)',
      '(foo|bar)?',
      '(?:foo|bar)baz',
      String.raw`\d+(\.\d+)?`,
      '(a+)?',
      '(a+)?b',
      '(?:ab)+',
      '(ab)*c',
      String.raw`(\d{3}-)+`,
      'a+b*c?d{2,3}',
      'a+?b*?',
      String.raw`\(a+\)+`,
      '[(]+',
      '[(a+)+]',
      String.raw`[\]]+`,
      '(?<name>a)+',
      String.raw`\0`,
      String.raw`[\1]`,
      'a{,2}',
      'a{',
      '(a)(b)(c)',
      '((a)(b))+',
      '(a|b)',
      'a|b',
    ];

    for (const pattern of patterns) {
      expect(checkPattern(pattern, ''), pattern).toBeUndefined();
    }
  });

  it('accepts patterns with escapes that take braces', () => {
    expect(checkPattern(String.raw`\u{41}+`, 'u')).toBeUndefined();
    expect(checkPattern(String.raw`\p{L}+`, 'u')).toBeUndefined();
    expect(checkPattern(String.raw`(\p{L}\u{1F600})+`, 'u')).toBeUndefined();
  });

  it('accepts every flag combination of i, m, s and u', () => {
    for (const flags of ['', 'i', 'm', 's', 'u', 'imsu', 'usmi']) {
      expect(checkPattern('a+', flags), flags).toBeUndefined();
    }
  });

  it('accepts a pattern of exactly 500 characters', () => {
    expect(checkPattern('a'.repeat(500), '')).toBeUndefined();
  });

  it('rejects a pattern over 500 characters', () => {
    expect(checkPattern('a'.repeat(501), '')).toBe(tooLong);
  });

  it('rejects backreferences, lookaround, nested quantified groups and patterns over 500 characters', () => {
    const rejected: [string, RegExp][] = [
      ['(a+)+$', /repeated group contains another repetition/],
      ['(a|aa)*b', /repeated group contains alternatives/],
      [String.raw`(\w+\s?)*$`, /repeated group contains another repetition/],
      ['(?=x)', /lookahead or lookbehind/],
      [String.raw`\1`, /backreference/],
      ['a'.repeat(501), /at most 500 characters/],
    ];

    for (const [pattern, problem] of rejected) {
      expect(checkPattern(pattern, ''), pattern).toMatch(problem);
    }
  });

  it('rejects backreferences', () => {
    const patterns = [
      String.raw`\1`,
      String.raw`(a)\1`,
      String.raw`(a)(b)\2`,
      String.raw`(a)\9`,
      String.raw`(?<x>a)\k<x>`,
      String.raw`a\10`,
      String.raw`[a](b)\1`,
    ];

    for (const pattern of patterns) {
      expect(checkPattern(pattern, ''), pattern).toBe(backreference);
    }
  });

  it('rejects lookaround', () => {
    const patterns = ['(?=x)', '(?!x)', '(?<=x)', '(?<!x)', 'a(?=b)', '(a(?!b))', '(?:a(?=b))+'];

    for (const pattern of patterns) {
      expect(checkPattern(pattern, ''), pattern).toBe(lookaround);
    }
  });

  it('rejects a repeated group that contains another repetition', () => {
    const patterns = [
      '(a+)+$',
      '(a*)*',
      '(a+)*',
      '(a*)+',
      '(.*)*',
      '(a+)+',
      '(a?)+',
      String.raw`(\w+\s?)*$`,
      '(a+b)+c',
      '(a+){2,}',
      '(a+){2}',
      '(a+){1,5}',
      '(a{1,5})+',
      '(a{2,})+',
      '(a+)+?',
      '(?:a+)+',
      '(?<x>a+)+',
      '((a+)b)*',
      '(b(a+))+',
      '((a)+)+',
      '(a+|b)+',
      '(x+x+)+y',
      '((a|b)?c)+',
    ];

    for (const pattern of patterns) {
      expect(checkPattern(pattern, ''), pattern).toBe(nestedRepetition);
    }
  });

  it('rejects a repeated group that contains alternatives', () => {
    const patterns = ['(a|aa)*b', '(a|aa)+', '(a|b){2,}', '(foo|bar)+', '(?:a|b)*', '((a|b)c)+'];

    for (const pattern of patterns) {
      expect(checkPattern(pattern, ''), pattern).toBe(repeatedAlternatives);
    }
  });

  it('reports the first problem in the pattern', () => {
    expect(checkPattern(String.raw`\1(a+)+`, '')).toBe(backreference);
    expect(checkPattern(String.raw`(a+)+\1`, '')).toBe(nestedRepetition);
    expect(checkPattern('(?=a)(a+)+', '')).toBe(lookaround);
  });

  it('checks the length before anything else', () => {
    expect(checkPattern('(a+)+'.repeat(101), '')).toBe(tooLong);
  });

  it('rejects flags other than i, m, s and u', () => {
    expect(checkPattern('a', 'g')).toBe(
      'Unsupported regular expression flag `g`. Supported flags are i, m, s and u.',
    );
    expect(checkPattern('a', 'iy')).toBe(
      'Unsupported regular expression flag `y`. Supported flags are i, m, s and u.',
    );
    expect(checkPattern('a', 'ii')).toBe('Duplicate regular expression flag `i`.');
  });

  it('ignores unbalanced parentheses and stray quantifiers instead of throwing', () => {
    for (const pattern of [')', '(', '+', '(+', 'a)+', '((a)', '\\', '[', '(?', '(?<']) {
      expect(() => checkPattern(pattern, ''), pattern).not.toThrow();
    }
  });
});
