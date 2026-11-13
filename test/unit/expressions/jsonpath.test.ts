import { describe, expect, it, vi } from 'vitest';
import type { Value } from '../../../src/expressions/ast';
import { checkJsonPath, queryJsonPath } from '../../../src/expressions/jsonpath';
import { compilePattern } from '../../../src/expressions/regex';

vi.mock('../../../src/expressions/regex', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/expressions/regex')>();
  return { ...original, compilePattern: vi.fn(original.compilePattern) };
});

const largeInteger = 9007199254740993n;

function matching(pattern: string, subjects: readonly Value[], name = 'match'): readonly Value[] {
  return queryJsonPath([...subjects], `$[?${name}(@, ${JSON.stringify(pattern)})]`);
}

function compileCalls(): number {
  return vi.mocked(compilePattern).mock.calls.length;
}

describe('queryJsonPath', () => {
  it('selects a large integer and keeps its digits', () => {
    const document = { id: largeInteger, items: [{ id: largeInteger }, { id: 5 }] };

    const byName = queryJsonPath(document, '$.id');
    const byIndex = queryJsonPath(document, '$.items[0].id');
    const everywhere = queryJsonPath(document, '$..id');

    expect(byName).toEqual([largeInteger]);
    expect(typeof byName[0]).toBe('bigint');
    expect(byIndex).toEqual([largeInteger]);
    expect(everywhere).toEqual([largeInteger, largeInteger, 5]);
  });

  it('returns the nodelist in document order', () => {
    expect(queryJsonPath({ a: [1, 2, { b: 3 }] }, '$.a[*]')).toEqual([1, 2, { b: 3 }]);
    expect(queryJsonPath({ a: 1 }, '$.missing')).toEqual([]);
    expect(queryJsonPath({ a: 1 }, '$')).toEqual([{ a: 1 }]);
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

    expect(queryJsonPath(document, '$.values[?match(@, $.regex)]')).toEqual(['aa']);
    expect(queryJsonPath(document, '$.values[?match(@, $.nothing)]')).toEqual([]);
    expect(queryJsonPath({ regex: 1, values: ['1'] }, '$.values[?match(@, $.regex)]')).toEqual([]);
    expect(queryJsonPath({ values: [1, null, ['a']] }, '$.values[?match(@, "a")]')).toEqual([]);
  });

  it('returns false when the pattern is over 500 characters', () => {
    const over = 'a'.repeat(501);
    const under = 'a'.repeat(400);

    expect(matching(over, [over])).toEqual([]);
    expect(matching(over, [over], 'search')).toEqual([]);
    expect(matching(under, [under])).toEqual([under]);
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

  it('throws on a query that checkJsonPath rejects', () => {
    expect(() => queryJsonPath({}, '$.a[')).toThrow();
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
    expect(problem?.message).toContain('Backreferences');
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

  it('checks a pattern the way match() does, including the dot and the length limit', () => {
    expect(checkJsonPath("$[?match(@.a, 'a.b')]")).toBeUndefined();
    expect(checkJsonPath(`$[?match(@.a, '${'a'.repeat(501)}')]`)?.message).toContain('500');
    expect(checkJsonPath(`$[?search(@.a, '${'a'.repeat(500)}')]`)).toBeUndefined();
  });
});
