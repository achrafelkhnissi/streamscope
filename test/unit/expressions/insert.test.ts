import { describe, expect, it } from 'vitest';
import type { Value } from '../../../src/expressions/ast';
import { compactJson, insertText } from '../../../src/expressions/insert';

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

describe('insertText', () => {
  it('inserts strings as they are', () => {
    expect(insertText('plain text')).toBe('plain text');
    expect(insertText('')).toBe('');
    expect(insertText('say "hi"\n\\')).toBe('say "hi"\n\\');
    expect(insertText('{"a":1}')).toBe('{"a":1}');
  });

  it('keeps the digits of large integers in text and inside compact JSON', () => {
    expect(insertText(12345678901234567890n)).toBe('12345678901234567890');
    expect(insertText(-12345678901234567890n)).toBe('-12345678901234567890');
    expect(compactJson(12345678901234567890n)).toBe('12345678901234567890');
    expect(compactJson({ id: 12345678901234567890n, ids: [9007199254740993n, 1] })).toBe(
      '{"id":12345678901234567890,"ids":[9007199254740993,1]}',
    );
    expect(insertText({ id: 12345678901234567890n })).toBe('{"id":12345678901234567890}');
    expect(insertText([12345678901234567890n])).toBe('[12345678901234567890]');
  });

  it('inserts other numbers as JavaScript prints them', () => {
    expect(insertText(1.5)).toBe('1.5');
    expect(insertText(42)).toBe('42');
    expect(insertText(-0)).toBe('0');
    expect(insertText(1e21)).toBe('1e+21');
    expect(insertText(0.1)).toBe('0.1');
  });

  it('inserts booleans and null as JSON literals', () => {
    expect(insertText(true)).toBe('true');
    expect(insertText(false)).toBe('false');
    expect(insertText(null)).toBe('null');
  });

  it('inserts objects and lists as compact JSON', () => {
    expect(insertText({ a: 1, b: [true, null, 'x'] })).toBe('{"a":1,"b":[true,null,"x"]}');
    expect(insertText([1, 'two', { three: 3 }])).toBe('[1,"two",{"three":3}]');
    expect(insertText([])).toBe('[]');
    expect(insertText({})).toBe('{}');
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
      expect(compactJson(value)).toBe(JSON.stringify(value));
    }
  });

  it('writes keys in insertion order', () => {
    expect(compactJson({ z: 1, a: 2, m: 3 })).toBe('{"z":1,"a":2,"m":3}');
  });

  it('writes non-finite numbers as null like JSON.stringify', () => {
    expect(compactJson([Number.NaN, Number.POSITIVE_INFINITY])).toBe('[null,null]');
  });

  it('keeps a key named __proto__', () => {
    const value = JSON.parse('{"__proto__": {"a": 1}, "b": 2}') as Value;
    expect(compactJson(value)).toBe('{"__proto__":{"a":1},"b":2}');
  });

  it('writes values nested 10,000 levels deep without overflowing the stack', () => {
    const objects = compactJson(nested(10_000, 1));
    expect(objects.length).toBe(8 * 10_000 + 1 + 10_000);
    expect(objects.startsWith('{"next":{"next":')).toBe(true);
    expect(objects.endsWith(`1${'}'.repeat(10_000)}`)).toBe(true);
    const lists = compactJson(nestedLists(10_000, 'x'));
    expect(lists.length).toBe(10_000 + 3 + 10_000);
    expect(insertText(nested(10_000, 12345678901234567890n)).includes('12345678901234567890')).toBe(
      true,
    );
  });
});
