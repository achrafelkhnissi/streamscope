import { describe, expect, it } from 'vitest';
import type { Value } from '../../../src/expressions/ast';
import {
  compactJson,
  insertText,
  maxInsertedLength,
  type BoundedText,
} from '../../../src/expressions/insert';
import { WorkBudget } from '../../../src/expressions/work';

const unlimited = Number.POSITIVE_INFINITY;
const tooLarge: BoundedText = { ok: false };
const mebibyte = 1_048_576;

function nested(depth: number, leaf: Value): Value {
  let value = leaf;
  for (let level = 0; level < depth; level += 1) {
    value = { next: value };
  }
  return value;
}

function nestedLists(depth: number, leaf: Value): Value {
  let value = leaf;
  for (let level = 0; level < depth; level += 1) {
    value = [value];
  }
  return value;
}

function inserted(value: Value): string {
  const result = insertText(value, unlimited);
  if (!result.ok) {
    throw new Error('too large');
  }
  return result.text;
}

function json(value: Value): string {
  const result = compactJson(value, unlimited);
  if (!result.ok) {
    throw new Error('too large');
  }
  return result.text;
}

function collect(): void {
  (globalThis as unknown as { gc: () => void }).gc();
}

function measure(run: () => BoundedText): { result: BoundedText; ms: number; heap: number } {
  collect();
  const before = process.memoryUsage().heapUsed;
  const start = performance.now();
  const result = run();
  const ms = performance.now() - start;
  return { result, ms, heap: process.memoryUsage().heapUsed - before };
}

describe('insertText', () => {
  it('inserts strings as they are', () => {
    expect(inserted('plain text')).toBe('plain text');
    expect(inserted('')).toBe('');
    expect(inserted('say "hi"\n\\')).toBe('say "hi"\n\\');
    expect(inserted('{"a":1}')).toBe('{"a":1}');
  });

  it('keeps the digits of large integers in text and inside compact JSON', () => {
    expect(inserted(12345678901234567890n)).toBe('12345678901234567890');
    expect(inserted(-12345678901234567890n)).toBe('-12345678901234567890');
    expect(json(12345678901234567890n)).toBe('12345678901234567890');
    expect(json({ id: 12345678901234567890n, ids: [9007199254740993n, 1] })).toBe(
      '{"id":12345678901234567890,"ids":[9007199254740993,1]}',
    );
    expect(inserted({ id: 12345678901234567890n })).toBe('{"id":12345678901234567890}');
    expect(inserted([12345678901234567890n])).toBe('[12345678901234567890]');
  });

  it('inserts other numbers as JavaScript prints them', () => {
    expect(inserted(1.5)).toBe('1.5');
    expect(inserted(42)).toBe('42');
    expect(inserted(-0)).toBe('0');
    expect(inserted(1e21)).toBe('1e+21');
    expect(inserted(0.1)).toBe('0.1');
  });

  it('inserts booleans and null as JSON literals', () => {
    expect(inserted(true)).toBe('true');
    expect(inserted(false)).toBe('false');
    expect(inserted(null)).toBe('null');
  });

  it('inserts objects and lists as compact JSON', () => {
    expect(inserted({ a: 1, b: [true, null, 'x'] })).toBe('{"a":1,"b":[true,null,"x"]}');
    expect(inserted([1, 'two', { three: 3 }])).toBe('[1,"two",{"three":3}]');
    expect(inserted([])).toBe('[]');
    expect(inserted({})).toBe('{}');
  });
});

describe('compactJson', () => {
  it('matches JSON.stringify for values without large integers', () => {
    const values: Value[] = [
      null,
      true,
      false,
      0,
      -1.25,
      1e21,
      'text',
      'quote " backslash \\ newline \n tab \t control \u0001 emoji \u{1F600} lone \uD800',
      [],
      {},
      [[], {}, [[]], { a: {} }],
      { b: 1, a: 2, c: { z: [1, { y: null }], x: 'q' } },
      { '': 1, 'key with space': 2, 'k"q': 3, 10: 'ten', 2: 'two' },
      [1, [2, [3, [4, [5]]]]],
    ];
    for (const value of values) {
      expect(json(value)).toBe(JSON.stringify(value));
    }
  });

  it('writes keys in insertion order', () => {
    expect(json({ z: 1, a: 2, m: 3 })).toBe('{"z":1,"a":2,"m":3}');
  });

  it('writes non-finite numbers as null like JSON.stringify', () => {
    expect(json([Number.NaN, Number.POSITIVE_INFINITY])).toBe('[null,null]');
  });

  it('keeps a key named __proto__', () => {
    const value = JSON.parse('{"__proto__": {"a": 1}, "b": 2}') as Value;
    expect(json(value)).toBe('{"__proto__":{"a":1},"b":2}');
  });

  it('writes values nested 10,000 levels deep without overflowing the stack', () => {
    const objects = json(nested(10_000, 1));
    expect(objects.length).toBe(8 * 10_000 + 1 + 10_000);
    expect(objects.startsWith('{"next":{"next":')).toBe(true);
    expect(objects.endsWith(`1${'}'.repeat(10_000)}`)).toBe(true);
    const lists = json(nestedLists(10_000, 'x'));
    expect(lists.length).toBe(10_000 + 3 + 10_000);
    expect(inserted(nested(10_000, 12345678901234567890n)).includes('12345678901234567890')).toBe(
      true,
    );
  });
});

describe('output limit', () => {
  it('names 1 MiB as the limit for inserted values', () => {
    expect(maxInsertedLength).toBe(mebibyte);
  });

  it('returns the text when it is exactly the limit and a too-large result when it is longer', () => {
    expect(compactJson({ a: 1 }, 7)).toEqual({ ok: true, text: '{"a":1}' });
    expect(compactJson({ a: 1 }, 6)).toEqual(tooLarge);
    expect(compactJson([1, 2, 3], 7)).toEqual({ ok: true, text: '[1,2,3]' });
    expect(compactJson([1, 2, 3], 6)).toEqual(tooLarge);
    expect(compactJson([], 2)).toEqual({ ok: true, text: '[]' });
    expect(compactJson([], 1)).toEqual(tooLarge);
    expect(compactJson('é"', 5)).toEqual({ ok: true, text: '"é\\""' });
    expect(compactJson('é"', 4)).toEqual(tooLarge);
    expect(compactJson({ longkey: 1 }, 5)).toEqual(tooLarge);
    expect(compactJson(12345678901234567890n, 20)).toEqual({
      ok: true,
      text: '12345678901234567890',
    });
    expect(compactJson(12345678901234567890n, 19)).toEqual(tooLarge);
    expect(compactJson(null, 3)).toEqual(tooLarge);
    expect(compactJson(null, 4)).toEqual({ ok: true, text: 'null' });
  });

  it('applies to inserted strings, numbers and other values', () => {
    expect(insertText('abc', 3)).toEqual({ ok: true, text: 'abc' });
    expect(insertText('abcd', 3)).toEqual(tooLarge);
    expect(insertText('', 0)).toEqual({ ok: true, text: '' });
    expect(insertText(12345, 5)).toEqual({ ok: true, text: '12345' });
    expect(insertText(12345, 4)).toEqual(tooLarge);
    expect(insertText(12345678901234567890n, 20)).toEqual({
      ok: true,
      text: '12345678901234567890',
    });
    expect(insertText(12345678901234567890n, 19)).toEqual(tooLarge);
    expect(insertText({ a: [1] }, 9)).toEqual({ ok: true, text: '{"a":[1]}' });
    expect(insertText({ a: [1] }, 8)).toEqual(tooLarge);
    expect(insertText(true, 3)).toEqual(tooLarge);
  });

  it('stops a string over the limit without copying it', () => {
    const text = 'x'.repeat(16 * mebibyte);
    for (const call of [
      () => insertText(text, mebibyte),
      () => compactJson(text, mebibyte),
      () => compactJson({ [text]: 1 }, mebibyte),
    ]) {
      call();
      const { result, ms, heap } = measure(call);
      expect(result).toEqual(tooLarge);
      expect(ms).toBeLessThan(100);
      expect(heap).toBeLessThan(mebibyte);
    }
  });

  it('counts escapes of a string that fits before encoding', () => {
    const escaped = '\u0001'.repeat(mebibyte / 2);
    expect(compactJson(escaped, mebibyte)).toEqual(tooLarge);
    expect(compactJson('x'.repeat(mebibyte - 2), mebibyte)).toEqual({
      ok: true,
      text: `"${'x'.repeat(mebibyte - 2)}"`,
    });
  });

  it('stops a 16 MiB list of objects at the limit in under 100 ms and under 8 MiB of heap', () => {
    const text = 'y'.repeat(1_000);
    const value: Value = Array.from({ length: 17 * 1_024 }, (_, id) => ({ id, text }));
    expect(JSON.stringify(value).length).toBeGreaterThan(16 * mebibyte);
    compactJson(value, mebibyte);
    const { result, ms, heap } = measure(() => compactJson(value, mebibyte));
    expect(result).toEqual(tooLarge);
    expect(ms).toBeLessThan(100);
    expect(heap).toBeLessThan(8 * mebibyte);
  });

  it('stops a tree of nested objects over 16 MiB at the limit in under 100 ms and under 16 MiB of heap', () => {
    const tree = (depth: number): Value =>
      depth === 0
        ? { leaf: 'z'.repeat(40) }
        : { name: `node at depth ${String(depth)}`, left: tree(depth - 1), right: tree(depth - 1) };
    const value = tree(18);
    expect(JSON.stringify(value).length).toBeGreaterThan(16 * mebibyte);
    compactJson(value, mebibyte);
    const { result, ms, heap } = measure(() => compactJson(value, mebibyte));
    expect(result).toEqual(tooLarge);
    expect(ms).toBeLessThan(100);
    expect(heap).toBeLessThan(16 * mebibyte);
  });

  it('stops a chain of 2,097,152 nested objects at the limit in under 100 ms and under 48 MiB of heap', () => {
    const value = nested(2 * mebibyte, 1);
    compactJson(value, mebibyte);
    const { result, ms, heap } = measure(() => compactJson(value, mebibyte));
    expect(result).toEqual(tooLarge);
    expect(ms).toBeLessThan(100);
    expect(heap).toBeLessThan(48 * mebibyte);
  });

  it('stops a list of 4 Mi numbers at the limit in under 100 ms and under 24 MiB of heap', () => {
    const value: Value = Array.from({ length: 4 * mebibyte }, (_, index) => index);
    compactJson(value, mebibyte);
    const { result, ms, heap } = measure(() => insertText(value, mebibyte));
    expect(result).toEqual(tooLarge);
    expect(ms).toBeLessThan(100);
    expect(heap).toBeLessThan(24 * mebibyte);
  });

  it('keeps the whole result when it fits', () => {
    const value: Value = Array.from({ length: 1_000 }, (_, id) => ({
      id,
      name: `item ${String(id)}`,
    }));
    const expected = JSON.stringify(value);
    expect(compactJson(value, expected.length)).toEqual({ ok: true, text: expected });
    expect(compactJson(value, expected.length - 1)).toEqual(tooLarge);
  });
});

describe('work counted while inserting', () => {
  it('counts each value, each key, and long text by its length / 16', () => {
    const spent = (value: Value): number => {
      const budget = new WorkBudget();
      insertText(value, mebibyte, budget);
      return budget.spent;
    };

    expect(spent(Array<number>(4_000).fill(0))).toBeGreaterThanOrEqual(4_000);
    expect(
      spent(Object.fromEntries(Array.from({ length: 2_000 }, (_, at) => [`k${String(at)}`, 0]))),
    ).toBeGreaterThanOrEqual(4_000);
    expect(spent(['x'.repeat(65_536)])).toBeGreaterThanOrEqual(4_096);
    expect(spent('x'.repeat(65_536))).toBeLessThan(16);
  });

  it('stops serializing as soon as its budget runs out', () => {
    let checks = 0;
    const budget = new WorkBudget({
      expired: () => {
        checks += 1;
        return true;
      },
    });

    expect(() => compactJson(Array<number>(100_000).fill(0), mebibyte, budget)).toThrow();
    expect(checks).toBe(1);
    expect(budget.exhausted).toBe(true);
  });
});
