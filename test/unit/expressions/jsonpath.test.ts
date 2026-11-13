import { JSONPathEvaluateError, evaluate } from '@swaggerexpert/jsonpath';
import { describe, expect, it, vi } from 'vitest';
import type { Value } from '../../../src/expressions/ast';
import { checkJsonPath, queryJsonPath } from '../../../src/expressions/jsonpath';
import { compilePattern } from '../../../src/expressions/regex';

vi.mock('@swaggerexpert/jsonpath', async (importOriginal) => {
  const original = await importOriginal<typeof import('@swaggerexpert/jsonpath')>();
  return { ...original, evaluate: vi.fn(original.evaluate) };
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
    const start = performance.now();

    const result = queryJsonPath(value, '$..id');

    expect(performance.now() - start).toBeLessThan(100);
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
