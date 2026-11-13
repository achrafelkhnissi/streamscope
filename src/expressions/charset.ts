export type CharSet = readonly (readonly [number, number])[];

const maxCodePoint = 0x10ffff;
const maxCaseRange = 512;

export const emptySet: CharSet = [];
export const fullSet: CharSet = [[0, maxCodePoint]];
export const digitSet: CharSet = [[0x30, 0x39]];
export const lineTerminatorSet: CharSet = [
  [0x0a, 0x0a],
  [0x0d, 0x0d],
  [0x2028, 0x2029],
];
export const spaceSet: CharSet = [
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
];

const asciiWordSet: CharSet = [
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
];
const foldedWordSet: CharSet = [
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
  [0x17f, 0x17f],
  [0x212a, 0x212a],
];

export function wordSet(unicodeIgnoreCase: boolean): CharSet {
  return unicodeIgnoreCase ? foldedWordSet : asciiWordSet;
}

export function singleton(code: number): CharSet {
  return [[code, code]];
}

export function rangeSet(low: number, high: number): CharSet {
  return low <= high ? [[low, high]] : emptySet;
}

export function union(left: CharSet, right: CharSet): CharSet {
  const merged: [number, number][] = [];
  const ranges = [...left, ...right].sort((first, second) => first[0] - second[0]);
  for (const [low, high] of ranges) {
    const last = merged.at(-1);
    if (last !== undefined && low <= last[1] + 1) {
      last[1] = Math.max(last[1], high);
    } else {
      merged.push([low, high]);
    }
  }
  return merged;
}

export function intersection(left: CharSet, right: CharSet): CharSet {
  const result: [number, number][] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  for (;;) {
    const first = left[leftIndex];
    const second = right[rightIndex];
    if (first === undefined || second === undefined) {
      return result;
    }
    const low = Math.max(first[0], second[0]);
    const high = Math.min(first[1], second[1]);
    if (low <= high) {
      result.push([low, high]);
    }
    if (first[1] < second[1]) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }
}

export function intersects(left: CharSet, right: CharSet): boolean {
  let leftIndex = 0;
  let rightIndex = 0;
  for (;;) {
    const first = left[leftIndex];
    const second = right[rightIndex];
    if (first === undefined || second === undefined) {
      return false;
    }
    if (Math.max(first[0], second[0]) <= Math.min(first[1], second[1])) {
      return true;
    }
    if (first[1] < second[1]) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }
}

export function complement(set: CharSet): CharSet {
  const result: [number, number][] = [];
  let next = 0;
  for (const [low, high] of set) {
    if (low > next) {
      result.push([next, low - 1]);
    }
    next = high + 1;
  }
  if (next <= maxCodePoint) {
    result.push([next, maxCodePoint]);
  }
  return result;
}

export function withBothCases(set: CharSet): CharSet {
  const extra: [number, number][] = [];
  for (const [low, high] of set) {
    const upper = [Math.max(low, 0x41), Math.min(high, 0x5a)] as const;
    if (upper[0] <= upper[1]) {
      extra.push([upper[0] + 32, upper[1] + 32]);
    }
    const lower = [Math.max(low, 0x61), Math.min(high, 0x7a)] as const;
    if (lower[0] <= lower[1]) {
      extra.push([lower[0] - 32, lower[1] - 32]);
    }
    const start = Math.max(low, 0x80);
    if (high - start >= maxCaseRange) {
      return fullSet;
    }
    for (let code = start; code <= high; code += 1) {
      for (const variant of caseVariants(code)) {
        extra.push([variant, variant]);
        if (isAsciiLetter(variant)) {
          extra.push([variant ^ 0x20, variant ^ 0x20]);
        }
      }
    }
  }
  return union(set, extra);
}

function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function caseVariants(code: number): number[] {
  const text = String.fromCodePoint(code);
  const variants: number[] = [];
  for (const mapped of [text.toLowerCase(), text.toUpperCase()]) {
    const variant = mapped.codePointAt(0);
    if (variant !== undefined && mapped.length === String.fromCodePoint(variant).length) {
      variants.push(variant);
    }
  }
  return variants;
}
