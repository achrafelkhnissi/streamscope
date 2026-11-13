import { describe, expect, it } from 'vitest';
import {
  complement,
  emptySet,
  fullSet,
  intersection,
  intersects,
  rangeSet,
  singleton,
  spaceSet,
  union,
  withBothCases,
  wordSet,
} from '../../../src/expressions/charset';

describe('character sets', () => {
  it('merges overlapping and adjacent ranges in a union', () => {
    expect(union([[1, 3]], [[4, 6]])).toStrictEqual([[1, 6]]);
    expect(union([[1, 5]], [[3, 9]])).toStrictEqual([[1, 9]]);
    expect(union([[1, 2]], [[4, 5]])).toStrictEqual([
      [1, 2],
      [4, 5],
    ]);
    expect(
      union(
        [[10, 20]],
        [
          [1, 2],
          [30, 40],
        ],
      ),
    ).toStrictEqual([
      [1, 2],
      [10, 20],
      [30, 40],
    ]);
    expect(union(emptySet, emptySet)).toStrictEqual([]);
  });

  it('intersects ranges', () => {
    expect(
      intersection(
        [
          [1, 10],
          [20, 30],
        ],
        [
          [5, 25],
          [30, 40],
        ],
      ),
    ).toStrictEqual([
      [5, 10],
      [20, 25],
      [30, 30],
    ]);
    expect(intersection([[1, 2]], [[3, 4]])).toStrictEqual([]);
    expect(intersection(fullSet, emptySet)).toStrictEqual([]);
    expect(intersection(fullSet, singleton(65))).toStrictEqual([[65, 65]]);
  });

  it('tells whether two sets share a character without building the intersection', () => {
    expect(intersects([[1, 3]], [[3, 5]])).toBe(true);
    expect(intersects([[1, 2]], [[3, 5]])).toBe(false);
    expect(intersects(emptySet, fullSet)).toBe(false);
    expect(
      intersects(
        [
          [1, 2],
          [10, 12],
        ],
        [
          [3, 4],
          [12, 13],
        ],
      ),
    ).toBe(true);
  });

  it('complements within the code point range', () => {
    expect(complement(emptySet)).toStrictEqual(fullSet);
    expect(complement(fullSet)).toStrictEqual([]);
    expect(complement([[0, 9]])).toStrictEqual([[10, 0x10ffff]]);
    expect(complement([[5, 0x10ffff]])).toStrictEqual([[0, 4]]);
    expect(
      complement([
        [5, 6],
        [10, 10],
      ]),
    ).toStrictEqual([
      [0, 4],
      [7, 9],
      [11, 0x10ffff],
    ]);
  });

  it('ignores a range that runs backwards', () => {
    expect(rangeSet(5, 4)).toStrictEqual([]);
    expect(rangeSet(4, 4)).toStrictEqual([[4, 4]]);
  });

  it('adds the other case of ASCII letters and of other single-character mappings', () => {
    expect(withBothCases(singleton(0x61))).toStrictEqual([
      [0x41, 0x41],
      [0x61, 0x61],
    ]);
    expect(withBothCases(rangeSet(0x41, 0x43))).toStrictEqual([
      [0x41, 0x43],
      [0x61, 0x63],
    ]);
    expect(withBothCases(rangeSet(0x30, 0x39))).toStrictEqual([[0x30, 0x39]]);
    expect(withBothCases(singleton(0xe9))).toStrictEqual([
      [0xc9, 0xc9],
      [0xe9, 0xe9],
    ]);
    expect(withBothCases(singleton(0x212a))).toStrictEqual([
      [0x4b, 0x4b],
      [0x6b, 0x6b],
      [0x212a, 0x212a],
    ]);
    expect(withBothCases(singleton(0xdf))).toStrictEqual([[0xdf, 0xdf]]);
  });

  it('gives up on a non-ASCII range too large to fold', () => {
    expect(withBothCases(rangeSet(0x100, 0x2ff))).not.toStrictEqual(fullSet);
    expect(withBothCases(rangeSet(0x100, 0xffff))).toStrictEqual(fullSet);
  });

  it('adds the characters that fold into word characters only with i and u', () => {
    expect(intersects(wordSet(false), singleton(0x212a))).toBe(false);
    expect(intersects(wordSet(true), singleton(0x212a))).toBe(true);
    expect(intersects(wordSet(true), singleton(0x17f))).toBe(true);
  });

  it('holds the JavaScript white space characters', () => {
    for (const code of [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x2003, 0x2028, 0xfeff]) {
      expect(intersects(spaceSet, singleton(code)), code.toString(16)).toBe(true);
    }
    expect(intersects(spaceSet, singleton(0x200b))).toBe(false);
  });
});
