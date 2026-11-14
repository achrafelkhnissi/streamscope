import { JSONPathEvaluateError, evaluate, parse } from '@swaggerexpert/jsonpath';
import { describe, expect, it, vi } from 'vitest';
import type { Value } from '../../../src/expressions/ast';
import {
  checkJsonPath,
  knownJsonPathCheck,
  queryJsonPath,
} from '../../../src/expressions/jsonpath';
import { compilePattern } from '../../../src/expressions/regex';
import { fastest, timedRuns } from '../timing';

vi.mock('@swaggerexpert/jsonpath', async (importOriginal) => {
  const original = await importOriginal<typeof import('@swaggerexpert/jsonpath')>();
  return { ...original, evaluate: vi.fn(original.evaluate), parse: vi.fn(original.parse) };
});

vi.mock('../../../src/expressions/regex', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/expressions/regex')>();
  return { ...original, compilePattern: vi.fn(original.compilePattern) };
});

const largeInteger = 9007199254740993n;

function nodesOf(value: Value, query: string): readonly Value[] {
  const result = queryJsonPath(value, query);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.nodes;
}

function nested(levels: number): Value {
  let value: Value = { id: 1 };
  for (let level = 1; level < levels; level += 1) {
    value = { next: value };
  }
  return value;
}

function matching(pattern: string, subjects: readonly Value[], name = 'match'): readonly Value[] {
  return nodesOf([...subjects], `$[?${name}(@, ${JSON.stringify(pattern)})]`);
}

function compileCalls(): number {
  return vi.mocked(compilePattern).mock.calls.length;
}

describe('queryJsonPath', () => {
  it('selects a large integer and keeps its digits', () => {
    const document = { id: largeInteger, items: [{ id: largeInteger }, { id: 5 }] };

    const byName = nodesOf(document, '$.id');
    const byIndex = nodesOf(document, '$.items[0].id');
    const everywhere = nodesOf(document, '$..id');

    expect(byName).toEqual([largeInteger]);
    expect(typeof byName[0]).toBe('bigint');
    expect(byIndex).toEqual([largeInteger]);
    expect(everywhere).toEqual([largeInteger, largeInteger, 5]);
  });

  it('returns the nodelist in document order', () => {
    expect(nodesOf({ a: [1, 2, { b: 3 }] }, '$.a[*]')).toEqual([1, 2, { b: 3 }]);
    expect(nodesOf({ a: 1 }, '$.missing')).toEqual([]);
    expect(nodesOf({ a: 1 }, '$')).toEqual([{ a: 1 }]);
  });

  it('matches the whole string with match() and any part with search()', () => {
    const subjects = ['abc', 'b', 'xbx'];

    expect(matching('b', subjects)).toEqual(['b']);
    expect(matching('b', subjects, 'search')).toEqual(['abc', 'b', 'xbx']);
    expect(matching('a|b', subjects)).toEqual(['b']);
    expect(matching('(a|b)+c?', subjects)).toEqual(['abc', 'b']);
  });

  it('reads a dot as any character except line feed and carriage return', () => {
    const subjects = ['a b', 'a\nb', 'a\rb', 'a b', 'a b', 'a𐄁b'];

    expect(matching('a.b', subjects)).toEqual(['a b', 'a b', 'a b', 'a𐄁b']);
    expect(matching('a[.]b', ['a.b', 'a b'])).toEqual(['a.b']);
    expect(matching('a\\.b', ['a.b', 'a b'])).toEqual(['a.b']);
  });

  it('returns false for a pattern that does not compile', () => {
    expect(matching('(a', ['a'])).toEqual([]);
    expect(matching('(a)\\1', ['aa'])).toEqual([]);
    expect(matching('(?=a)a', ['a'], 'search')).toEqual([]);
    expect(matching('a{2,1}', ['aa'])).toEqual([]);
  });

  it('takes the pattern from the document and gives false for a missing or non-string one', () => {
    const document = { regex: 'a+', values: ['aa', 'b'] };

    expect(nodesOf(document, '$.values[?match(@, $.regex)]')).toEqual(['aa']);
    expect(nodesOf(document, '$.values[?match(@, $.nothing)]')).toEqual([]);
    expect(nodesOf({ regex: 1, values: ['1'] }, '$.values[?match(@, $.regex)]')).toEqual([]);
    expect(nodesOf({ values: [1, null, ['a']] }, '$.values[?match(@, "a")]')).toEqual([]);
  });

  it('returns false when the pattern is over 500 characters', () => {
    const over = 'a'.repeat(501);
    const under = 'a'.repeat(400);
    const supplied = (pattern: string, name: string): readonly Value[] =>
      nodesOf({ regex: pattern, values: [pattern] }, `$.values[?${name}(@, $.regex)]`);

    expect(supplied(over, 'match')).toEqual([]);
    expect(supplied(over, 'search')).toEqual([]);
    expect(supplied(under, 'match')).toEqual([under]);
    expect(supplied(under, 'search')).toEqual([under]);
  });

  it('rejects a catastrophic pattern in match()', () => {
    const subject = `${'a'.repeat(40)}!`;

    expect(checkJsonPath("$[?match(@.a, '(a*)*b')]")).toBeDefined();
    expect(matching('(a*)*b', [subject])).toEqual([]);
    expect(matching('(a+)+$', [subject])).toEqual([]);
    expect(matching('(a|aa)+$', [subject], 'search')).toEqual([]);
    expect(matching('(a+)+!', [subject], 'search')).toEqual([subject]);
  });

  it('match() and search() return false on strings over the regex work limit', () => {
    const long = 'a'.repeat(1_000_001);

    expect(matching('a*', [long])).toEqual([]);
    expect(matching('a', [long], 'search')).toEqual([]);
    expect(matching('a*', ['a'.repeat(100)])).toEqual(['a'.repeat(100)]);
  });

  it('keeps at most 256 compiled patterns and evicts the oldest', () => {
    const name = (index: number): string => `cache${String(index)}x`;
    const first = compileCalls();

    for (let index = 0; index < 300; index += 1) {
      matching(name(index), ['x']);
    }
    expect(compileCalls() - first).toBe(300);

    const afterFill = compileCalls();
    matching(name(299), ['x']);
    matching(name(44), ['x']);
    expect(compileCalls()).toBe(afterFill);

    matching(name(43), ['x']);
    expect(compileCalls()).toBe(afterFill + 1);
  });

  it('compiles a pattern once for any number of nodes', () => {
    const subjects = Array.from({ length: 200 }, (_, index) => `v${String(index)}`);
    const before = compileCalls();

    expect(matching('v1[0-9]*', subjects)).toHaveLength(111);
    expect(compileCalls() - before).toBe(1);
  });

  it('returns a reason instead of throwing on an invalid query', () => {
    expect(queryJsonPath({}, '$.a[')).toEqual({
      ok: false,
      reason: 'invalid JSONPath: The JSONPath ends unexpectedly.',
    });
    expect(queryJsonPath({}, '$.a b')).toEqual({
      ok: false,
      reason: 'invalid JSONPath: Unexpected `b` in the JSONPath.',
    });
    const ill = queryJsonPath({}, '$[?length(@.a)]');
    expect(ill.ok).toBe(false);
    expect(ill.ok ? '' : ill.reason).toContain('length()');
    expect(queryJsonPath({}, '$[9007199254740993]').ok).toBe(false);
    expect(queryJsonPath({}, '').ok).toBe(false);
  });

  it('returns a reason when the library fails while evaluating', () => {
    vi.mocked(evaluate).mockImplementationOnce(() => {
      throw new JSONPathEvaluateError('Unexpected error during JSONPath evaluation', {
        cause: new RangeError('Maximum call stack size exceeded'),
      });
    });

    expect(queryJsonPath({}, '$')).toEqual({
      ok: false,
      reason: 'jsonpath() failed: Maximum call stack size exceeded',
    });
  });

  it('refuses a value nested more than 1,000 levels deep, quickly', () => {
    const value = nested(50_000);

    const { value: result, ms } = fastest(() => queryJsonPath(value, '$..id'));

    expect(ms).toBeLessThan(100);
    expect(result).toEqual({
      ok: false,
      reason: 'the value is nested too deeply for jsonpath() (more than 1,000 levels)',
    });
    expect(queryJsonPath(nested(1001), '$..id').ok).toBe(false);
    expect(queryJsonPath([nested(1001)], '$[0].next').ok).toBe(false);
  });

  it('a value exactly 1,000 levels deep works', () => {
    expect(queryJsonPath(nested(1000), '$..id')).toEqual({ ok: true, nodes: [1] });
    expect(nodesOf([nested(999), nested(998)], '$[*]..id')).toEqual([1, 1]);
  });

  it('measures the depth of lists and objects alike, and not of scalars', () => {
    let lists: Value = [1];
    for (let level = 1; level < 1000; level += 1) {
      lists = [lists];
    }

    expect(queryJsonPath(lists, '$').ok).toBe(true);
    expect(queryJsonPath([lists], '$').ok).toBe(false);
    expect(queryJsonPath(1, '$')).toEqual({ ok: true, nodes: [1] });
    expect(queryJsonPath('text', '$')).toEqual({ ok: true, nodes: ['text'] });
    expect(queryJsonPath(null, '$')).toEqual({ ok: true, nodes: [null] });
  });

  it('finds a value deep in a wide document without recursion', () => {
    const wide = { items: Array.from({ length: 50_000 }, (_, index) => ({ id: index })) };

    expect(nodesOf(wide, '$.items[49999].id')).toEqual([49_999]);
  });
});

describe('bigint in filters', () => {
  it('skips a bigint in an ordering comparison and equals the same bigint', () => {
    const big = 9007199254740993n;
    const document = {
      target: big,
      l: [{ id: big }, { id: 6 }, { id: 9007199254740995n }, { id: 3 }],
    };

    expect(nodesOf(document, '$.l[?@.id > 5]')).toEqual([{ id: 6 }]);
    expect(nodesOf(document, '$.l[?@.id < 5]')).toEqual([{ id: 3 }]);
    expect(nodesOf(document, '$.l[?@.id == $.target]')).toEqual([{ id: big }]);
    expect(nodesOf(document, '$.l[?@.id != $.target]')).toEqual([
      { id: 6 },
      { id: 9007199254740995n },
      { id: 3 },
    ]);
    expect(nodesOf(document, '$.l[?@.id]')).toHaveLength(4);
  });
});

describe('checkJsonPath', () => {
  it('accepts valid queries', () => {
    for (const query of [
      '$',
      '$.a.b[0]',
      "$['a']['b']",
      '$..*',
      '$.items[?@.id > 5 && @.name]',
      '$[?count(@.*) > 1]',
      '$[?length(@.a) == 3]',
      "$[?match(@.a, 'a.*') || search(@.b, '[0-9]+')]",
      '$.values[?match(@, $.regex)]',
    ]) {
      expect(checkJsonPath(query), query).toBeUndefined();
    }
  });

  it('reports the offset of a syntax error', () => {
    expect(checkJsonPath('$.a[')?.offset).toBe(4);
    expect(checkJsonPath('$.items[?@.id ==]')?.offset).toBe(16);
    expect(checkJsonPath('$.a b')?.offset).toBe(4);
    expect(checkJsonPath("$['a'")?.offset).toBe(5);
    expect(checkJsonPath('a.b')?.offset).toBe(0);
    expect(checkJsonPath('')?.offset).toBe(0);
  });

  it('counts the offset in UTF-16 code units after characters outside the BMP', () => {
    const query = "$['\u{1F600}\u{10101}'] b";

    expect(checkJsonPath(query)?.offset).toBe(query.indexOf('b'));
    expect(checkJsonPath(query)?.message).toBe('Unexpected `b` in the JSONPath.');
  });

  it('names the unexpected character or the end of the query', () => {
    expect(checkJsonPath('$.a b')?.message).toBe('Unexpected `b` in the JSONPath.');
    expect(checkJsonPath('$.a[')?.message).toBe('The JSONPath ends unexpectedly.');
    expect(checkJsonPath('$.a \u{10101}')?.message).toBe('Unexpected `\u{10101}` in the JSONPath.');
  });

  it('rejects ill-typed function calls', () => {
    expect(checkJsonPath('$[?length(@.a)]')?.message).toContain('length()');
    expect(checkJsonPath('$[?count(1) > 0]')?.message).toContain('count()');
    expect(checkJsonPath('$[?match(@.a)]')?.message).toContain('match()');
    expect(checkJsonPath('$[?match(@.a, "x") == true]')).toBeDefined();
  });

  it('rejects an integer outside the exact range', () => {
    expect(checkJsonPath('$[9007199254740993]')?.message).toContain('9007199254740993');
  });

  it('reports a match() or search() pattern that does not compile at the offset of the literal', () => {
    const query = "$[?@.a && match(@.a, '(a)\\\\1')]";

    const problem = checkJsonPath(query);

    expect(problem?.offset).toBe(query.indexOf("'("));
    expect(problem?.message).toBe('The escape `\\1` is not part of I-Regexp (RFC 9485).');
    expect(checkJsonPath("$[?search(@.a, 'x') || search(@.b, '(?<=a)b')]")?.offset).toBe(
      "$[?search(@.a, 'x') || search(@.b, ".length,
    );
  });

  it('reports the pattern offset in UTF-16 code units after characters outside the BMP', () => {
    const query = "$['\u{1F600}'][?match(@, '(a')]";

    expect(checkJsonPath(query)?.offset).toBe(query.indexOf("'(a'"));
  });

  it('reads escapes in the pattern literal before it checks the pattern', () => {
    expect(checkJsonPath('$[?match(@.a, "\\u0028a")]')).toBeDefined();
    expect(checkJsonPath('$[?match(@.a, "\\u0061+")]')).toBeUndefined();
    expect(checkJsonPath("$[?match(@.a, 'a\\\\.b')]")).toBeUndefined();
  });

  it('checks a pattern that is not a literal at run time only', () => {
    expect(checkJsonPath('$.values[?match(@, $.regex)]')).toBeUndefined();
    expect(checkJsonPath('$[?match(@.a, length(@.b))]')).toBeUndefined();
  });

  it('checks a pattern the way match() does, including the dot', () => {
    expect(checkJsonPath("$[?match(@.a, 'a.b')]")).toBeUndefined();
    expect(checkJsonPath("$[?match(@.a, '.*')]")).toBeUndefined();
  });

  it('rejects a function call with a third argument at its comma, before parsing', () => {
    const tooMany = 'A JSONPath function takes at most two arguments.';
    const three = '$[?match(@.a, "x", "y")]';
    const wide = `$[?a(1,b(1,c(${Array<string>(180).fill('1').join(',')}`;
    const parsesBefore = vi.mocked(parse).mock.calls.length;

    expect(checkJsonPath(three)).toEqual({ message: tooMany, offset: three.lastIndexOf(',') });
    expect(checkJsonPath(wide)).toEqual({ message: tooMany, offset: wide.indexOf('1,1,1') + 3 });
    expect(vi.mocked(parse).mock.calls.length).toBe(parsesBefore);
    expect(checkJsonPath('$[?count(@[0,1,2]) > 0]')).toBeUndefined();
    expect(checkJsonPath("$[?match(@.a, 'a,b,c')]")).toBeUndefined();
    expect(checkJsonPath('$[?search(@.a, "x") && match(@.b, "y")]')).toBeUndefined();
  });

  it('rejects an unknown function at the offset of its name', () => {
    const message = (name: string): string =>
      `Unknown function \`${name}\`; the functions are length, count, match, search and value.`;

    expect(checkJsonPath('$[?lenght(@.a)==1]')).toEqual({ message: message('lenght'), offset: 3 });
    expect(checkJsonPath('$[?foo(@.a)]')).toEqual({ message: message('foo'), offset: 3 });
    expect(checkJsonPath('$[?length(@.a) == 1 && foo(@.b)]')).toEqual({
      message: message('foo'),
      offset: 23,
    });
    expect(checkJsonPath('$[?a(b(c(@)))]')).toEqual({ message: message('a'), offset: 3 });
    expect(checkJsonPath("$['\u{1F600}'][?foo(@)]")).toEqual({
      message: message('foo'),
      offset: "$['\u{1F600}'][?".length,
    });
    expect(checkJsonPath('$[?foo(@.a)]')).not.toEqual(checkJsonPath('$[?fo(@.a)]'));
  });

  it('accepts the five functions of RFC 9535', () => {
    for (const query of [
      '$[?length(@.a) == 1]',
      '$[?count(@.*) == 1]',
      "$[?match(@.a, 'x')]",
      "$[?search(@.a, 'x')]",
      '$[?value(@..a) == 1]',
    ]) {
      expect(checkJsonPath(query), query).toBeUndefined();
    }
  });

  it('makes queryJsonPath refuse an unknown function with a reason', () => {
    expect(queryJsonPath({ a: 1 }, '$[?lenght(@.a)==1]')).toEqual({
      ok: false,
      reason:
        'invalid JSONPath: Unknown function `lenght`; the functions are length, count, match, search and value.',
    });
  });
});

const tooDeep = 'the query nests too deeply (more than 3 levels of parentheses)';

function nestedCalls(levels: number): string {
  return `$[?${'length('.repeat(levels)}@.a${')'.repeat(levels)} == 1]`;
}

function nthOpening(query: string, count: number): number {
  let index = -1;
  for (let seen = 0; seen < count; seen += 1) {
    index = query.indexOf('(', index + 1);
  }
  return index;
}

describe('parenthesis nesting', () => {
  it('rejects 4 levels of nested calls quickly', () => {
    for (const levels of [4, 20, 40]) {
      const query = nestedCalls(levels);

      const { value, ms } = fastest(() => ({
        problem: checkJsonPath(query),
        result: queryJsonPath({ a: 'x' }, query),
      }));
      const { problem, result } = value;

      expect(ms, `${String(levels)} levels`).toBeLessThan(100);
      expect(problem).toEqual({ message: tooDeep, offset: nthOpening(query, 4) });
      expect(result).toEqual({ ok: false, reason: tooDeep });
    }
  });

  it('counts groups as well as calls', () => {
    const query = `$[?${'('.repeat(5)}@.a${')'.repeat(5)}]`;

    expect(checkJsonPath(query)).toEqual({ message: tooDeep, offset: nthOpening(query, 4) });
    expect(queryJsonPath({ a: 1 }, query)).toEqual({ ok: false, reason: tooDeep });
    expect(checkJsonPath(`$[?${'('.repeat(3)}@.a${')'.repeat(3)}]`)).toBeUndefined();
  });

  it('3 levels of nested calls are accepted', () => {
    const query = nestedCalls(3);

    expect(checkJsonPath(query)).toBeUndefined();
    expect(queryJsonPath({ a: 'x' }, query)).toEqual({ ok: true, nodes: [] });
  });

  it('counts the depth of the open parentheses, not their number', () => {
    const query = `$[?${Array.from({ length: 30 }, () => '(@.a)').join(' && ')}]`;

    expect(checkJsonPath(query)).toBeUndefined();
    expect(queryJsonPath([{ a: 1 }], query)).toEqual({ ok: true, nodes: [{ a: 1 }] });
  });

  it('parentheses inside string literals do not count', () => {
    const opening = '('.repeat(20);
    const queries = [
      `$[?@.a == '${opening}']`,
      `$[?@.a == "${opening}"]`,
      `$[?@.a == '${')'.repeat(20)}']`,
      `$[?@.a == 'it\\'s ${opening}']`,
      `$[?@.a == "say \\"${opening}\\""]`,
      String.raw`$[?@.a == '\\' && @.b == '((((((((((']`,
      `$['${opening}']`,
    ];

    for (const query of queries) {
      expect(checkJsonPath(query), query).toBeUndefined();
      expect(queryJsonPath({ a: 1 }, query).ok, query).toBe(true);
    }
  });

  it('counts parentheses after a string literal that closed', () => {
    const query = `$[?@.a == '(' && ${nestedCalls(4).slice(3, -1)}]`;

    expect(checkJsonPath(query)?.message).toBe(tooDeep);
  });
});

function patternQuery(pattern: string, name = 'match'): string {
  return `$[?${name}(@.a, ${JSON.stringify(pattern)})]`;
}

const groupSyntax =
  'Group syntax such as `(?:…)` and `(?<name>…)` is not part of I-Regexp (RFC 9485).';
const lazySyntax = 'Lazy quantifiers such as `*?` are not part of I-Regexp (RFC 9485).';

function escapeMessage(escape: string): string {
  return `The escape \`${escape}\` is not part of I-Regexp (RFC 9485).`;
}

describe('patterns outside I-Regexp', () => {
  it.each([
    [String.raw`\d`, '5', escapeMessage(String.raw`\d`)],
    [String.raw`\D`, 'a', escapeMessage(String.raw`\D`)],
    [String.raw`\w`, 'a', escapeMessage(String.raw`\w`)],
    [String.raw`\s`, ' ', escapeMessage(String.raw`\s`)],
    [String.raw`\bb`, 'b', escapeMessage(String.raw`\b`)],
    [String.raw`\Bb`, 'ab', escapeMessage(String.raw`\B`)],
    [String.raw`a\x41`, 'aA', escapeMessage(String.raw`\x`)],
    ['(?<n>a)', 'a', groupSyntax],
    ['(?:a)', 'a', groupSyntax],
    ['a*?', 'aa', lazySyntax],
    ['a+?b', 'ab', lazySyntax],
    ['a{1,2}?', 'a', lazySyntax],
    [String.raw`[\d]`, '5', escapeMessage(String.raw`\d`)],
  ])(
    'gives false for %s and reports it at the offset of the pattern',
    (pattern, subject, message) => {
      for (const name of ['match', 'search']) {
        const query = patternQuery(pattern, name);

        expect(matching(pattern, [subject], name), `${name} ${pattern}`).toEqual([]);
        expect(checkJsonPath(query)).toEqual({ message, offset: query.indexOf('"') });
      }
    },
  );

  it('gives false for a pattern outside I-Regexp that the document supplies', () => {
    const document = { regex: String.raw`\d+`, values: ['12'] };

    expect(nodesOf(document, '$.values[?match(@, $.regex)]')).toEqual([]);
    expect(nodesOf(document, '$.values[?search(@, $.regex)]')).toEqual([]);
  });

  it.each([
    [String.raw`\p{Lu}`, 'Ж'],
    [String.raw`\P{Nd}`, 'a'],
    ['[a-z-]+', 'a-b'],
    ['[-a]', '-'],
    [String.raw`\(a\)`, '(a)'],
    [String.raw`a\{2\}`, 'a{2}'],
    ['a{2}', 'aa'],
    ['a{2,}', 'aaa'],
    ['a{1,2}', 'aa'],
    [String.raw`a\nb`, 'a\nb'],
    [String.raw`a\tb`, 'a\tb'],
    [String.raw`a\-b`, 'a-b'],
    [String.raw`a[\-]b`, 'a-b'],
    [String.raw`[\]]`, ']'],
    ['(a|b)*c', 'abac'],
    ['^ab.*', 'abc'],
    ['.*bc$', 'abc'],
  ])('still matches the I-Regexp pattern %s', (pattern, subject) => {
    expect(checkJsonPath(patternQuery(pattern)), pattern).toBeUndefined();
    expect(matching(pattern, [subject]), pattern).toEqual([subject]);
  });
});

function withFrames<T>(frames: number, action: () => T): T {
  return frames === 0 ? action() : withFrames(frames - 1, action);
}

function withRoom<T>(room: number, action: () => T): { result?: T; thrown?: unknown } {
  const outcome: { result?: T; thrown?: unknown } = {};
  let unwound = 0;
  const dive = (): void => {
    try {
      dive();
    } catch (error) {
      if (!(error instanceof RangeError)) {
        throw error;
      }
      unwound += 1;
      if (unwound <= room) {
        throw error;
      }
      try {
        outcome.result = action();
      } catch (thrown) {
        outcome.thrown = thrown;
      }
    }
  };
  dive();
  return outcome;
}

function nestedFilters(levels: number, literal = 'a'): string {
  return `$${'[?@'.repeat(levels)}[?match(@, "${literal}")${']'.repeat(levels + 1)}`;
}

describe('query limits', () => {
  const tooLong = 'the query is longer than 384 characters';
  const tooManyBrackets = 'the query nests too deeply (more than 32 levels of brackets)';
  const tooComplex = 'the query is too complex to check';

  function nthOccurrence(query: string, char: string, count: number): number {
    let index = -1;
    for (let seen = 0; seen < count; seen += 1) {
      index = query.indexOf(char, index + 1);
    }
    return index;
  }

  it('rejects 385 characters and 1 MB of query quickly', () => {
    for (const length of [385, 1_000_000]) {
      const query = `$${'.a'.repeat(Math.ceil((length - 1) / 2))}`.slice(0, length);

      const { value, ms } = fastest(() => ({
        problem: checkJsonPath(query),
        result: queryJsonPath({ a: 1 }, query),
      }));
      const { problem, result } = value;

      expect(ms, `${String(length)} characters`).toBeLessThan(100);
      expect(problem).toEqual({ message: tooLong, offset: 384 });
      expect(result).toEqual({ ok: false, reason: tooLong });
    }
  });

  it('accepts a query of exactly 384 characters', () => {
    const query = `$.${'a'.repeat(382)}`;

    expect(query).toHaveLength(384);
    expect(checkJsonPath(query)).toBeUndefined();
    expect(queryJsonPath({ a: 1 }, query)).toEqual({ ok: true, nodes: [] });
  });

  it('rejects 33 levels of brackets quickly', () => {
    for (const levels of [33, 50, 90]) {
      const query = `$${'[?@'.repeat(levels)}.a${']'.repeat(levels)}`;

      const { value, ms } = fastest(() => ({
        problem: checkJsonPath(query),
        result: queryJsonPath({ a: 1 }, query),
      }));
      const { problem, result } = value;

      expect(ms, `${String(levels)} levels`).toBeLessThan(100);
      expect(problem).toEqual({ message: tooManyBrackets, offset: nthOccurrence(query, '[', 33) });
      expect(result).toEqual({ ok: false, reason: tooManyBrackets });
    }
  });

  it('accepts 32 levels of brackets', () => {
    const query = `$${'[?@'.repeat(32)}.a${']'.repeat(32)}`;

    expect(checkJsonPath(query)).toBeUndefined();
    expect(queryJsonPath({ a: 1 }, query)).toEqual({ ok: true, nodes: [] });
  });

  it('brackets inside string literals do not count', () => {
    const opening = '['.repeat(100);

    for (const query of [
      `$['${opening}']`,
      `$[?@.a == "${opening}"]`,
      `$[?@.a == '${']'.repeat(100)}']`,
      `$[?@.a == 'it\\'s ${opening}']`,
    ]) {
      expect(checkJsonPath(query), query).toBeUndefined();
      expect(queryJsonPath({ a: 1 }, query).ok, query).toBe(true);
    }
  });

  it('counts the depth of the open brackets, not their number', () => {
    const query = `$${Array.from({ length: 120 }, () => '[0]').join('')}`;

    expect(checkJsonPath(query)).toBeUndefined();
  });

  it('checks the query before it measures the value', () => {
    const deep = nested(50_000);

    expect(queryJsonPath(deep, `$${'.a'.repeat(3000)}`)).toEqual({ ok: false, reason: tooLong });
    expect(queryJsonPath(deep, `$[?${nestedCalls(4).slice(3, -1)}]`)).toEqual({
      ok: false,
      reason: tooDeep,
    });
    expect(queryJsonPath(deep, `$${'[?@'.repeat(33)}`)).toEqual({
      ok: false,
      reason: tooManyBrackets,
    });
    expect(queryJsonPath(deep, '$..id')).toEqual({
      ok: false,
      reason: 'the value is nested too deeply for jsonpath() (more than 1,000 levels)',
    });
  });

  it('rejects the long and the nested shapes that took seconds, quickly', () => {
    const content = (count: number): string => Array<string>(count).fill('@').join('||');
    const slow = [
      `$[?match(value(@[?match(value(@[?${content(667)}]),'a')]),'a')]`,
      `$[?a(b(c(d(${content(679)}#`,
      `$[?match(value(@[?match(value(@[?${content(40)}]),'a')]),'a')]`,
      `$[?a(b(c(d(${content(40)}#`,
    ];

    for (const query of slow) {
      const { value, ms } = fastest(() => ({
        problem: checkJsonPath(query),
        result: queryJsonPath({ a: 1 }, query),
      }));
      const { problem, result } = value;

      expect(ms, query.slice(0, 20)).toBeLessThan(100);
      expect(problem?.message).toMatch(/longer than 384 characters|nests too deeply/);
      expect(result.ok).toBe(false);
    }
  });

  it('reports a real stack overflow inside the library as too complex', () => {
    for (let warm = 0; warm < 5; warm += 1) {
      checkJsonPath(nestedFilters(30, `warm${String(warm)}`));
    }
    let message: string | undefined = 'valid';

    for (let room = 4000; room >= 100 && message === 'valid'; room -= 10) {
      const query = nestedFilters(30, `room${String(room)}`);
      const { result, thrown } = withRoom(room, () => checkJsonPath(query)?.message ?? 'valid');
      expect(thrown, `room ${String(room)}`).toBeUndefined();
      message = result;
    }

    expect(message).toBe(tooComplex);
  });

  it('never throws, even with the stack nearly used up', () => {
    for (let levels = 20; levels <= 45; levels += 1) {
      const query = nestedFilters(levels);
      const check = (): ReturnType<typeof checkJsonPath> =>
        withFrames(5000, () => checkJsonPath(query));
      const run = (): ReturnType<typeof queryJsonPath> =>
        withFrames(5000, () => queryJsonPath({ a: 'a' }, query));

      expect(check, `check ${String(levels)}`).not.toThrow();
      expect(run, `query ${String(levels)}`).not.toThrow();
      const problem = check();
      expect(problem === undefined || problem.message.length > 0).toBe(true);
      if (levels > 32) {
        expect(problem).toEqual({
          message: tooManyBrackets,
          offset: nthOccurrence(query, '[', 33),
        });
      }
      const outcome = run();
      expect(outcome.ok || outcome.reason.length > 0).toBe(true);
    }
  });
});

const worstQueryLength = 384;

let flushed = 0;

function emptyCheckCache(): void {
  for (let index = 0; index < 256; index += 1) {
    flushed += 1;
    checkJsonPath(`$.flush${String(flushed)}`);
  }
}

function filled(term: string, joiner: string, prefix: string, suffix: string): string {
  const terms: string[] = [];
  let length = prefix.length + suffix.length;
  while (length + term.length + joiner.length <= worstQueryLength) {
    terms.push(term);
    length += term.length + joiner.length;
  }
  return `${prefix}${terms.join(joiner)}${suffix}`;
}

function repeated(unit: string, prefix: string, suffix: string): string {
  let body = '';
  while (prefix.length + body.length + unit.length + suffix.length <= worstQueryLength) {
    body += unit;
  }
  return `${prefix}${body}${suffix}`;
}

function wideCalls(names: readonly [string, string, string], unit: string, tail: string): string {
  const list = (count: number): string => Array.from({ length: count }, () => unit).join(',');
  const innermost = list(Math.floor(worstQueryLength / 2.1));
  return `$[?${names[0]}(${unit},${names[1]}(${unit},${names[2]}(${innermost}${tail}`.slice(
    0,
    worstQueryLength,
  );
}

describe('worst accepted queries', () => {
  const calls = (levels: number): string =>
    `${'length('.repeat(levels)}@.a${')'.repeat(levels)} == 1`;
  const pattern = (unit: string): string => unit.repeat(Math.floor(240 / unit.length));

  const worst: [string, string][] = [
    [
      'long content in the innermost of two calls',
      filled('@', '||', '$[?match(value(@[?', "]),'a')]"),
    ],
    [
      'long content in the innermost of three calls',
      filled('@', '||', '$[?length(length(value(@[?', '])))==1]'),
    ],
    [
      'long content in nested count filters',
      filled('@', '||', '$[?count(@[?count(@[?count(@[?', ']) > 0]) > 0]) > 0]'),
    ],
    ['unknown names around long content that fails late', filled('@', '||', '$[?a(b(c(', '#')],
    [
      'known names around long content that fails late',
      filled('@', '||', '$[?length(length(length(', '#'),
    ],
    [
      'long content that fails the type check',
      filled('@', '||', '$[?length(length(length(', ')))]'),
    ],
    [
      'a call with 180 unknown-name arguments that fails late',
      wideCalls(['a', 'b', 'c'], '$', '#'),
    ],
    ['a call with 180 literal arguments', wideCalls(['a', 'b', 'c'], '1', '')],
    ['a call with 180 literal arguments that fails late', wideCalls(['a', 'b', 'c'], '1', ']')],
    [
      'a call with 180 arguments of known functions',
      wideCalls(['match', 'search', 'value'], '1', '#'),
    ],
    ['a call with 180 node arguments', wideCalls(['length', 'length', 'length'], '@', ')))]')],
    ['a call with 180 count arguments', wideCalls(['count', 'count', 'count'], '$', ']')],
    ['minimal match filters in a union', repeated("?match(@,'a'),", '$[', "?match(@,'a')]")],
    ['minimal match filter segments', repeated("[?match(@,'a')]", '$', '')],
    ['minimal match calls joined by ||', filled("match(@,'a')", '||', '$[?', ']')],
    ['minimal search calls joined by ||', filled("search(@,'')", '||', '$[?', ']')],
    ['match calls with a short pattern', filled("match(@.a, 'a+')", ' || ', '$[?', ']')],
    [
      'match calls with escapes in the literal',
      filled("match(@.a, 'a\\\\.b')", ' || ', '$[?', ']'),
    ],
    [
      'match calls with 240-character patterns',
      filled(`match(@.a, '${pattern('a*')}')`, ' || ', '$[?', ']'),
    ],
    [
      'match calls with property patterns',
      filled(`match(@.a, '${pattern('\\\\p{L}')}')`, ' || ', '$[?', ']'),
    ],
    [
      'match calls with nested groups',
      filled(`search(@.a, '${pattern('((a))')}')`, ' || ', '$[?', ']'),
    ],
    ['3-deep calls joined by &&', filled(calls(3), ' && ', '$[?', ']')],
    ['3-deep calls joined by ||', filled(calls(3), ' || ', '$[?', ']')],
    ['3-deep calls in separate filters', filled(`[?${calls(3)}]`, '', '$', '')],
    ['3-deep calls then a type error', filled(calls(3), ' && ', '$[?', ' && length(@.a)]')],
    ['3-deep calls then a syntax error', `${filled(calls(3), ' && ', '$[?', ']')}]`],
    ['unknown functions in 3-deep calls', filled('foo(bar(baz(@)))', ' && ', '$[?', ']')],
    ['&& chain of comparisons', filled('@.a == 1', ' && ', '$[?', ']')],
    ['|| chain of bare nodes', filled('@', '||', '$[?', ']')],
    ['union of filters', repeated('?@.a,', '$[', '?@.a]')],
    ['union of mixed selectors', repeated("0,'a',*,?@.a,0:2,", '$[', '*]')],
    ['many filter segments', repeated('[?@.a]', '$', '')],
    ['nested filters at the bracket cap', `$${'[?@'.repeat(31)}.a${']'.repeat(31)}`],
    [
      'nested filters at the bracket cap with unions',
      `$${'[?@.a,?@'.repeat(31)}.a${']'.repeat(31)}`,
    ],
    [
      'nested filters with match at each level',
      `$${"[?match(@.a, 'x') && @".repeat(12)}.a${']'.repeat(12)}`,
    ],
  ];

  it.each(worst)('checks %s in under 100 ms, cold and warm', (_name, query) => {
    expect(query.length).toBeLessThanOrEqual(worstQueryLength);
    let coldMs = Number.POSITIVE_INFINITY;

    for (let round = 0; round < timedRuns; round += 1) {
      emptyCheckCache();
      const start = performance.now();
      const problem = checkJsonPath(query);
      coldMs = Math.min(coldMs, performance.now() - start);
      expect(problem?.message ?? '').not.toMatch(/nests too deeply|longer than/);
    }
    const warm = fastest(() => checkJsonPath(query));

    expect(coldMs).toBeLessThan(100);
    expect(warm.ms).toBeLessThan(100);
    expect(warm.value?.message ?? '').not.toMatch(/nests too deeply|longer than/);
  });

  it('checks every one again in under 100 ms after the cache has been emptied', () => {
    const fastestMs = new Map<string, number>();
    for (let round = 0; round < timedRuns; round += 1) {
      emptyCheckCache();
      for (const [name, query] of worst) {
        const start = performance.now();
        const problem = checkJsonPath(query);
        const elapsed = performance.now() - start;

        fastestMs.set(name, Math.min(fastestMs.get(name) ?? Infinity, elapsed));
        expect(problem?.message ?? '').not.toMatch(/nests too deeply|longer than/);
      }
    }

    for (const [name, elapsed] of fastestMs) {
      expect(elapsed, name).toBeLessThan(100);
    }
  });
});

describe('the checkJsonPath cache', () => {
  const tooComplex = 'the query is too complex to check';

  function parseCalls(): number {
    return vi.mocked(parse).mock.calls.length;
  }

  function parsesFor(query: string): number {
    const before = parseCalls();
    checkJsonPath(query);
    return parseCalls() - before;
  }

  it('checks a valid query once', () => {
    const query = '$.cache.valid.once';

    expect(parsesFor(query)).toBeGreaterThan(0);
    expect(parsesFor(query)).toBe(0);
    expect(checkJsonPath(query)).toBeUndefined();
  });

  it('remembers a problem and returns it again', () => {
    const query = '$.cache.problem[';
    const first = checkJsonPath(query);

    expect(first).toEqual({ message: 'The JSONPath ends unexpectedly.', offset: 16 });
    expect(parsesFor(query)).toBe(0);
    expect(checkJsonPath(query)).toBe(first);
  });

  it('keeps a result for each query separately', () => {
    expect(checkJsonPath('$.cache.separate.a[')).toBeDefined();
    expect(checkJsonPath('$.cache.separate.a')).toBeUndefined();
    expect(checkJsonPath('$.cache.separate.a[')).toBeDefined();
  });

  it('keeps at most 256 results and evicts the oldest', () => {
    const query = (index: number): string => `$.bound${String(index)}`;

    for (let index = 0; index < 256; index += 1) {
      checkJsonPath(query(index));
    }
    expect(parsesFor(query(0))).toBe(0);
    expect(parsesFor(query(255))).toBe(0);

    checkJsonPath(query(256));

    expect(parsesFor(query(0))).toBeGreaterThan(0);
    expect(parsesFor(query(2))).toBe(0);
    expect(parsesFor(query(1))).toBeGreaterThan(0);
  });

  it('does not keep a query over 384 characters', () => {
    const query = `$${'.a'.repeat(193)}`;
    const first = checkJsonPath(query);

    expect(first).toEqual({ message: 'the query is longer than 384 characters', offset: 384 });
    expect(checkJsonPath(query)).not.toBe(first);
    expect(parsesFor(query)).toBe(0);
  });

  it('tells whether a result is known without checking the query', () => {
    const query = '$.cache.known.a b';
    const before = parseCalls();

    expect(knownJsonPathCheck(query)).toBeUndefined();
    expect(parseCalls()).toBe(before);

    const problem = checkJsonPath(query);

    expect(knownJsonPathCheck(query)).toEqual({ problem });
    expect(knownJsonPathCheck('$.cache.known.clean')).toBeUndefined();
    checkJsonPath('$.cache.known.clean');
    expect(knownJsonPathCheck('$.cache.known.clean')).toEqual({ problem: undefined });
  });

  it('knows the answer for a query over 384 characters at once', () => {
    const query = `$${'.a'.repeat(193)}`;

    expect(knownJsonPathCheck(query)).toEqual({
      problem: { message: 'the query is longer than 384 characters', offset: 384 },
    });
  });

  it('does not remember a result that depended on the remaining stack', () => {
    let overflowed: string | undefined;

    for (let room = 4000; room >= 100 && overflowed === undefined; room -= 10) {
      const query = nestedFilters(30, `stack${String(room)}`);
      const { result } = withRoom(room, () => checkJsonPath(query));
      if (result?.message === tooComplex) {
        overflowed = query;
      }
    }

    expect(overflowed).toBeDefined();
    expect(knownJsonPathCheck(overflowed ?? '')).toBeUndefined();
    expect(checkJsonPath(overflowed ?? '')).toBeUndefined();
  });
});
