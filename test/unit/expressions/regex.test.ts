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
const adjacentRepetitions =
  'This regular expression can take very long on some inputs, because two repetitions next to each other can match the same text. Separate them with a character only one of them matches.';
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
      '(x+y+)+z',
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

  it('rejects two repetitions next to each other that can match the same text', () => {
    const patterns = [
      String.raw`\d+\d+x`,
      'a*a*b',
      String.raw`\w+\s*\w+`,
      '.*a.*b',
      'a+a+',
      'a+a*',
      'a*a+',
      'a{2,}a{3,}',
      'a{2,}a+',
      String.raw`\d+x?\d+`,
      String.raw`\d+x*\d+`,
      String.raw`\d+x{0,3}\d+`,
      String.raw`\d+\.?\d*`,
      String.raw`\d+(\.\d+)?\d+`,
      String.raw`\d+\s*\w+`,
      String.raw`\w+\d\w+`,
      String.raw`.+@.+`,
      String.raw`.+\s+.+`,
      String.raw`\S+\S+`,
      String.raw`\D+\w+`,
      String.raw`\W+\S+`,
      '[a-z]+[a-m]+',
      '[a-z]+[x-z]*',
      '[^a]+[^b]+',
      '[^a-z]+[^0-9]+',
      String.raw`[\d.]+[\d.]+`,
      String.raw`[a\-z]+z+`,
      String.raw`[\w-]+[a-c]+`,
      String.raw`\x41+\x41+`,
      String.raw`\x41+A+`,
      String.raw`A+A+`,
      String.raw`\t+\x09+`,
      String.raw`\w+_+`,
      String.raw`(\d+)(\d+)`,
      String.raw`(?:\d+)\s*(\d+)`,
      String.raw`(\d+)(?:\.(\d+))?(\d+)`,
      '(a+|b)a+',
      '(a+)(b?)a+',
      'a+(b?)a+',
      '((a+))a+',
      '(a+)?a+',
      'x*(a+|b)a*',
      'a+(?:b|a?)a+',
      'a+a{0}a+',
      'a+b{0}a+',
      'a+b{0,0}a+',
      'a+(b)?a+',
      'a+(?:bc)?a+',
      'a+(?:b|c)?a+',
      'a+(b){0,1}a+',
      String.raw`\d+(?:-)?\d+`,
      '(ab)+(cd)+',
      'x+(yz)+',
      '(yz)+x+',
      '(ab)+c+',
      '(ab)*c(de)*',
      '(yz)*(yz)*',
      String.raw`a+\b\s*a+`,
      String.raw`^a+$a+`,
      String.raw`\w+\s*[\w-]+`,
      'a+b*c*a+',
      'a+b?a+',
    ];

    for (const pattern of patterns) {
      expect(checkPattern(pattern, ''), pattern).toBe(adjacentRepetitions);
    }
  });

  it('accepts repetitions that cannot match the same text', () => {
    const patterns = [
      String.raw`\w+@\w+\.\w+`,
      String.raw`\d+-\d+`,
      '[a-z]+[0-9]+',
      '"[^"]*"',
      String.raw`\w+\s+\w+`,
      String.raw`\w+\s*=\s*\w+`,
      String.raw`\S+\s+\S+`,
      String.raw`\s*,\s*`,
      String.raw`\s*\w+\s*`,
      '[^,]+,[^,]+',
      '[^@]+@[^@]+',
      String.raw`\D+\d+`,
      String.raw`\W+\w+`,
      String.raw`\d+\D+`,
      '[^a-z]+[a-z]+',
      '[a-z]+[A-Z]+',
      '[a-c]+[x-z]*',
      String.raw`[\d.]+,[\d.]+`,
      String.raw`[\w-]+\.[\w-]+`,
      String.raw`\x41+\x42+`,
      String.raw`\n+\r+`,
      String.raw`A+B+`,
      String.raw`\d+\d{3}`,
      String.raw`\d+\d?`,
      String.raw`\d+\d{1,3}`,
      'a+a',
      'a+aa',
      'a+b+a+',
      'a+b*a',
      'a+b{2}a+',
      'a+(?:b|c)a+',
      'a+(b)a+',
      'a+(b|c+)d+',
      String.raw`\d+(\.\d+)?`,
      String.raw`-?\d+(\.\d+)?([eE][+-]?\d+)?`,
      String.raw`(\w+):(\w+)`,
      '(a+|b)c',
      '(a+|b)',
      String.raw`(\d+|[a-z]+)`,
      String.raw`\d+|\w+`,
      String.raw`(\d+)|(\w+)`,
      '(a+)|(a+)',
      'a+|a+',
      '(?:a+|b)(?:c+|d)',
      'a+(?:b+|c)c+',
      '(ab)+c',
      '(?:ab)+',
      'a+(?:)b',
      '.*\\n.*',
      '[a-z]+\\d+[a-z]+',
      '^[a-z]+$',
      'a{2}a+',
    ];

    for (const pattern of patterns) {
      expect(checkPattern(pattern, ''), pattern).toBeUndefined();
    }
  });

  it('decides overlap for the dot, case and Unicode word characters from the flags', () => {
    expect(checkPattern('.*\\n.*', '')).toBeUndefined();
    expect(checkPattern('.*\\n.*', 's')).toBe(adjacentRepetitions);
    expect(checkPattern('.+\\u2028.+', '')).toBeUndefined();
    expect(checkPattern('.+\\u2028.+', 's')).toBe(adjacentRepetitions);
    expect(checkPattern('[a-z]+[A-Z]+', '')).toBeUndefined();
    expect(checkPattern('[a-z]+[A-Z]+', 'i')).toBe(adjacentRepetitions);
    expect(checkPattern('a+A+', '')).toBeUndefined();
    expect(checkPattern('a+A+', 'i')).toBe(adjacentRepetitions);
    expect(checkPattern('[^a]+A+', 'i')).toBeUndefined();
    expect(checkPattern('[^a]+A+', '')).toBe(adjacentRepetitions);
    expect(checkPattern('é+É+', '')).toBeUndefined();
    expect(checkPattern('é+É+', 'i')).toBe(adjacentRepetitions);
    expect(checkPattern('\\w+\\u212a+', '')).toBeUndefined();
    expect(checkPattern('\\w+\\u212a+', 'iu')).toBe(adjacentRepetitions);
    expect(checkPattern('[\\u0100-\\uffff]+x+', '')).toBeUndefined();
    expect(checkPattern('[\\u0100-\\uffff]+x+', 'i')).toBe(adjacentRepetitions);
  });

  it('counts anything it cannot decide as overlapping', () => {
    expect(checkPattern(String.raw`\p{L}+\p{L}+`, 'u')).toBe(adjacentRepetitions);
    expect(checkPattern(String.raw`\p{L}+\d+`, 'u')).toBe(adjacentRepetitions);
    expect(checkPattern(String.raw`\d+\P{L}+`, 'u')).toBe(adjacentRepetitions);
    expect(checkPattern(String.raw`[\p{L}]+\d+`, 'u')).toBe(adjacentRepetitions);
    expect(checkPattern(String.raw`[^\p{L}]+\d+`, 'u')).toBe(adjacentRepetitions);
    expect(checkPattern(String.raw`\d+[\1]+`, '')).toBe(adjacentRepetitions);
    expect(checkPattern(String.raw`\d+\u{1F600}+`, 'u')).toBe(adjacentRepetitions);
    expect(checkPattern(String.raw`\d+😀+`, 'u')).toBe(adjacentRepetitions);
  });

  it('reads brace escapes as one escape only with the u flag', () => {
    expect(checkPattern(String.raw`(a\p{1,})+`, '')).toBe(nestedRepetition);
    expect(checkPattern(String.raw`(a\P{1,})+`, '')).toBe(nestedRepetition);
    expect(checkPattern(String.raw`(a\u{1,})+`, '')).toBe(nestedRepetition);
    expect(checkPattern(String.raw`(a\p{1,2})+`, '')).toBe(nestedRepetition);
    expect(checkPattern(String.raw`(a\p{1})+`, '')).toBeUndefined();
    expect(checkPattern(String.raw`\p{1,}\p{1,}`, '')).toBe(adjacentRepetitions);
    expect(checkPattern(String.raw`\p{L}+`, 'u')).toBeUndefined();
    expect(checkPattern(String.raw`\P{L}+`, 'u')).toBeUndefined();
    expect(checkPattern(String.raw`(a\p{L})+`, 'u')).toBeUndefined();
    expect(checkPattern(String.raw`(a\P{Lu})+`, 'u')).toBeUndefined();
    expect(checkPattern(String.raw`\u{41}+`, 'u')).toBeUndefined();
    expect(checkPattern(String.raw`(a\u{41})+`, 'u')).toBeUndefined();
    expect(checkPattern(String.raw`(a\u{41}\u{1F600})+`, 'u')).toBeUndefined();
    expect(checkPattern(String.raw`(a\p{L}+)+`, 'u')).toBe(nestedRepetition);
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
