import { describe, expect, it } from 'vitest';
import type { Value } from '../../../src/expressions/ast';
import { compareValues, equalValues } from '../../../src/expressions/compare';
import { WorkBudget } from '../../../src/expressions/work';

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

describe('compareValues and equalValues', () => {
  it('compares numbers and bigints exactly', () => {
    expect(compareValues(12345678901234567890n, 12345678901234567891n)).toBe(-1);
    expect(compareValues(12345678901234567891n, 12345678901234567890n)).toBe(1);
    expect(compareValues(12345678901234567890n, 12345678901234567890n)).toBe(0);
    expect(equalValues(12345678901234567890n, 12345678901234567891n)).toBe(false);
    expect(equalValues(12345678901234567890n, 12345678901234567890n)).toBe(true);
    expect(compareValues(2n, 2)).toBe(0);
    expect(equalValues(2n, 2)).toBe(true);
    expect(equalValues(2, 2n)).toBe(true);
    expect(compareValues(2n, 2.5)).toBe(-1);
    expect(compareValues(3n, 2.5)).toBe(1);
    expect(equalValues(2n, 2.5)).toBe(false);
    expect(compareValues(9007199254740993n, 9007199254740992)).toBe(1);
    expect(equalValues(9007199254740993n, 9007199254740992)).toBe(false);
    expect(compareValues(1.5, 2)).toBe(-1);
    expect(compareValues(-1, 1)).toBe(-1);
    expect(compareValues(0, -0)).toBe(0);
  });

  it('treats NaN as unordered and unequal', () => {
    expect(compareValues(Number.NaN, 1)).toBeUndefined();
    expect(compareValues(1n, Number.NaN)).toBeUndefined();
    expect(equalValues(Number.NaN, Number.NaN)).toBe(false);
  });

  it('never coerces', () => {
    expect(equalValues('1', 1)).toBe(false);
    expect(equalValues(1, '1')).toBe(false);
    expect(equalValues(true, 1)).toBe(false);
    expect(equalValues(null, 0)).toBe(false);
    expect(equalValues('', false)).toBe(false);
    expect(equalValues('1', 1n)).toBe(false);
    expect(equalValues([], '')).toBe(false);
    expect(compareValues('1', 1)).toBeUndefined();
    expect(compareValues(true, false)).toBeUndefined();
    expect(compareValues(null, 0)).toBeUndefined();
    expect(compareValues(1n, '1')).toBeUndefined();
  });

  it('compares scalars of the same kind for equality', () => {
    expect(equalValues(null, null)).toBe(true);
    expect(equalValues(true, true)).toBe(true);
    expect(equalValues(true, false)).toBe(false);
    expect(equalValues('a', 'a')).toBe(true);
    expect(equalValues('a', 'b')).toBe(false);
    expect(compareValues(null, null)).toBe(0);
    expect(compareValues(true, true)).toBe(0);
  });

  it('compares arrays and objects deeply', () => {
    expect(equalValues([1, { a: [2, 3n] }], [1, { a: [2, 3] }])).toBe(true);
    expect(equalValues({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(equalValues([1, 2], [2, 1])).toBe(false);
    expect(equalValues([1, 2], [1, 2, 3])).toBe(false);
    expect(equalValues({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(equalValues({ a: 1 }, { b: 1 })).toBe(false);
    expect(equalValues({ a: [1, { b: 'x' }] }, { a: [1, { b: 'y' }] })).toBe(false);
    expect(equalValues([], [])).toBe(true);
    expect(equalValues({}, {})).toBe(true);
    expect(equalValues([], {})).toBe(false);
    expect(equalValues([null], [0])).toBe(false);
  });

  it('orders arrays and objects only by equality', () => {
    expect(compareValues([1, 2], [1, 2])).toBe(0);
    expect(compareValues({ a: 1 }, { a: 1 })).toBe(0);
    expect(compareValues([1], [2])).toBeUndefined();
    expect(compareValues({ a: 1 }, { a: 2 })).toBeUndefined();
  });

  it('orders strings by code unit', () => {
    expect(compareValues('a', 'b')).toBe(-1);
    expect(compareValues('b', 'a')).toBe(1);
    expect(compareValues('a', 'a')).toBe(0);
    expect(compareValues('B', 'a')).toBe(-1);
    expect(compareValues('ab', 'a')).toBe(1);
    expect(compareValues('', 'a')).toBe(-1);
    expect(compareValues('\u{1F600}', '￿')).toBe(-1);
  });

  it('does not treat inherited names as keys', () => {
    expect(equalValues({ a: 1 }, JSON.parse('{"__proto__": 1}') as Value)).toBe(false);
    expect(
      equalValues(JSON.parse('{"__proto__": 1}') as Value, JSON.parse('{"__proto__": 1}') as Value),
    ).toBe(true);
    expect(equalValues({ toString: 1 }, { valueOf: 1 })).toBe(false);
  });

  it('compares values nested 10,000 levels deep without overflowing the stack', () => {
    expect(equalValues(nested(10_000, 1), nested(10_000, 1))).toBe(true);
    expect(equalValues(nested(10_000, 1), nested(10_000, 2))).toBe(false);
    expect(equalValues(nested(10_000, 1), nested(9_999, 1))).toBe(false);
    expect(equalValues(nestedLists(10_000, 'x'), nestedLists(10_000, 'x'))).toBe(true);
    expect(compareValues(nestedLists(10_000, 'x'), nestedLists(10_000, 'x'))).toBe(0);
    expect(compareValues(nestedLists(10_000, 'x'), nestedLists(10_000, 'y'))).toBeUndefined();
  });
});

describe('the work of one comparison', () => {
  function zeros(length: number, last: number): Value {
    const list = Array.from({ length }, () => 0);
    list[length - 1] = last;
    return list;
  }

  function keyed(count: number, lastKey: string, lastValue: number): Value {
    const entries: [string, number][] = Array.from({ length: count - 1 }, (_, at) => [
      `k${String(at)}`,
      0,
    ]);
    entries.push([lastKey, lastValue]);
    return Object.fromEntries(entries);
  }

  const compares = [
    ['equalValues', equalValues],
    ['compareValues', compareValues],
  ] as const;

  it.each(compares)(
    '%s charges two lists that differ only in their last item by their length',
    (_name, compare) => {
      const budget = new WorkBudget();

      compare(zeros(100_000, 0), zeros(100_000, 1), budget);

      expect(budget.spent).toBeGreaterThanOrEqual(100_000);
    },
  );

  it.each(compares)(
    '%s charges two objects that differ only at their last key by their key count, every time',
    (_name, compare) => {
      for (const [left, right] of [
        [keyed(2_000, 'last', 0), keyed(2_000, 'other', 0)],
        [keyed(2_000, 'last', 0), keyed(2_000, 'last', 1)],
      ]) {
        const budget = new WorkBudget();
        compare(left as Value, right as Value, budget);
        const once = budget.spent;

        compare(left as Value, right as Value, budget);

        expect(once).toBeGreaterThanOrEqual(2_000);
        expect(budget.spent - once).toBeGreaterThanOrEqual(2_000);
      }
    },
  );

  it.each(compares)(
    '%s reaches a clock check inside one comparison of two long lists or objects, keys remembered',
    (_name, compare) => {
      for (const [left, right] of [
        [zeros(100_000, 0), zeros(100_000, 1)],
        [keyed(5_000, 'last', 0), keyed(5_000, 'other', 0)],
        [keyed(5_000, 'last', 0), keyed(5_000, 'last', 1)],
      ]) {
        let expired = false;
        const budget = new WorkBudget({ expired: () => expired });
        compare(left as Value, right as Value, budget);
        expired = true;

        expect(() => compare(left as Value, right as Value, budget)).toThrow();
        expect(budget.exhausted).toBe(true);
      }
    },
  );

  it('still finds equal and unequal values the same way', () => {
    expect(equalValues(zeros(5_000, 1), zeros(5_000, 1), new WorkBudget())).toBe(true);
    expect(equalValues(zeros(5_000, 1), zeros(5_000, 2), new WorkBudget())).toBe(false);
    expect(equalValues(keyed(3_000, 'a', 1), keyed(3_000, 'a', 1), new WorkBudget())).toBe(true);
    expect(equalValues(keyed(3_000, 'a', 1), keyed(3_000, 'b', 1), new WorkBudget())).toBe(false);
    expect(equalValues([{ a: [1, 2] }, 3], [{ a: [1, 2] }, 3], new WorkBudget())).toBe(true);
    expect(equalValues([{ a: [1, 2] }, 3], [{ a: [1, 3] }, 3], new WorkBudget())).toBe(false);
    expect(compareValues(zeros(5_000, 1), zeros(5_000, 1), new WorkBudget())).toBe(0);
  });
});
