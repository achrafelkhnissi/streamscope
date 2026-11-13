import {
  complement,
  digitSet,
  emptySet,
  fullSet,
  lineTerminatorSet,
  rangeSet,
  singleton,
  spaceSet,
  union,
  withBothCases,
  wordSet,
  type CharSet,
} from './charset';

export interface Mode {
  ignoreCase: boolean;
  dotAll: boolean;
  unicode: boolean;
}

export interface Atom {
  set: CharSet | undefined;
  end: number;
}

type Piece =
  | { kind: 'char'; code: number; end: number }
  | { kind: 'set'; set: CharSet; end: number }
  | { kind: 'boundary'; end: number }
  | { kind: 'unknown'; end: number };

const maxBmpCode = 0xffff;
const hexDigits = /^[0-9a-fA-F]+$/;
const letter = /^[A-Za-z]$/;
const dotSet = complement(lineTerminatorSet);
const controlEscapes: ReadonlyMap<string, number> = new Map([
  ['n', 0x0a],
  ['r', 0x0d],
  ['t', 0x09],
  ['f', 0x0c],
  ['v', 0x0b],
]);

export function modeOf(flags: string): Mode {
  return {
    ignoreCase: flags.includes('i'),
    dotAll: flags.includes('s'),
    unicode: flags.includes('u'),
  };
}

export function readAtom(pattern: string, index: number, mode: Mode): Atom {
  const piece = readPiece(pattern, index, mode, false);
  switch (piece.kind) {
    case 'char':
      return { set: charMembers(piece.code, mode), end: piece.end };
    case 'set':
      return { set: piece.set, end: piece.end };
    case 'boundary':
      return { set: undefined, end: piece.end };
    case 'unknown':
      return { set: fullSet, end: piece.end };
  }
}

function charMembers(code: number, mode: Mode): CharSet {
  if (code > maxBmpCode) {
    return fullSet;
  }
  return folded(singleton(code), mode);
}

function folded(set: CharSet, mode: Mode): CharSet {
  return mode.ignoreCase ? withBothCases(set) : set;
}

function codePointAt(pattern: string, index: number): { code: number; end: number } {
  const high = pattern.charCodeAt(index);
  const low = pattern.charCodeAt(index + 1);
  if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
    return { code: (high - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000, end: index + 2 };
  }
  return { code: high, end: index + 1 };
}

function readPiece(pattern: string, index: number, mode: Mode, inClass: boolean): Piece {
  const char = pattern.charAt(index);
  if (char === '\\') {
    return readEscape(pattern, index, mode, inClass);
  }
  if (!inClass && char === '.') {
    return { kind: 'set', set: mode.dotAll ? fullSet : dotSet, end: index + 1 };
  }
  if (!inClass && char === '[') {
    return readClass(pattern, index, mode);
  }
  return { kind: 'char', ...codePointAt(pattern, index) };
}

function readEscape(pattern: string, index: number, mode: Mode, inClass: boolean): Piece {
  const kind = pattern.charAt(index + 1);
  const end = index + 2;
  switch (kind) {
    case 'd':
      return { kind: 'set', set: digitSet, end };
    case 'D':
      return { kind: 'set', set: complement(digitSet), end };
    case 'w':
      return { kind: 'set', set: wordSet(mode.ignoreCase && mode.unicode), end };
    case 'W':
      return { kind: 'set', set: complement(wordSet(mode.ignoreCase && mode.unicode)), end };
    case 's':
      return { kind: 'set', set: spaceSet, end };
    case 'S':
      return { kind: 'set', set: complement(spaceSet), end };
    case 'b':
      return inClass ? { kind: 'char', code: 0x08, end } : { kind: 'boundary', end };
    case 'B':
      return inClass ? { kind: 'unknown', end } : { kind: 'boundary', end };
    case '0':
      return /^\d$/.test(pattern.charAt(end))
        ? { kind: 'unknown', end }
        : { kind: 'char', code: 0, end };
    case 'x':
      return hexEscape(pattern, index, mode);
    case 'u':
      return unicodeEscape(pattern, index, mode);
    case 'c':
      return letter.test(pattern.charAt(end))
        ? { kind: 'char', code: pattern.charCodeAt(end) % 32, end: end + 1 }
        : { kind: 'unknown', end };
    case 'p':
    case 'P':
      return mode.unicode
        ? propertyEscape(pattern, index)
        : { kind: 'char', code: kind.charCodeAt(0), end };
    case '':
      return { kind: 'unknown', end: pattern.length };
    default: {
      const control = controlEscapes.get(kind);
      if (control !== undefined) {
        return { kind: 'char', code: control, end };
      }
      if (kind >= '1' && kind <= '9') {
        return { kind: 'unknown', end };
      }
      return { kind: 'char', ...codePointAt(pattern, index + 1) };
    }
  }
}

function readHex(pattern: string, start: number, length: number): number | undefined {
  const digits = pattern.slice(start, start + length);
  return digits.length === length && hexDigits.test(digits) ? parseInt(digits, 16) : undefined;
}

function hexEscape(pattern: string, index: number, mode: Mode): Piece {
  const code = readHex(pattern, index + 2, 2);
  if (code !== undefined) {
    return { kind: 'char', code, end: index + 4 };
  }
  return malformedEscape(pattern, index, mode);
}

function unicodeEscape(pattern: string, index: number, mode: Mode): Piece {
  if (mode.unicode && pattern.charAt(index + 2) === '{') {
    const close = pattern.indexOf('}', index + 3);
    if (close === -1) {
      return { kind: 'unknown', end: pattern.length };
    }
    const digits = pattern.slice(index + 3, close);
    const code = hexDigits.test(digits) ? parseInt(digits, 16) : undefined;
    return code === undefined || code > 0x10ffff
      ? { kind: 'unknown', end: close + 1 }
      : { kind: 'char', code, end: close + 1 };
  }
  const code = readHex(pattern, index + 2, 4);
  if (code === undefined) {
    return malformedEscape(pattern, index, mode);
  }
  if (mode.unicode && code >= 0xd800 && code <= 0xdfff) {
    return { kind: 'unknown', end: index + 6 };
  }
  return { kind: 'char', code, end: index + 6 };
}

function malformedEscape(pattern: string, index: number, mode: Mode): Piece {
  const end = index + 2;
  return mode.unicode
    ? { kind: 'unknown', end }
    : { kind: 'char', code: pattern.charCodeAt(index + 1), end };
}

function propertyEscape(pattern: string, index: number): Piece {
  if (pattern.charAt(index + 2) !== '{') {
    return { kind: 'unknown', end: index + 2 };
  }
  const close = pattern.indexOf('}', index + 3);
  return { kind: 'unknown', end: close === -1 ? pattern.length : close + 1 };
}

function readClass(pattern: string, index: number, mode: Mode): Piece {
  let position = index + 1;
  const negated = pattern.charAt(position) === '^';
  if (negated) {
    position += 1;
  }
  let members: CharSet = emptySet;
  let unknown = false;
  while (position < pattern.length) {
    if (pattern.charAt(position) === ']') {
      const set = unknown ? fullSet : negated ? complement(members) : members;
      return { kind: 'set', set, end: position + 1 };
    }
    const first = readPiece(pattern, position, mode, true);
    position = first.end;
    if (first.kind !== 'char') {
      if (first.kind === 'set') {
        members = union(members, first.set);
      } else {
        unknown = true;
      }
      continue;
    }
    unknown ||= first.code > maxBmpCode;
    const second =
      pattern.charAt(position) === '-' &&
      position + 1 < pattern.length &&
      pattern.charAt(position + 1) !== ']'
        ? readPiece(pattern, position + 1, mode, true)
        : undefined;
    if (second?.kind === 'char') {
      unknown ||= second.code > maxBmpCode || second.code < first.code;
      members = union(members, folded(rangeSet(first.code, second.code), mode));
      position = second.end;
      continue;
    }
    members = union(members, folded(singleton(first.code), mode));
    if (second !== undefined) {
      members = union(members, folded(singleton(0x2d), mode));
      if (second.kind === 'set') {
        members = union(members, second.set);
      } else {
        unknown = true;
      }
      position = second.end;
    }
  }
  return { kind: 'set', set: fullSet, end: pattern.length };
}
