import { describe, expect, it, vi } from 'vitest';
import {
  checkFlags,
  checkPatternCached,
  compilePattern,
  type CompiledPattern,
} from '../../../src/expressions/regex';

interface Found {
  match: string;
  group: string | undefined;
}

function compile(pattern: string, flags = ''): CompiledPattern {
  const result = compilePattern(pattern, flags);
  if (!result.ok) {
    throw new Error(`${pattern} did not compile: ${result.message} at ${String(result.offset)}`);
  }
  return result.pattern;
}

function rejection(
  pattern: string,
  flags = '',
): { message: string; offset: number; length: number } {
  const result = compilePattern(pattern, flags);
  if (result.ok) {
    throw new Error(`${pattern} compiled`);
  }
  return { message: result.message, offset: result.offset, length: result.length };
}

function expected(pattern: string, flags: string, subject: string): Found | undefined {
  const found = new RegExp(pattern, flags).exec(subject);
  return found === null ? undefined : { match: found[0], group: found[1] };
}

function timed<T>(run: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = run();
  return { value, ms: performance.now() - start };
}

function longestSubject(pattern: CompiledPattern): number {
  let low = 1;
  let high = 1_000_000;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (pattern.test('a'.repeat(middle)) === 'too-long') {
      high = middle - 1;
    } else {
      low = middle;
    }
  }
  return low;
}

function largestCount(build: (count: number) => string): number {
  let count = 1;
  while (compilePattern(build(count + 1), '').ok) {
    count += 1;
  }
  return count;
}

function distinct(count: number): string {
  let text = '';
  for (let index = 0; index < count; index += 1) {
    text += String.fromCodePoint(0x4e00 + index);
  }
  return text;
}

function countRegExpTests(run: () => void): number {
  const spy = vi.spyOn(RegExp.prototype, 'test');
  try {
    run();
    return spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
}

const common = [
  '',
  'a',
  'abc',
  'aaa',
  'abab',
  'xabcx',
  'a\nb\nc',
  'ABC',
  '123',
  'a1b2c3',
  'foo bar',
  '😀a',
];

const commonPatterns = [
  'a',
  'abc',
  'a.c',
  'a|b|c',
  'ab|abc',
  '^a',
  'c$',
  '^abc$',
  'a*',
  'a+',
  'a?',
  'a*?',
  'a+?',
  'a??',
  'a{2}',
  'a{2,}',
  'a{1,2}',
  'a{1,2}?',
  'a{0}',
  '(a)',
  '(a)(b)',
  '(a|b)+',
  '(a|b)*?c',
  '(?:a|b)+',
  '(a+)(a*)',
  '(a+?)(a*)',
  '(a*)(a+)',
  '([a-c]+)',
  '[^a]',
  '[^a-c]+',
  '[a-c]',
  '[abc]{2}',
  String.raw`\d`,
  String.raw`\d+`,
  String.raw`\D+`,
  String.raw`\w+`,
  String.raw`\W+`,
  String.raw`\s`,
  String.raw`\S+`,
  String.raw`\b`,
  String.raw`\bfoo\b`,
  String.raw`\Ba`,
  '(?:)',
  '()',
  '(a)|(b)',
  '(a)?',
  '(a)*',
  '((a)|(b))+',
  'a|',
  '|a',
  '.',
  '.+',
  '.*?b',
];

const specific: [pattern: string, flags: string, subjects: string[]][] = [
  ['<.+?>', '', ['<a><b>', '<<a>>', '']],
  ['<.+>', '', ['<a><b>', '<<a>>', '']],
  ['"(.*?)"', '', ['"a" "b"', '""', '"']],
  [String.raw`(\d+?)(\d*)`, '', ['12345', 'a1']],
  ['a|ab', '', ['ab', 'ba']],
  ['(a|ab)(c|bcd)(d*)', '', ['abcd', 'abc']],
  ['(?:a|ab)c', '', ['abc', 'ac']],
  ['(a|ab|abc)', '', ['abc', 'ab']],
  ['(?:(a)|b)*', '', ['ab', 'ba', 'aab', '']],
  ['(?:(a)|(b))+', '', ['ab', 'ba', 'aabb']],
  ['(z)((a+)?(b+)?(c))*', '', ['zaacbbbcac', 'z', 'zc']],
  ['(a)*', '', ['aaa', 'b']],
  ['(?:(a)|b){2}', '', ['ab', 'ba', 'aa', 'a']],
  ['((a)|b){1,3}', '', ['abab', 'b', 'ba']],
  ['(a(b)?){2}', '', ['abab', 'aab', 'ab']],
  [String.raw`(?<year>\d{4})-(?<month>\d{2})`, '', ['2024-05-17', '24-5']],
  ['(?<a>x)(?<b>y)?', '', ['x', 'xy', 'y']],
  ['(ab){2}', '', ['abab', 'ab', 'ababab']],
  ['(ab){1,3}', '', ['ababab', 'ab', 'abababab']],
  ['(ab){1,3}?', '', ['ababab']],
  ['(a|b){2,3}c', '', ['abc', 'ababc', 'bbbc', 'ac']],
  [String.raw`\d{3}-\d{4}`, '', ['555-1234 x', '55-1234']],
  ['(a{1,2}){2}', '', ['aaa', 'aaaa', 'a']],
  ['a{2,3}?', '', ['aaaa', 'a']],
  ['(a?){3}', '', ['aa', 'aaaa', '']],
  ['(a*){2}', '', ['aaa', '', 'b']],
  ['(a*)(b*)', '', ['aabb', 'bb', '']],
  ['(?:a*){3}b', '', ['aab', 'b', 'a']],
  ['(a+)+b', '', ['aaab', 'aaa']],
  ['(a+|b+)*c', '', ['aabbc', 'abab']],
  ['(a|b)*c|d', '', ['abc', 'd', 'ab']],
  ['^a', 'm', ['a\na', 'b\na', 'ba']],
  ['a$', 'm', ['a\na', 'a\nb', 'ba']],
  ['^$', 'm', ['', 'a\n\nb']],
  ['^', 'm', ['a\nb']],
  ['$', 'm', ['a\nb']],
  ['^b', '', ['a\nb']],
  [String.raw`\r$`, 'm', ['a\r\nb']],
  ['^.$', 'm', ['a b', 'ab\ncd']],
  ['a.b', '', ['a\nb', 'a b', 'a\rb', 'axb']],
  ['a.b', 's', ['a\nb', 'a b']],
  ['.+', '', ['a\nb']],
  ['.+', 's', ['a\nb']],
  ['^.$', 'su', ['😀', 'ab']],
  ['abc', 'i', ['ABC', 'aBc', 'xABCx', 'ab']],
  ['[a-c]+', 'i', ['ABCabc', 'xyz']],
  ['[^a]', 'i', ['A', 'b', 'aA']],
  ['é+', 'i', ['ÉÉé', 'e']],
  ['ß', 'i', ['SS', 'ß', 'ẞ']],
  ['k', 'iu', ['K', 'K']],
  ['k', 'i', ['K', 'K']],
  ['ſ', 'i', ['s', 'S']],
  ['ſ', 'iu', ['s', 'S']],
  [String.raw`\w+`, 'iu', ['ſ', 'K', 's', '!']],
  [String.raw`\w+`, 'i', ['ſ', 'K', 's']],
  [String.raw`\W+`, 'iu', ['S', 'K', '!']],
  ['ΐ+ΐ+$', 'iu', ['ΐΐ', 'ΐ', 'ΐΐ', 'ΐ!']],
  ['ΐ', 'i', ['ΐ', 'ΐ']],
  ['ΐ', 'iu', ['ΐ', 'ΐ']],
  ['σ', 'i', ['Σ', 'ς']],
  ['σ', 'iu', ['Σ', 'ς']],
  ['[σ]', 'iu', ['ς', 'Σ']],
  [String.raw`K`, 'iu', ['k', 'K']],
  [String.raw`K`, 'i', ['k', 'K']],
  [String.raw`[a-z]+`, 'iu', ['Kſ']],
  [String.raw`\p{L}+`, 'u', ['héllo wörld', '日本語', '123', '']],
  [String.raw`\P{L}+`, 'u', ['ab12cd', 'abc']],
  [String.raw`\p{Lu}\p{Ll}+`, 'u', ['Hello world', 'hello']],
  [String.raw`[\p{L}\d]+`, 'u', ['ab12!', '!']],
  [String.raw`[^\p{L}]+`, 'u', ['ab12!x', 'abc']],
  [String.raw`\p{Script=Greek}+`, 'u', ['αβγabc', 'abc']],
  [String.raw`\p{L}+`, 'iu', ['Éé']],
  [String.raw`\p{Lu}`, 'iu', ['a', 'A', '1']],
  [String.raw`\p{L}`, '', ['p{L}', 'L']],
  ['^.$', 'u', ['😀', 'a', '😀😀']],
  ['^.$', '', ['😀', 'a']],
  ['^..$', '', ['😀']],
  ['😀+', 'u', ['😀😀', 'a😀']],
  ['[😀]', 'u', ['😀', 'a']],
  ['[😀]', '', ['😀', '\ud83d', '\ude00']],
  [String.raw`\u{1F600}`, 'u', ['😀', 'a']],
  [String.raw`\u{1F600}`, '', ['u{1F600}']],
  [String.raw`😀`, 'u', ['😀']],
  [String.raw`😀`, '', ['😀']],
  ['[^a]', 'u', ['😀', 'a']],
  ['.', 'u', ['😀x', 'x']],
  [String.raw`\S`, 'u', ['😀']],
  [String.raw`^\W$`, 'u', ['😀']],
  [String.raw`[\u{1F600}-\u{1F64F}]+`, 'u', ['😀😁x', 'x']],
  ['a.b', 'u', ['a😀b', 'ab']],
  ['a.b', '', ['a😀b', 'ab']],
  ['a..b', '', ['a😀b']],
  ['.', 'u', ['\ud83d', '\ude00']],
  ['^.$', 'u', ['\ud83dx']],
  ['^.*$', 'u', ['a😀\ude00']],
  [String.raw`\x41`, '', ['A', 'a']],
  [String.raw`A`, '', ['A']],
  [String.raw`\cJ`, '', ['\n', 'J']],
  [String.raw`\0`, '', ['\0', '0']],
  [String.raw`[\n\r\t]+`, '', ['\t\n', 'x']],
  [String.raw`\f\v`, '', ['\f\v']],
  [String.raw`\/`, '', ['/', 'a']],
  [String.raw`\-`, '', ['-']],
  [String.raw`[\b]`, '', ['\b', 'b']],
  [String.raw`\.`, '', ['.', 'a']],
  ['a{,2}', '', ['a{,2}', 'a']],
  ['a{', '', ['a{', 'a']],
  ['a}', '', ['a}']],
  [']', '', [']']],
  ['[a-]+', '', ['a-', 'b']],
  ['[-a]+', '', ['a-', 'b']],
  [String.raw`[\]]`, '', [']']],
  [String.raw`[\\]`, '', ['\\']],
  ['[^]', '', ['a', '']],
  ['[]', '', ['a', '']],
  [String.raw`[\d-x]+`, '', ['1-x', 'a']],
  [String.raw`[a\-z]+`, '', ['a-z', 'b']],
  [String.raw`\a`, '', ['a']],
  [String.raw`\_`, '', ['_']],
  [String.raw`[\w-]+`, '', ['a-b_c', '!']],
  [String.raw`\u{41}`, '', ['u'.repeat(41), 'A']],
  ['x{2}{', '', ['xx{']],
  ['[a-c-e]+', '', ['a-e', 'abcde']],
  ['"threadId":"([^"]+)"', '', ['{"threadId":"t-1","x":1}', '{"threadId":""}']],
  [String.raw`id=(\d+)`, '', ['id=42&x=1', 'id=', 'x']],
  [String.raw`^\s*(\w+)\s*=\s*(.*?)\s*$`, '', ['  key = value  ', 'k=', 'k', '=v']],
  [String.raw`(\d+)\.(\d+)\.(\d+)`, '', ['v1.22.333-rc', '1.2']],
  [String.raw`\b(?:GET|POST)\b`, '', ['a POST b', 'POSTS', 'GET']],
  [String.raw`[^@\s]+@[^@\s]+\.[a-z]{2,}`, '', ['x a@b.co y', 'a@b', '@b.co']],
  [String.raw`(\w+)@(\w+)\.com`, '', ['me@site.com', 'me@site.org']],
  [String.raw`^(\d{3})-(\d{4})$`, '', ['555-1234', '555-12345']],
  ['(?:^|,)([^,]*)', '', ['a,b,,c', '', ',']],
  ['((a)(b))c', '', ['abc', 'ab']],
  ['(a(b(c)))', '', ['abc']],
  ['(?:(a)|(b)|(c))+', '', ['abc', 'cba']],
  ['', '', ['', 'a']],
  ['^$', '', ['', 'a']],
  ['x*', '', ['aaa', 'xaa', '']],
  ['(a*)b', '', ['aab', 'b', 'a']],
  ['(?:a|b)*?c', '', ['abc', 'c']],
  ['a+?$', '', ['aaa', 'aab']],
  ['(a+?)(b+?)', '', ['aabb']],
  ['(.)(.)(.)', '', ['abcd', 'ab']],
  [String.raw`(\w)\s(\w)`, '', ['a b', 'ab']],
  ['a|b|', '', ['c', 'b']],
  ['(?:|a)b', '', ['ab', 'b']],
  ['(a|)b', '', ['ab', 'b', 'xb']],
  ['((((((((((a))))))))))', '', ['a']],
];

describe('compilePattern', () => {
  it('agrees with JavaScript on the table of patterns and subjects', () => {
    const cases: [string, string, string][] = [];
    for (const pattern of commonPatterns) {
      for (const flags of ['', 'i', 'u', 'm', 's']) {
        for (const subject of common) {
          cases.push([pattern, flags, subject]);
        }
      }
    }
    for (const [pattern, flags, subjects] of specific) {
      for (const subject of subjects) {
        cases.push([pattern, flags, subject]);
      }
    }

    expect(cases.length).toBeGreaterThanOrEqual(200);

    for (const [pattern, flags, subject] of cases) {
      const label = `/${pattern}/${flags} on ${JSON.stringify(subject)}`;
      const compiled = compile(pattern, flags);
      const want = expected(pattern, flags, subject);

      expect(compiled.firstMatch(subject), label).toStrictEqual(want);
      expect(compiled.test(subject), label).toBe(want !== undefined);
    }
  });

  it('keeps the match and group 1 of the famous specification example', () => {
    expect(compile('(z)((a+)?(b+)?(c))*').firstMatch('zaacbbbcac')).toStrictEqual({
      match: 'zaacbbbcac',
      group: 'z',
    });
  });

  it('returns group 1 as undefined when it did not take part', () => {
    expect(compile('(a)|(b)').firstMatch('b')).toStrictEqual({ match: 'b', group: undefined });
    expect(compile('(a)?b').firstMatch('b')).toStrictEqual({ match: 'b', group: undefined });
    expect(compile('a(b)?').firstMatch('a')).toStrictEqual({ match: 'a', group: undefined });
  });

  it('returns group 1 as undefined when there is no group', () => {
    expect(compile('ab').firstMatch('xab')).toStrictEqual({ match: 'ab', group: undefined });
  });

  it('returns the last iteration of group 1 inside a repetition, and undefined after a reset', () => {
    expect(compile('(a|b)+').firstMatch('abba')).toStrictEqual({ match: 'abba', group: 'a' });
    expect(compile('(?:(a)|b)*').firstMatch('ab')).toStrictEqual({ match: 'ab', group: undefined });
    expect(compile('(?:(a)|b)*').firstMatch('ba')).toStrictEqual({ match: 'ba', group: 'a' });
    expect(compile('((a)|b){1,3}').firstMatch('abab')).toStrictEqual({ match: 'aba', group: 'a' });
    expect(compile('(a(b)?)+').firstMatch('aab')).toStrictEqual({ match: 'aab', group: 'ab' });
  });

  it('numbers group 1 as the first opening parenthesis, whatever the nesting', () => {
    expect(compile('((a)(b))c').firstMatch('abc')).toStrictEqual({ match: 'abc', group: 'ab' });
    expect(compile('(?:(a)|(b))+').firstMatch('ab')).toStrictEqual({
      match: 'ab',
      group: undefined,
    });
    expect(compile('(?<first>x)(?<second>y)').firstMatch('xy')).toStrictEqual({
      match: 'xy',
      group: 'x',
    });
  });

  it('reuses one compiled pattern for many subjects and both methods', () => {
    const pattern = compile(String.raw`(\d+)-(\d+)`);

    expect(pattern.test('1-2')).toBe(true);
    expect(pattern.firstMatch('x 10-20 y')).toStrictEqual({ match: '10-20', group: '10' });
    expect(pattern.test('1-')).toBe(false);
    expect(pattern.firstMatch('1-')).toBeUndefined();
    expect(pattern.firstMatch('3-4')).toStrictEqual({ match: '3-4', group: '3' });
  });

  it('never matches between the halves of a surrogate pair with u', () => {
    expect(compile('\\B', 'u').test('a😀a')).toBe(false);
    expect(compile('\\B', '').firstMatch('a😀a')).toStrictEqual({ match: '', group: undefined });
  });

  it('matches against a lone surrogate and an astral character with and without u', () => {
    expect(compile('^.$', 'u').test('\ud83d')).toBe(true);
    expect(compile('^.$').test('😀')).toBe(false);
    expect(compile('^..$').test('😀')).toBe(true);
  });
});

describe('the former bypasses of the static check', () => {
  it('rejects counts that do not fit in the program', () => {
    for (const pattern of [
      'a{1,99999}a{1,99999}$',
      String.raw`\d{1,99999}\d{1,99999}x`,
      '.{0,50000}.{0,50000}x',
    ]) {
      expect(rejection(pattern).message, pattern).toBe(
        'The repetition count is too large for this regular expression.',
      );
    }
  });

  it('rejects an inline modifier group', () => {
    expect(rejection('a+(?i:A+)$')).toStrictEqual({
      message:
        'Inline modifiers such as `(?i:…)` are not supported in regular expressions. Put the flag after the closing slash instead.',
      offset: 2,
      length: 4,
    });
  });

  const hostile: [label: string, pattern: string, flags: string, subject: string][] = [
    ['.? thirty times then x', '.?'.repeat(30) + 'x', '', 'a'.repeat(30)],
    ['(?:a{0,2}) 25 times then x', '(?:a{0,2})'.repeat(25) + 'x', '', 'a'.repeat(50)],
    ['(?:\\w|\\d) 30 times then !', String.raw`(?:\w|\d)`.repeat(30) + '!', '', '1'.repeat(30)],
    ['(a|a) 28 times then x', '(a|a)'.repeat(28) + 'x', '', 'a'.repeat(28)],
    ['ΐ+ΐ+$ with iu', 'ΐ+ΐ+$', 'iu', 'ΐ'.repeat(20000) + '!'],
    ['\\d+x on 40,000 digits', String.raw`\d+x`, '', '1'.repeat(40000)],
    ['(a+)+$ on a failing subject', '(a+)+$', '', 'a'.repeat(15000) + '!'],
    ['(a|aa)*b on a failing subject', '(a|aa)*b', '', 'a'.repeat(15000)],
    ['\\w+\\s*\\w+x on words', String.raw`\w+\s*\w+x`, '', 'a'.repeat(30000)],
    ['.*a.*b on a failing subject', '.*a.*b', '', 'a'.repeat(30000)],
  ];

  it.each(hostile)('runs %s in under 100 ms', (_label, pattern, flags, subject) => {
    const compiled = compile(pattern, flags);
    const { value, ms } = timed(() => compiled.test(subject));

    expect(value).toBe(false);
    expect(ms).toBeLessThan(100);
  });

  it('answers \\d+x on 100,000 digits at once, as too long, and on a subject at the limit in under 100 ms', () => {
    const compiled = compile(String.raw`\d+x`);
    const refused = timed(() => compiled.test('1'.repeat(100000)));
    const atLimit = timed(() => compiled.test('1'.repeat(longestSubject(compiled))));

    expect(refused.value).toBe('too-long');
    expect(refused.ms).toBeLessThan(100);
    expect(atLimit.value).toBe(false);
    expect(atLimit.ms).toBeLessThan(100);
  });

  it('gives the same answer as JavaScript on the hostile patterns with short subjects', () => {
    const short: [string, string, string][] = [
      ['.?'.repeat(6) + 'x', '', 'aaaaaa'],
      ['(?:a{0,2})'.repeat(4) + 'x', '', 'aaaaaaaa'],
      [String.raw`(?:\w|\d)`.repeat(5) + '!', '', '11111'],
      ['(a|a)'.repeat(5) + 'x', '', 'aaaaa'],
      ['ΐ+ΐ+$', 'iu', 'ΐΐΐ!'],
      ['(a+)+$', '', 'aaaa!'],
      ['(a|aa)*b', '', 'aaaa'],
      ['(a|aa)*b', '', 'aaaab'],
    ];

    for (const [pattern, flags, subject] of short) {
      expect(compile(pattern, flags).firstMatch(subject), pattern).toStrictEqual(
        expected(pattern, flags, subject),
      );
    }
  });
});

describe('limits', () => {
  it('accepts a pattern of exactly 500 characters and rejects 501', () => {
    expect(compilePattern('a'.repeat(500), '').ok).toBe(true);
    expect(rejection('a'.repeat(501))).toStrictEqual({
      message: 'A regular expression is at most 500 characters.',
      offset: 500,
      length: 1,
    });
  });

  it('rejects a program of more than 2,000 instructions', () => {
    expect(rejection('(?:a|b){1,1000}c')).toStrictEqual({
      message: 'This regular expression is too large.',
      offset: 0,
      length: 15,
    });
    expect(compilePattern('a{1,900}', '').ok).toBe(true);
    expect(rejection('a{1,1100}').message).toBe('This regular expression is too large.');
  });

  it('returns too-long when the subject length times the program size is over 1,000,000', () => {
    const pattern = compile('a');
    let low = 1;
    let high = 1_000_000;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (pattern.test('b'.repeat(middle)) === 'too-long') {
        high = middle - 1;
      } else {
        low = middle;
      }
    }

    expect(low).toBe(47_619);
    expect(pattern.test('b'.repeat(low))).toBe(false);
    expect(pattern.test('b'.repeat(low + 1))).toBe('too-long');
    expect(pattern.firstMatch('b'.repeat(low + 1))).toBe('too-long');
    expect(pattern.firstMatch('b'.repeat(low))).toBeUndefined();
  });

  it('finishes a program at the instruction limit on a subject at the work limit within 100 ms', () => {
    const count = largestCount((n) => `a{1,${String(n)}}b`);
    const pattern = compile(`a{1,${String(count)}}b`);
    const length = longestSubject(pattern);
    const subject = 'a'.repeat(length);

    expect(count).toBeGreaterThan(900);
    expect(length * 2000).toBeGreaterThan(900_000);

    const { value, ms } = timed(() => pattern.test(subject));
    const firstMatch = timed(() => pattern.firstMatch(subject));

    expect(value).toBe(false);
    expect(firstMatch.value).toBeUndefined();
    expect(ms).toBeLessThan(100);
    expect(firstMatch.ms).toBeLessThan(100);
  });

  it('finishes the same on a capture-heavy program at the limit', () => {
    const count = largestCount((n) => `(?:(a)|(b)){1,${String(n)}}c`);
    const pattern = compile(`(?:(a)|(b)){1,${String(count)}}c`);
    const length = longestSubject(pattern);
    const subject = 'ab'.repeat(Math.floor(length / 2));

    const { value, ms } = timed(() => pattern.firstMatch(subject));

    expect(value).toBeUndefined();
    expect(ms).toBeLessThan(100);
  });

  it('finishes a program full of case-folded atoms at the limit within 100 ms', () => {
    const count = largestCount((n) => `(?:é|ΐ){1,${String(n)}}x`);
    const pattern = compile(`(?:é|ΐ){1,${String(count)}}x`, 'iu');
    const subject = 'éΐ'.repeat(Math.floor(longestSubject(pattern) / 2));

    const { value, ms } = timed(() => pattern.test(subject));

    expect(value).toBe(false);
    expect(ms).toBeLessThan(100);
  });
});

describe('cost at the work limit', () => {
  const captureFamilies: [label: string, pattern: string][] = [
    ['248 nested groups then x', '('.repeat(248) + 'a' + ')'.repeat(248) + 'x'],
    ['248 empty groups then x', '()'.repeat(248) + 'x'],
    ['166 groups of a then x', '(a)'.repeat(166) + 'x'],
    ['an outer group around 10 groups, repeated', '(' + String.raw`(\w)`.repeat(10) + ')+!'],
    ['(a|a) 28 times then x', '(a|a)'.repeat(28) + 'x'],
  ];

  it.each(captureFamilies)('runs firstMatch for %s in under 100 ms', (_label, pattern) => {
    const compiled = compile(pattern);
    const subject = 'a'.repeat(longestSubject(compiled));

    const { value, ms } = timed(() => compiled.firstMatch(subject));

    expect(value).toBeUndefined();
    expect(ms).toBeLessThan(100);
  });

  const foldedFamilies: [label: string, pattern: string, flags: string][] = [
    ['\\W 249 times with iu', String.raw`\W`.repeat(249) + '!', 'iu'],
    ['[^a] 124 times with i', '[^a]'.repeat(124) + '!', 'i'],
    ['\\p{L} 99 times with u', String.raw`\p{L}`.repeat(99) + '!', 'u'],
    ['[^\\p{Lu}] 55 times with iu', String.raw`[^\p{Lu}]`.repeat(55) + '!', 'iu'],
  ];

  it.each(foldedFamilies)(
    'runs test for %s on distinct characters in under 100 ms',
    (_label, pattern, flags) => {
      const compiled = compile(pattern, flags);
      const subject = distinct(longestSubject(compiled));

      const { value, ms } = timed(() => compiled.test(subject));

      expect(value).toBe(false);
      expect(ms).toBeLessThan(100);
    },
  );

  it('weighs an atom that needs case folding or a property as 8 instructions', () => {
    expect(longestSubject(compile('[^a]'))).toBe(47_619);
    expect(longestSubject(compile('[^a]', 'i'))).toBe(35_714);
    expect(longestSubject(compile(String.raw`\p{L}`, 'u'))).toBe(35_714);
    expect(longestSubject(compile(String.raw`\w`, 'iu'))).toBe(35_714);
    expect(longestSubject(compile(String.raw`\w`, 'i'))).toBe(47_619);
  });
});

describe('nested groups and repeats that copy the capture slots', () => {
  function nested(inner: string, levels: number): string {
    let pattern = inner;
    for (let level = 0; level < levels; level += 1) {
      pattern = `(?:${pattern}){1}`;
    }
    return pattern;
  }

  it('emits one clear for any number of {1} repeats directly around a group', () => {
    const once = longestSubject(compile('(?:(a)){1}x'));

    expect(longestSubject(compile(nested('(a)', 3) + 'x'))).toBe(once);
    expect(longestSubject(compile(nested('(a)', 69) + 'x'))).toBe(once);
    expect(longestSubject(compile(nested('(a)?', 8) + 'x'))).toBe(
      longestSubject(compile('(?:(a)?){1}x')),
    );
  });

  it('weighs a save and a clear as 8 instructions in the work limit', () => {
    expect(longestSubject(compile('(a)x'))).toBe(26_315);
    expect(longestSubject(compile('(?:(a)){1}x'))).toBe(21_739);
    expect(longestSubject(compile('(?:(a)){2}x'))).toBe(14_084);
  });

  it('keeps a clear at the start of every iteration of a loop, whatever surrounds it', () => {
    const patterns = [
      '(?:(?:(a)|b)+)',
      '(?:(?:(a)|b)+){1}',
      '(?:(?:(?:(a)|b)+){1}){1}',
      '(?:(?:(a)|b)+)+',
      '(?:(?:(?:(a)|b)*){1}){2}',
      '(?:(?:(a)|b)*){1}',
      '(?:(?:(?:(a)|b)){1}){1}',
      '(?:(?:(a)|b){2,}){1}',
      '(?:(?:(a)|b)+?){1}',
    ];

    for (const pattern of patterns) {
      for (const subject of ['ab', 'ba', 'abb', 'bab', 'aab', 'b', '']) {
        expect(compile(pattern).firstMatch(subject), `${pattern} on ${subject}`).toStrictEqual(
          expected(pattern, '', subject),
        );
      }
    }
  });

  const families: [label: string, pattern: string][] = [
    ['69 nested {1} around (a), repeated 27 times, then x', `(?:${nested('(a)', 69)}){27}x`],
    [
      '8 nested {1} around (a)?, repeated to the instruction limit, then x',
      `(?:${nested('(a)?', 8)}){${String(largestCount((n) => `(?:${nested('(a)?', 8)}){${String(n)}}x`))}}x`,
    ],
    ['(?:(a)?){332}x', '(?:(a)?){332}x'],
    ['(?:(?:(a)?){5}){64}x', '(?:(?:(a)?){5}){64}x'],
  ];

  it.each(families)(
    'runs firstMatch for %s at the work limit in under 100 ms',
    (_label, pattern) => {
      const compiled = compile(pattern);
      const subject = 'a'.repeat(longestSubject(compiled));

      const { value, ms } = timed(() => compiled.firstMatch(subject));

      expect(value).toBeUndefined();
      expect(ms).toBeLessThan(100);
    },
  );
});

describe('the case-folding cache', () => {
  it('keeps at most 256 results per atom and evicts the oldest', () => {
    const pattern = compile(String.raw`\W+!`, 'iu');
    const fits = distinct(256);
    const overflows = distinct(257);

    expect(countRegExpTests(() => pattern.test(fits))).toBe(256);
    expect(countRegExpTests(() => pattern.test(fits))).toBe(0);
    expect(countRegExpTests(() => pattern.test(overflows))).toBe(1);
    expect(countRegExpTests(() => pattern.test(overflows))).toBe(257);
  });

  it('keeps at most 16,384 results per pattern', () => {
    const pattern = compile(String.raw`\W?`.repeat(65) + '!', 'iu');
    const subject = distinct(256);

    const first = countRegExpTests(() => pattern.test(subject));
    const second = countRegExpTests(() => pattern.test(subject));

    expect(first).toBe(65 * 256);
    expect(second).toBeGreaterThanOrEqual(65 * 256 - 16_384);
  });

  it('shares one cache between the copies of a counted repetition', () => {
    const pattern = compile(String.raw`(?:\W?){65}!`, 'iu');

    expect(countRegExpTests(() => pattern.test(distinct(256)))).toBe(256);
  });
});

describe('compilePattern', () => {
  it('builds a new matcher on every call', () => {
    const first = compilePattern('fresh+(x)', 'iu');
    const second = compilePattern('fresh+(x)', 'iu');

    expect(first.ok && second.ok).toBe(true);
    expect(second).not.toBe(first);
    expect(second.ok && first.ok && second.pattern !== first.pattern).toBe(true);
  });
});

describe('the pattern validation cache', () => {
  function collect(): void {
    (globalThis as unknown as { gc: () => void }).gc();
  }

  it('answers a valid pattern with ok and nothing else', () => {
    expect(checkPatternCached('valid+(x)', 'iu')).toStrictEqual({ ok: true });
  });

  it('answers a rejected pattern as compilePattern does', () => {
    const rejected: [string, string][] = [
      [String.raw`(a)\1`, ''],
      ['(?=a)b', 'u'],
      ['(unclosed', ''],
      ['a', 'g'],
      ['a', 'ii'],
      ['a'.repeat(501), ''],
    ];

    for (const [pattern, flags] of rejected) {
      const direct = compilePattern(pattern, flags);

      expect(direct.ok, pattern).toBe(false);
      expect(checkPatternCached(pattern, flags), pattern).toStrictEqual(direct);
      expect(checkPatternCached(pattern, flags), pattern).toStrictEqual(direct);
    }
  });

  it('returns the same outcome for the same pattern and flags', () => {
    const outcome = checkPatternCached('cached+(x)', 'iu');
    const rejection = checkPatternCached('(cached', 'u');

    expect(checkPatternCached('cached+(x)', 'iu')).toBe(outcome);
    expect(checkPatternCached('(cached', 'u')).toBe(rejection);
    expect(rejection.ok).toBe(false);
  });

  it('keeps the flags and the pattern apart', () => {
    expect(checkPatternCached('cased', 'i')).not.toBe(checkPatternCached('cased', ''));
    expect(checkPatternCached('i/cased', '')).not.toBe(checkPatternCached('cased', 'i'));
    expect(checkPatternCached('(cased', '').ok).toBe(false);
    expect(checkPatternCached('cased', '').ok).toBe(true);
  });

  it('does not keep a pattern over 500 characters or an unsupported flag', () => {
    const long = 'a'.repeat(501);

    expect(checkPatternCached(long, '')).toEqual(checkPatternCached(long, ''));
    expect(checkPatternCached(long, '')).not.toBe(checkPatternCached(long, ''));
    expect(checkPatternCached('a', 'g')).not.toBe(checkPatternCached('a', 'g'));
  });

  it('keeps at most 256 entries and evicts the oldest', () => {
    const pattern = (index: number): string => `bound${String(index)}x`;
    const outcomes = Array.from({ length: 256 }, (_, index) =>
      checkPatternCached(pattern(index), ''),
    );

    expect(checkPatternCached(pattern(0), '')).toBe(outcomes[0]);

    checkPatternCached(pattern(256), '');

    expect(checkPatternCached(pattern(0), '')).not.toBe(outcomes[0]);
    expect(checkPatternCached(pattern(2), '')).toBe(outcomes[2]);
    expect(checkPatternCached(pattern(1), '')).not.toBe(outcomes[1]);
  });

  it('retains no matcher, however many patterns it has checked and run', () => {
    const subject = distinct(256);
    collect();
    const before = process.memoryUsage().heapUsed;

    for (let index = 0; index < 256; index += 1) {
      const pattern = `${String.raw`\W?`.repeat(65)}!${String(index)}`;

      expect(checkPatternCached(pattern, 'iu')).toStrictEqual({ ok: true });
      compile(pattern, 'iu').test(subject);
    }
    collect();

    expect(process.memoryUsage().heapUsed - before).toBeLessThan(4 * 1024 * 1024);
  });
});

describe('rejected syntax', () => {
  const backreference = 'Backreferences such as `\\1` are not supported in regular expressions.';
  const lookahead = 'Lookahead such as `(?=…)` is not supported in regular expressions.';
  const lookbehind = 'Lookbehind such as `(?<=…)` is not supported in regular expressions.';
  const modifier =
    'Inline modifiers such as `(?i:…)` are not supported in regular expressions. Put the flag after the closing slash instead.';
  const empty =
    'A repeated group that can match the empty string is not supported in regular expressions.';
  const octal = 'Octal escapes are not supported in regular expressions.';
  const invalidEscape = 'Invalid escape sequence.';
  const property = 'This Unicode property escape or character class is not valid.';
  const nothing = 'Nothing to repeat.';

  const table: [pattern: string, flags: string, message: string, offset: number, length: number][] =
    [
      [String.raw`\1`, '', backreference, 0, 2],
      [String.raw`(a)\2`, '', backreference, 3, 2],
      [String.raw`a\9`, '', backreference, 1, 2],
      [
        String.raw`\k<name>`,
        '',
        'Named backreferences such as `\\k<name>` are not supported in regular expressions.',
        0,
        8,
      ],
      [
        String.raw`(?<n>a)\k<n>`,
        '',
        'Named backreferences such as `\\k<name>` are not supported in regular expressions.',
        7,
        5,
      ],
      ['(?=a)', '', lookahead, 0, 3],
      ['a(?!b)', '', lookahead, 1, 3],
      ['(?<=a)', '', lookbehind, 0, 4],
      ['(?<!a)', '', lookbehind, 0, 4],
      ['a+(?i:A+)$', '', modifier, 2, 4],
      ['(?-i:a)', '', modifier, 0, 5],
      ['(?i)a', '', modifier, 0, 3],
      ['(?#c)', '', 'This group syntax is not supported in regular expressions.', 0, 3],
      ['(?', '', 'This group syntax is not supported in regular expressions.', 0, 2],
      ['(a*)*', '', empty, 0, 5],
      ['(?:a|)+', '', empty, 0, 7],
      ['(a?)?', '', empty, 0, 5],
      ['x(\\b)*', '', empty, 1, 5],
      ['(a*)+b', '', empty, 0, 5],
      ['(?:a*|b){2,}', '', empty, 0, 12],
      ['(a*){1,3}', '', empty, 0, 9],
      ['(?:)*', '', empty, 0, 5],
      ['(?:^)?', '', empty, 0, 6],
      [String.raw`(?:\b)*`, '', empty, 0, 7],
      ['a{3,2}', '', 'The numbers in a quantifier are out of order.', 1, 5],
      ['a{99999}', '', 'The repetition count is too large for this regular expression.', 1, 7],
      ['a{1,3000}', '', 'The repetition count is too large for this regular expression.', 1, 8],
      [
        'a{99999999999999999999}',
        '',
        'The repetition count is too large for this regular expression.',
        1,
        22,
      ],
      ['(', '', 'Unterminated group.', 0, 1],
      ['(a', '', 'Unterminated group.', 0, 1],
      ['(?:a', '', 'Unterminated group.', 0, 1],
      ['a(b(c)', '', 'Unterminated group.', 1, 1],
      [')', '', 'Unmatched `)`.', 0, 1],
      ['a)', '', 'Unmatched `)`.', 1, 1],
      ['[a', '', 'Unterminated character class.', 0, 1],
      ['[', '', 'Unterminated character class.', 0, 1],
      ['[^', '', 'Unterminated character class.', 0, 1],
      ['[b-a]', '', 'The range in the character class is out of order.', 1, 3],
      [
        String.raw`[\u{1F600}-\u{1F5FF}]`,
        'u',
        'The range in the character class is out of order.',
        1,
        19,
      ],
      ['*a', '', nothing, 0, 1],
      ['+', '', nothing, 0, 1],
      ['?', '', nothing, 0, 1],
      ['a**', '', nothing, 2, 1],
      ['a+*', '', nothing, 2, 1],
      ['a{2}{3}', '', nothing, 4, 3],
      ['{2}', '', nothing, 0, 3],
      ['^*', '', nothing, 1, 1],
      ['$+', '', nothing, 1, 1],
      [String.raw`\b+`, '', nothing, 2, 1],
      [String.raw`\B{2}`, '', nothing, 2, 3],
      ['a|*', '', nothing, 2, 1],
      ['(*a)', '', nothing, 1, 1],
      ['a+??', '', nothing, 3, 1],
      [String.raw`\a`, 'u', invalidEscape, 0, 2],
      [String.raw`\-`, 'u', invalidEscape, 0, 2],
      [String.raw`\x4`, 'u', invalidEscape, 0, 2],
      [String.raw`\u12`, 'u', invalidEscape, 0, 2],
      [String.raw`\u{110000}`, 'u', invalidEscape, 0, 10],
      ['a{', 'u', 'Incomplete quantifier.', 1, 1],
      ['{', 'u', 'Unexpected `{`.', 0, 1],
      ['}', 'u', 'Unexpected `}`.', 0, 1],
      [']', 'u', 'Unexpected `]`.', 0, 1],
      [String.raw`\p{Nope}`, 'u', property, 0, 8],
      [String.raw`[\p{Nope}]`, 'u', property, 0, 10],
      [String.raw`a\p`, 'u', property, 1, 2],
      [String.raw`[a-\d]`, 'u', 'Invalid character class range.', 1, 4],
      [String.raw`[\d-a]`, 'u', 'Invalid character class range.', 1, 4],
      [String.raw`\c`, '', 'A control escape needs a letter after `\\c`.', 0, 2],
      [String.raw`\c1`, '', 'A control escape needs a letter after `\\c`.', 0, 2],
      [String.raw`\01`, '', octal, 0, 2],
      [String.raw`[\1]`, '', octal, 1, 2],
      [
        String.raw`[\k]`,
        '',
        'Named backreferences such as `\\k<name>` are not supported in regular expressions.',
        1,
        2,
      ],
      ['\\', '', 'A backslash at the end of the regular expression has nothing to escape.', 0, 1],
      ['a\\', '', 'A backslash at the end of the regular expression has nothing to escape.', 1, 1],
      ['(?<a>x)(?<a>y)', '', 'Duplicate group name `a`.', 10, 1],
      ['(?<1a>x)', '', 'Invalid group name.', 3, 2],
      ['(?<>x)', '', 'Invalid group name.', 2, 2],
      ['(?<a', '', 'Unterminated group name.', 0, 3],
      ['(?<a-b>x)', '', 'Invalid group name.', 3, 3],
    ];

  it.each(table)(
    'rejects %s with flags "%s" at its offset',
    (pattern, flags, message, offset, length) => {
      expect(rejection(pattern, flags)).toStrictEqual({ message, offset, length });
    },
  );

  it('reports an invalid flag with the flag message', () => {
    expect(rejection('a', 'g')).toStrictEqual({
      message: 'Unsupported regular expression flag `g`. Supported flags are i, m, s and u.',
      offset: 0,
      length: 1,
    });
    expect(rejection('a', 'ii').message).toBe('Duplicate regular expression flag `i`.');
  });

  it('treats a group around an assertion as a group, not as an assertion', () => {
    expect(compilePattern('(?:^)a', '').ok).toBe(true);
    expect(compilePattern('(?:\\b)a', '').ok).toBe(true);
    expect(compilePattern('(?:^){2}a', '').ok).toBe(true);
    expect(rejection('^?').message).toBe('Nothing to repeat.');
  });

  it('accepts a repeated group that can match the empty string only when its count is exact', () => {
    expect(compilePattern('(a*){3}', '').ok).toBe(true);
    expect(compilePattern('(?:){2}', '').ok).toBe(true);
    expect(compilePattern('(\\b){2}', '').ok).toBe(true);
  });

  it('accepts what JavaScript accepts without the u flag', () => {
    for (const pattern of [
      'a{',
      'a{,2}',
      'a}',
      ']',
      String.raw`\a`,
      String.raw`\-`,
      String.raw`\p{L}`,
    ]) {
      expect(compilePattern(pattern, '').ok, pattern).toBe(true);
    }
  });
});

describe('checkFlags', () => {
  it('accepts every combination of i, m, s and u and rejects the rest', () => {
    for (const flags of ['', 'i', 'm', 's', 'u', 'imsu', 'usmi']) {
      expect(checkFlags(flags), flags).toBeUndefined();
    }
    expect(checkFlags('g')).toStrictEqual({
      index: 0,
      message: 'Unsupported regular expression flag `g`. Supported flags are i, m, s and u.',
    });
    expect(checkFlags('iy')).toStrictEqual({
      index: 1,
      message: 'Unsupported regular expression flag `y`. Supported flags are i, m, s and u.',
    });
    expect(checkFlags('ii')).toStrictEqual({
      index: 1,
      message: 'Duplicate regular expression flag `i`.',
    });
  });
});
