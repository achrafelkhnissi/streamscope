import { BoundedCache } from './bounded-cache';

const maxPatternLength = 500;
const maxCachedPatterns = 256;
const maxInstructions = 2000;
const maxCount = maxInstructions;
const maxWork = 1_000_000;
const maxCachedPerAtom = 256;
const maxCachedPerPattern = 16_384;
const heavyWeight = 8;
const maxCodePoint = 0x10ffff;
const allowedFlags = 'imsu';
const braceQuantifier = /\{(\d+)(?:(,)(\d*))?\}/y;
const hexDigits = /^[0-9a-fA-F]+$/;
const hexPair = /^[0-9a-fA-F]{2}$/;
const hexQuad = /^[0-9a-fA-F]{4}$/;
const groupName = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const modifierCharacter = /[A-Za-z-]/;
const letter = /^[A-Za-z]$/;
const syntaxCharacters = '^$\\.*+?()[]{}|/';
const checkedPatterns = new BoundedCache<PatternCheck>(maxCachedPatterns);

const opChar = 0;
const opAny = 1;
const opSplit = 2;
const opJump = 3;
const opSave = 4;
const opClear = 5;
const opAssert = 6;
const opMatch = 7;

const startOfText = 0;
const endOfText = 1;
const wordBoundary = 2;
const notWordBoundary = 3;

const messages = {
  tooLong: `A regular expression is at most ${String(maxPatternLength)} characters.`,
  tooLarge: 'This regular expression is too large.',
  countTooLarge: 'The repetition count is too large for this regular expression.',
  outOfOrder: 'The numbers in a quantifier are out of order.',
  backreference: 'Backreferences such as `\\1` are not supported in regular expressions.',
  namedBackreference:
    'Named backreferences such as `\\k<name>` are not supported in regular expressions.',
  lookahead: 'Lookahead such as `(?=…)` is not supported in regular expressions.',
  lookbehind: 'Lookbehind such as `(?<=…)` is not supported in regular expressions.',
  modifier:
    'Inline modifiers such as `(?i:…)` are not supported in regular expressions. Put the flag after the closing slash instead.',
  group: 'This group syntax is not supported in regular expressions.',
  emptyRepeat:
    'A repeated group that can match the empty string is not supported in regular expressions.',
  octal: 'Octal escapes are not supported in regular expressions.',
  escape: 'Invalid escape sequence.',
  control: 'A control escape needs a letter after `\\c`.',
  property: 'This Unicode property escape or character class is not valid.',
  backslash: 'A backslash at the end of the regular expression has nothing to escape.',
  nothingToRepeat: 'Nothing to repeat.',
  incompleteQuantifier: 'Incomplete quantifier.',
  unmatched: 'Unmatched `)`.',
  unterminatedGroup: 'Unterminated group.',
  unterminatedName: 'Unterminated group name.',
  invalidName: 'Invalid group name.',
  unterminatedClass: 'Unterminated character class.',
  classOrder: 'The range in the character class is out of order.',
  classRange: 'Invalid character class range.',
};

export interface RegexMatch {
  match: string;
  group: string | undefined;
}

export interface CompiledPattern {
  work(subject: string): number;
  test(subject: string): boolean | 'too-long';
  firstMatch(subject: string): RegexMatch | undefined | 'too-long';
}

export type CompileResult =
  | { ok: true; pattern: CompiledPattern }
  | { ok: false; message: string; offset: number; length: number };

export type PatternCheck =
  { ok: true } | { ok: false; message: string; offset: number; length: number };

export interface FlagProblem {
  index: number;
  message: string;
}

interface Mode {
  ignoreCase: boolean;
  multiline: boolean;
  dotAll: boolean;
  unicode: boolean;
}

type CharTest = (code: number) => boolean;
type Pair = [number, number];

type Escape = { kind: 'char'; code: number } | { kind: 'set'; pairs: Pair[]; engine: boolean };

interface RepeatNode {
  kind: 'repeat';
  body: Node;
  min: number;
  max: number;
  greedy: boolean;
  firstGroup: number;
  lastGroup: number;
  offset: number;
  length: number;
}

type Node =
  | { kind: 'empty' }
  | { kind: 'atom'; test: CharTest; heavy: boolean }
  | { kind: 'assert'; assertion: number }
  | { kind: 'concat'; items: Node[] }
  | { kind: 'alt'; items: Node[] }
  | { kind: 'group'; index: number; body: Node }
  | RepeatNode;

interface Program {
  ops: Uint8Array;
  xs: Int32Array;
  ys: Int32Array;
  tests: readonly (CharTest | undefined)[];
  size: number;
  weight: number;
  hasGroup: boolean;
}

interface CachePool {
  entries: number;
}

class PatternError extends Error {
  readonly offset: number;
  readonly length: number;

  constructor(message: string, offset: number, length: number) {
    super(message);
    this.offset = offset;
    this.length = length;
  }
}

export function checkFlags(flags: string): FlagProblem | undefined {
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags.charAt(index);
    if (!allowedFlags.includes(flag)) {
      return {
        index,
        message: `Unsupported regular expression flag \`${flag}\`. Supported flags are i, m, s and u.`,
      };
    }
    if (flags.indexOf(flag) < index) {
      return { index, message: `Duplicate regular expression flag \`${flag}\`.` };
    }
  }
  return undefined;
}

export function compilePattern(pattern: string, flags: string): CompileResult {
  const flagProblem = checkFlags(flags);
  if (flagProblem !== undefined) {
    return { ok: false, message: flagProblem.message, offset: 0, length: 1 };
  }
  if (pattern.length > maxPatternLength) {
    return {
      ok: false,
      message: messages.tooLong,
      offset: maxPatternLength,
      length: pattern.length - maxPatternLength,
    };
  }
  const mode: Mode = {
    ignoreCase: flags.includes('i'),
    multiline: flags.includes('m'),
    dotAll: flags.includes('s'),
    unicode: flags.includes('u'),
  };
  try {
    const { root, groups } = new Parser(pattern, mode).parse();
    const program = new Emitter(pattern.length).build(root, groups);
    return { ok: true, pattern: new Matcher(program, mode) };
  } catch (error) {
    if (error instanceof PatternError) {
      return { ok: false, message: error.message, offset: error.offset, length: error.length };
    }
    throw error;
  }
}

function outcome(result: CompileResult): PatternCheck {
  return result.ok ? { ok: true } : result;
}

export function checkPatternCached(pattern: string, flags: string): PatternCheck {
  if (pattern.length > maxPatternLength || checkFlags(flags) !== undefined) {
    return outcome(compilePattern(pattern, flags));
  }
  const key = `${flags}/${pattern}`;
  let check = checkedPatterns.get(key);
  if (check === undefined) {
    check = outcome(compilePattern(pattern, flags));
    checkedPatterns.set(key, check);
  }
  return check;
}

function at<T>(items: ArrayLike<T>, index: number): T {
  return items[index] as T;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isLineTerminator(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function codePointAt(text: string, index: number): number {
  const high = text.charCodeAt(index);
  if (isHighSurrogate(high)) {
    const low = text.charCodeAt(index + 1);
    if (isLowSurrogate(low)) {
      return (high - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
    }
  }
  return high;
}

const digitPairs: Pair[] = [[0x30, 0x39]];
const wordPairs: Pair[] = [
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
];
const spacePairs: Pair[] = [
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

function mergeRanges(pairs: Pair[]): number[] {
  const merged: number[] = [];
  for (const [low, high] of [...pairs].sort((first, second) => first[0] - second[0])) {
    const last = merged.at(-1);
    if (last !== undefined && low <= last + 1) {
      merged[merged.length - 1] = Math.max(last, high);
    } else {
      merged.push(low, high);
    }
  }
  return merged;
}

function complementPairs(pairs: Pair[]): Pair[] {
  const flat = mergeRanges(pairs);
  const result: Pair[] = [];
  let next = 0;
  for (let index = 0; index < flat.length; index += 2) {
    const low = at(flat, index);
    if (low > next) {
      result.push([next, low - 1]);
    }
    next = at(flat, index + 1) + 1;
  }
  if (next <= maxCodePoint) {
    result.push([next, maxCodePoint]);
  }
  return result;
}

function inRanges(flat: readonly number[], code: number): boolean {
  let low = 0;
  let high = flat.length / 2 - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (code < at(flat, middle * 2)) {
      high = middle - 1;
    } else if (code > at(flat, middle * 2 + 1)) {
      low = middle + 1;
    } else {
      return true;
    }
  }
  return false;
}

function rangeTest(pairs: Pair[], negated: boolean): CharTest {
  const flat = mergeRanges(pairs);
  return negated ? (code) => !inRanges(flat, code) : (code) => inRanges(flat, code);
}

const anyCharacter: CharTest = () => true;
const notLineTerminator: CharTest = (code) => !isLineTerminator(code);

function remember(
  cache: Map<number, boolean>,
  pool: CachePool,
  code: number,
  result: boolean,
): void {
  if (cache.size >= maxCachedPerAtom || pool.entries >= maxCachedPerPattern) {
    const oldest = cache.keys().next();
    if (oldest.done === true) {
      return;
    }
    cache.delete(oldest.value);
    pool.entries -= 1;
  }
  cache.set(code, result);
  pool.entries += 1;
}

function engineTest(expression: RegExp, pool: CachePool): CharTest {
  const ascii = new Uint8Array(128);
  const others = new Map<number, boolean>();
  return (code) => {
    if (code < 128) {
      const known = at(ascii, code);
      if (known !== 0) {
        return known === 1;
      }
      const result = expression.test(String.fromCharCode(code));
      ascii[code] = result ? 1 : 2;
      return result;
    }
    const cached = others.get(code);
    if (cached !== undefined) {
      return cached;
    }
    const result = expression.test(String.fromCodePoint(code));
    remember(others, pool, code, result);
    return result;
  };
}

function nullable(node: Node): boolean {
  switch (node.kind) {
    case 'empty':
    case 'assert':
      return true;
    case 'atom':
      return false;
    case 'concat':
      return node.items.every(nullable);
    case 'alt':
      return node.items.some(nullable);
    case 'group':
      return nullable(node.body);
    case 'repeat':
      return node.min === 0 || nullable(node.body);
  }
}

class Parser {
  private position = 0;
  private groupCount = 0;
  private readonly names = new Set<string>();
  private readonly pool: CachePool = { entries: 0 };

  constructor(
    private readonly pattern: string,
    private readonly mode: Mode,
  ) {}

  parse(): { root: Node; groups: number } {
    const root = this.disjunction();
    if (this.position < this.pattern.length) {
      throw new PatternError(messages.unmatched, this.position, 1);
    }
    return { root, groups: this.groupCount };
  }

  private peek(ahead = 0): string {
    return this.pattern.charAt(this.position + ahead);
  }

  private disjunction(): Node {
    const first = this.alternative();
    if (this.peek() !== '|') {
      return first;
    }
    const items = [first];
    while (this.peek() === '|') {
      this.position += 1;
      items.push(this.alternative());
    }
    return { kind: 'alt', items };
  }

  private alternative(): Node {
    const items: Node[] = [];
    for (;;) {
      const char = this.peek();
      if (char === '' || char === '|' || char === ')') {
        break;
      }
      items.push(this.term());
    }
    const [only] = items;
    if (only === undefined) {
      return { kind: 'empty' };
    }
    return items.length === 1 ? only : { kind: 'concat', items };
  }

  private term(): Node {
    const start = this.position;
    const firstGroup = this.groupCount + 1;
    const assertion = this.startsAssertion();
    const body = this.atom();
    if (assertion) {
      const length = this.quantifierLength();
      if (length > 0) {
        throw new PatternError(messages.nothingToRepeat, this.position, length);
      }
      return body;
    }
    const quantifier = this.quantifier();
    if (quantifier === undefined) {
      return body;
    }
    const length = this.position - start;
    if (quantifier.max > quantifier.min && nullable(body)) {
      throw new PatternError(messages.emptyRepeat, start, length);
    }
    return {
      kind: 'repeat',
      body,
      min: quantifier.min,
      max: quantifier.max,
      greedy: quantifier.greedy,
      firstGroup,
      lastGroup: this.groupCount,
      offset: start,
      length,
    };
  }

  private startsAssertion(): boolean {
    const char = this.peek();
    if (char === '^' || char === '$') {
      return true;
    }
    const next = this.peek(1);
    return char === '\\' && (next === 'b' || next === 'B');
  }

  private quantifierLength(): number {
    const char = this.peek();
    if (char === '*' || char === '+' || char === '?') {
      return 1;
    }
    if (char === '{') {
      braceQuantifier.lastIndex = this.position;
      return braceQuantifier.exec(this.pattern)?.[0].length ?? 0;
    }
    return 0;
  }

  private quantifier(): { min: number; max: number; greedy: boolean } | undefined {
    const start = this.position;
    const char = this.peek();
    let min: number;
    let max: number;
    if (char === '*') {
      min = 0;
      max = Infinity;
      this.position += 1;
    } else if (char === '+') {
      min = 1;
      max = Infinity;
      this.position += 1;
    } else if (char === '?') {
      min = 0;
      max = 1;
      this.position += 1;
    } else if (char === '{') {
      braceQuantifier.lastIndex = start;
      const match = braceQuantifier.exec(this.pattern);
      if (match === null) {
        if (this.mode.unicode) {
          throw new PatternError(messages.incompleteQuantifier, start, 1);
        }
        return undefined;
      }
      const [text, minText, comma, maxText] = match;
      min = Number(minText);
      max = comma === undefined ? min : maxText === '' ? Infinity : Number(maxText);
      this.position = start + text.length;
      if (min > maxCount || (max !== Infinity && max > maxCount)) {
        throw new PatternError(messages.countTooLarge, start, text.length);
      }
      if (max < min) {
        throw new PatternError(messages.outOfOrder, start, text.length);
      }
    } else {
      return undefined;
    }
    const greedy = this.peek() !== '?';
    if (!greedy) {
      this.position += 1;
    }
    return { min, max, greedy };
  }

  private atom(): Node {
    const start = this.position;
    const char = this.peek();
    switch (char) {
      case '^':
        this.position += 1;
        return { kind: 'assert', assertion: startOfText };
      case '$':
        this.position += 1;
        return { kind: 'assert', assertion: endOfText };
      case '(':
        return this.group();
      case '.':
        this.position += 1;
        return {
          kind: 'atom',
          test: this.mode.dotAll ? anyCharacter : notLineTerminator,
          heavy: false,
        };
      case '[':
        return this.characterClass();
      case '\\':
        return this.escape();
      case '*':
      case '+':
      case '?':
        throw new PatternError(messages.nothingToRepeat, start, 1);
      case '{': {
        const length = this.quantifierLength();
        if (length > 0) {
          throw new PatternError(messages.nothingToRepeat, start, length);
        }
        if (this.mode.unicode) {
          throw new PatternError('Unexpected `{`.', start, 1);
        }
        this.position += 1;
        return this.literal(0x7b, start);
      }
      case '}':
      case ']':
        if (this.mode.unicode) {
          throw new PatternError(`Unexpected \`${char}\`.`, start, 1);
        }
        this.position += 1;
        return this.literal(char.charCodeAt(0), start);
      default:
        return this.literal(this.readCharacter(), start);
    }
  }

  private readCharacter(): number {
    const code = this.mode.unicode
      ? codePointAt(this.pattern, this.position)
      : this.pattern.charCodeAt(this.position);
    this.position += code > 0xffff ? 2 : 1;
    return code;
  }

  private literal(code: number, start: number): Node {
    if (this.mode.ignoreCase && (isAsciiLetter(code) || code > 0x7f)) {
      const source = this.mode.unicode
        ? `\\u{${code.toString(16)}}`
        : `\\u${code.toString(16).padStart(4, '0')}`;
      return this.engineAtom(source, start, this.position - start);
    }
    return { kind: 'atom', test: (candidate) => candidate === code, heavy: false };
  }

  private engineAtom(source: string, start: number, length: number): Node {
    const flags = (this.mode.ignoreCase ? 'i' : '') + (this.mode.unicode ? 'u' : '');
    let expression: RegExp;
    try {
      expression = new RegExp(`^(?:${source})$`, flags);
    } catch {
      throw new PatternError(messages.property, start, length);
    }
    return { kind: 'atom', test: engineTest(expression, this.pool), heavy: true };
  }

  private group(): Node {
    const start = this.position;
    this.position += 1;
    let index = 0;
    if (this.peek() === '?') {
      const kind = this.peek(1);
      if (kind === ':') {
        this.position += 2;
      } else if (kind === '=' || kind === '!') {
        throw new PatternError(messages.lookahead, start, 3);
      } else if (kind === '<') {
        const after = this.peek(2);
        if (after === '=' || after === '!') {
          throw new PatternError(messages.lookbehind, start, 4);
        }
        index = this.namedGroup(start);
      } else if (modifierCharacter.test(kind)) {
        throw new PatternError(messages.modifier, start, this.modifierLength(start));
      } else {
        throw new PatternError(messages.group, start, Math.min(3, this.pattern.length - start));
      }
    } else {
      this.groupCount += 1;
      index = this.groupCount;
    }
    const body = this.disjunction();
    if (this.peek() !== ')') {
      throw new PatternError(messages.unterminatedGroup, start, 1);
    }
    this.position += 1;
    return index > 0 ? { kind: 'group', index, body } : body;
  }

  private modifierLength(start: number): number {
    let end = start + 2;
    while (modifierCharacter.test(this.pattern.charAt(end))) {
      end += 1;
    }
    return (this.pattern.charAt(end) === ':' ? end + 1 : end) - start;
  }

  private namedGroup(start: number): number {
    const nameStart = start + 3;
    const close = this.pattern.indexOf('>', nameStart);
    if (close === -1) {
      throw new PatternError(messages.unterminatedName, start, 3);
    }
    const name = this.pattern.slice(nameStart, close);
    if (!groupName.test(name)) {
      throw name === ''
        ? new PatternError(messages.invalidName, start + 2, 2)
        : new PatternError(messages.invalidName, nameStart, name.length);
    }
    if (this.names.has(name)) {
      throw new PatternError(`Duplicate group name \`${name}\`.`, nameStart, name.length);
    }
    this.names.add(name);
    this.position = close + 1;
    this.groupCount += 1;
    return this.groupCount;
  }

  private escape(): Node {
    const start = this.position;
    const kind = this.peek(1);
    if (kind === 'b' || kind === 'B') {
      this.position += 2;
      return { kind: 'assert', assertion: kind === 'b' ? wordBoundary : notWordBoundary };
    }
    const escape = this.readEscape(false);
    if (escape.kind === 'char') {
      return this.literal(escape.code, start);
    }
    const length = this.position - start;
    if (escape.engine) {
      return this.engineAtom(this.pattern.slice(start, this.position), start, length);
    }
    return { kind: 'atom', test: rangeTest(escape.pairs, false), heavy: false };
  }

  private readEscape(inClass: boolean): Escape {
    const start = this.position;
    const kind = this.peek(1);
    this.position = start + 2;
    const folded = this.mode.ignoreCase && this.mode.unicode;
    switch (kind) {
      case '':
        throw new PatternError(messages.backslash, start, 1);
      case 'd':
        return { kind: 'set', pairs: digitPairs, engine: false };
      case 'D':
        return { kind: 'set', pairs: complementPairs(digitPairs), engine: false };
      case 's':
        return { kind: 'set', pairs: spacePairs, engine: false };
      case 'S':
        return { kind: 'set', pairs: complementPairs(spacePairs), engine: false };
      case 'w':
        return { kind: 'set', pairs: wordPairs, engine: folded };
      case 'W':
        return { kind: 'set', pairs: complementPairs(wordPairs), engine: folded };
      case 'b':
        return { kind: 'char', code: 0x08 };
      case 'B':
        if (this.mode.unicode) {
          throw new PatternError(messages.escape, start, 2);
        }
        return { kind: 'char', code: 0x42 };
      case 'n':
        return { kind: 'char', code: 0x0a };
      case 'r':
        return { kind: 'char', code: 0x0d };
      case 't':
        return { kind: 'char', code: 0x09 };
      case 'f':
        return { kind: 'char', code: 0x0c };
      case 'v':
        return { kind: 'char', code: 0x0b };
      case '0':
        if (/^\d$/.test(this.peek())) {
          throw new PatternError(messages.octal, start, 2);
        }
        return { kind: 'char', code: 0 };
      case 'k': {
        const close = this.pattern.indexOf('>', start + 2);
        throw new PatternError(
          messages.namedBackreference,
          start,
          close === -1 ? 2 : close + 1 - start,
        );
      }
      case 'x':
        return this.hexEscape(start);
      case 'u':
        return this.unicodeEscape(start);
      case 'c':
        return this.controlEscape(start);
      case 'p':
      case 'P':
        return this.mode.unicode
          ? this.propertyEscape(start)
          : { kind: 'char', code: kind.charCodeAt(0) };
      case '-':
        if (inClass || !this.mode.unicode) {
          return { kind: 'char', code: 0x2d };
        }
        throw new PatternError(messages.escape, start, 2);
      default:
        if (kind >= '1' && kind <= '9') {
          throw new PatternError(inClass ? messages.octal : messages.backreference, start, 2);
        }
        if (this.mode.unicode && !syntaxCharacters.includes(kind)) {
          throw new PatternError(messages.escape, start, 2);
        }
        return { kind: 'char', code: kind.charCodeAt(0) };
    }
  }

  private hexEscape(start: number): Escape {
    if (hexPair.test(this.pattern.slice(start + 2, start + 4))) {
      this.position = start + 4;
      return { kind: 'char', code: parseInt(this.pattern.slice(start + 2, start + 4), 16) };
    }
    if (this.mode.unicode) {
      throw new PatternError(messages.escape, start, 2);
    }
    return { kind: 'char', code: 0x78 };
  }

  private unicodeEscape(start: number): Escape {
    if (this.mode.unicode && this.pattern.charAt(start + 2) === '{') {
      const close = this.pattern.indexOf('}', start + 3);
      if (close === -1) {
        throw new PatternError(messages.escape, start, 2);
      }
      const digits = this.pattern.slice(start + 3, close);
      const code = hexDigits.test(digits) ? parseInt(digits, 16) : maxCodePoint + 1;
      if (code > maxCodePoint) {
        throw new PatternError(messages.escape, start, close + 1 - start);
      }
      this.position = close + 1;
      return { kind: 'char', code };
    }
    const digits = this.pattern.slice(start + 2, start + 6);
    if (!hexQuad.test(digits)) {
      if (this.mode.unicode) {
        throw new PatternError(messages.escape, start, 2);
      }
      return { kind: 'char', code: 0x75 };
    }
    const code = parseInt(digits, 16);
    this.position = start + 6;
    if (this.mode.unicode && isHighSurrogate(code) && this.pattern.startsWith('\\u', start + 6)) {
      const lowDigits = this.pattern.slice(start + 8, start + 12);
      const low = hexQuad.test(lowDigits) ? parseInt(lowDigits, 16) : 0;
      if (isLowSurrogate(low)) {
        this.position = start + 12;
        return { kind: 'char', code: (code - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000 };
      }
    }
    return { kind: 'char', code };
  }

  private controlEscape(start: number): Escape {
    const next = this.pattern.charAt(start + 2);
    if (!letter.test(next)) {
      throw new PatternError(messages.control, start, 2);
    }
    this.position = start + 3;
    return { kind: 'char', code: next.charCodeAt(0) % 32 };
  }

  private propertyEscape(start: number): Escape {
    const close =
      this.pattern.charAt(start + 2) === '{' ? this.pattern.indexOf('}', start + 3) : -1;
    if (close === -1) {
      throw new PatternError(messages.property, start, 2);
    }
    this.position = close + 1;
    return { kind: 'set', pairs: [], engine: true };
  }

  private characterClass(): Node {
    const start = this.position;
    this.position += 1;
    const negated = this.peek() === '^';
    if (negated) {
      this.position += 1;
    }
    const pairs: Pair[] = [];
    let engine = this.mode.ignoreCase;
    for (;;) {
      if (this.position >= this.pattern.length) {
        throw new PatternError(messages.unterminatedClass, start, 1);
      }
      if (this.peek() === ']') {
        this.position += 1;
        break;
      }
      const itemStart = this.position;
      const first = this.classAtom();
      if (this.peek() === '-' && this.peek(1) !== ']' && this.position + 1 < this.pattern.length) {
        this.position += 1;
        const second = this.classAtom();
        const length = this.position - itemStart;
        if (first.kind === 'char' && second.kind === 'char') {
          if (second.code < first.code) {
            throw new PatternError(messages.classOrder, itemStart, length);
          }
          pairs.push([first.code, second.code]);
          continue;
        }
        if (this.mode.unicode) {
          throw new PatternError(messages.classRange, itemStart, length);
        }
        engine = collect(pairs, first) || engine;
        pairs.push([0x2d, 0x2d]);
        engine = collect(pairs, second) || engine;
        continue;
      }
      engine = collect(pairs, first) || engine;
    }
    if (engine) {
      return this.engineAtom(
        this.pattern.slice(start, this.position),
        start,
        this.position - start,
      );
    }
    return { kind: 'atom', test: rangeTest(pairs, negated), heavy: false };
  }

  private classAtom(): Escape {
    if (this.peek() === '\\') {
      return this.readEscape(true);
    }
    return { kind: 'char', code: this.readCharacter() };
  }
}

function collect(pairs: Pair[], atom: Escape): boolean {
  if (atom.kind === 'char') {
    pairs.push([atom.code, atom.code]);
    return false;
  }
  pairs.push(...atom.pairs);
  return atom.engine;
}

class Emitter {
  private readonly ops: number[] = [];
  private readonly xs: number[] = [];
  private readonly ys: number[] = [];
  private readonly tests: (CharTest | undefined)[] = [];
  private weight = 0;
  private blame: { offset: number; length: number };

  constructor(patternLength: number) {
    this.blame = { offset: 0, length: patternLength };
  }

  build(root: Node, groups: number): Program {
    const prefix = this.push(opSplit);
    this.xs[prefix] = 1;
    this.push(opSave, 0);
    this.emit(root);
    this.push(opSave, 1);
    this.push(opMatch);
    this.ys[prefix] = this.push(opAny);
    this.push(opJump, 0);
    return {
      ops: Uint8Array.from(this.ops),
      xs: Int32Array.from(this.xs),
      ys: Int32Array.from(this.ys),
      tests: this.tests,
      size: this.ops.length,
      weight: this.weight,
      hasGroup: groups > 0,
    };
  }

  private push(op: number, x = 0, y = 0, test?: CharTest): number {
    if (this.ops.length >= maxInstructions) {
      throw new PatternError(messages.tooLarge, this.blame.offset, this.blame.length);
    }
    this.weight += op === opSave || op === opClear ? heavyWeight : 1;
    this.ops.push(op);
    this.xs.push(x);
    this.ys.push(y);
    this.tests.push(test);
    return this.ops.length - 1;
  }

  private emit(node: Node): void {
    switch (node.kind) {
      case 'empty':
        return;
      case 'atom':
        this.push(opChar, 0, 0, node.test);
        if (node.heavy) {
          this.weight += heavyWeight - 1;
        }
        return;
      case 'assert':
        this.push(opAssert, node.assertion);
        return;
      case 'concat':
        for (const item of node.items) {
          this.emit(item);
        }
        return;
      case 'group':
        if (node.index === 1) {
          this.push(opSave, 2);
          this.emit(node.body);
          this.push(opSave, 3);
        } else {
          this.emit(node.body);
        }
        return;
      case 'alt':
        this.emitAlternatives(node.items);
        return;
      case 'repeat':
        this.emitRepeat(node);
        return;
    }
  }

  private emitAlternatives(items: Node[]): void {
    const jumps: number[] = [];
    items.forEach((item, index) => {
      if (index === items.length - 1) {
        this.emit(item);
        return;
      }
      const split = this.push(opSplit);
      this.xs[split] = split + 1;
      this.emit(item);
      jumps.push(this.push(opJump));
      this.ys[split] = this.ops.length;
    });
    for (const jump of jumps) {
      this.xs[jump] = this.ops.length;
    }
  }

  private emitRepeat(node: RepeatNode): void {
    const outer = this.blame;
    this.blame = node;
    const { min, max, greedy } = node;
    if (max === Infinity && min > 0) {
      this.copies(node, min - 1);
      const loop = this.ops.length;
      this.iteration(node, true);
      const split = this.push(opSplit);
      this.xs[split] = greedy ? loop : this.ops.length;
      this.ys[split] = greedy ? this.ops.length : loop;
    } else {
      this.copies(node, min);
      if (max === Infinity) {
        const split = this.push(opSplit);
        this.iteration(node);
        this.push(opJump, split);
        this.branch(split, greedy);
      } else {
        const splits: number[] = [];
        for (let count = min; count < max; count += 1) {
          splits.push(this.push(opSplit));
          this.iteration(node);
        }
        for (const split of splits) {
          this.branch(split, greedy);
        }
      }
    }
    this.blame = outer;
  }

  private copies(node: RepeatNode, count: number): void {
    for (let index = 0; index < count; index += 1) {
      const before = this.ops.length;
      this.iteration(node);
      if (this.ops.length === before) {
        return;
      }
    }
  }

  private iteration(node: RepeatNode, loopTarget = false): void {
    const clears = node.firstGroup <= 1 && node.lastGroup >= 1;
    if (clears && (loopTarget || this.ops.at(-1) !== opClear)) {
      this.push(opClear, 2, 3);
    }
    this.emit(node.body);
  }

  private branch(split: number, greedy: boolean): void {
    const next = split + 1;
    const exit = this.ops.length;
    this.xs[split] = greedy ? next : exit;
    this.ys[split] = greedy ? exit : next;
  }
}

class SparseSet {
  private readonly dense: Int32Array;
  private readonly sparse: Int32Array;
  private size = 0;

  constructor(capacity: number) {
    this.dense = new Int32Array(capacity);
    this.sparse = new Int32Array(capacity);
  }

  has(value: number): boolean {
    const index = at(this.sparse, value);
    return index < this.size && at(this.dense, index) === value;
  }

  add(value: number): void {
    this.dense[this.size] = value;
    this.sparse[value] = this.size;
    this.size += 1;
  }

  clear(): void {
    this.size = 0;
  }
}

class ThreadList {
  readonly pcs: Int32Array;
  readonly caps: (Int32Array | null)[];
  readonly visited: SparseSet;
  size = 0;

  constructor(capacity: number) {
    this.pcs = new Int32Array(capacity);
    this.caps = new Array<Int32Array | null>(capacity).fill(null);
    this.visited = new SparseSet(capacity);
  }

  push(pc: number, caps: Int32Array | null): void {
    this.pcs[this.size] = pc;
    this.caps[this.size] = caps;
    this.size += 1;
  }

  clear(): void {
    this.size = 0;
    this.visited.clear();
  }
}

const matchedWithoutCaptures = new Int32Array(0);

class Machine {
  private readonly lists: [ThreadList, ThreadList];
  private readonly stackPcs: Int32Array;
  private readonly stackCaps: (Int32Array | null)[];
  private readonly slots: number;

  constructor(
    private readonly program: Program,
    private readonly mode: Mode,
  ) {
    this.lists = [new ThreadList(program.size), new ThreadList(program.size)];
    this.stackPcs = new Int32Array(program.size + 1);
    this.stackCaps = new Array<Int32Array | null>(program.size + 1).fill(null);
    this.slots = program.hasGroup ? 4 : 2;
  }

  search(subject: string, captures: boolean): Int32Array | undefined {
    const { ops, tests } = this.program;
    const unicode = this.mode.unicode;
    let [current, next] = this.lists;
    current.clear();
    this.add(current, 0, captures ? new Int32Array(this.slots).fill(-1) : null, 0, subject);
    let found: Int32Array | undefined;
    let position = 0;
    while (current.size > 0) {
      let code = -1;
      let width = 0;
      if (position < subject.length) {
        code = unicode ? codePointAt(subject, position) : subject.charCodeAt(position);
        width = code > 0xffff ? 2 : 1;
      }
      next.clear();
      for (let index = 0; index < current.size; index += 1) {
        const pc = at(current.pcs, index);
        const op = at(ops, pc);
        if (op === opMatch) {
          found = at(current.caps, index) ?? matchedWithoutCaptures;
          if (!captures) {
            return found;
          }
          break;
        }
        if (code < 0) {
          continue;
        }
        const test = at(tests, pc);
        if (op === opAny || (test !== undefined && test(code))) {
          this.add(next, pc + 1, at(current.caps, index), position + width, subject);
        }
      }
      if (code < 0) {
        break;
      }
      [current, next] = [next, current];
      position += width;
    }
    return found;
  }

  private add(
    list: ThreadList,
    startPc: number,
    startCaps: Int32Array | null,
    position: number,
    subject: string,
  ): void {
    const { ops, xs, ys } = this.program;
    const stackPcs = this.stackPcs;
    const stackCaps = this.stackCaps;
    const visited = list.visited;
    stackPcs[0] = startPc;
    stackCaps[0] = startCaps;
    let top = 1;
    while (top > 0) {
      top -= 1;
      let pc = at(stackPcs, top);
      let caps = at(stackCaps, top);
      walk: for (;;) {
        if (visited.has(pc)) {
          break;
        }
        visited.add(pc);
        switch (at(ops, pc)) {
          case opJump:
            pc = at(xs, pc);
            continue walk;
          case opSplit:
            stackPcs[top] = at(ys, pc);
            stackCaps[top] = caps;
            top += 1;
            pc = at(xs, pc);
            continue walk;
          case opSave:
            if (caps !== null) {
              caps = caps.slice();
              caps[at(xs, pc)] = position;
            }
            pc += 1;
            continue walk;
          case opClear:
            if (caps !== null) {
              caps = caps.slice();
              caps.fill(-1, at(xs, pc), at(ys, pc) + 1);
            }
            pc += 1;
            continue walk;
          case opAssert:
            if (!this.holds(at(xs, pc), subject, position)) {
              break walk;
            }
            pc += 1;
            continue walk;
          default:
            list.push(pc, caps);
            break walk;
        }
      }
    }
  }

  private holds(assertion: number, subject: string, position: number): boolean {
    if (assertion === startOfText) {
      return (
        position === 0 ||
        (this.mode.multiline && isLineTerminator(subject.charCodeAt(position - 1)))
      );
    }
    if (assertion === endOfText) {
      return (
        position === subject.length ||
        (this.mode.multiline && isLineTerminator(subject.charCodeAt(position)))
      );
    }
    const before = position > 0 && this.isWord(subject.charCodeAt(position - 1));
    const after = position < subject.length && this.isWord(subject.charCodeAt(position));
    return (before !== after) === (assertion === wordBoundary);
  }

  private isWord(code: number): boolean {
    return (
      (code >= 0x30 && code <= 0x39) ||
      isAsciiLetter(code) ||
      code === 0x5f ||
      (this.mode.ignoreCase && this.mode.unicode && (code === 0x17f || code === 0x212a))
    );
  }
}

class Matcher implements CompiledPattern {
  private readonly machine: Machine;

  constructor(
    private readonly program: Program,
    mode: Mode,
  ) {
    this.machine = new Machine(program, mode);
  }

  work(subject: string): number {
    const work = subject.length * this.program.weight;
    return work > maxWork ? 0 : work;
  }

  test(subject: string): boolean | 'too-long' {
    if (subject.length * this.program.weight > maxWork) {
      return 'too-long';
    }
    return this.machine.search(subject, false) !== undefined;
  }

  firstMatch(subject: string): RegexMatch | undefined | 'too-long' {
    if (subject.length * this.program.weight > maxWork) {
      return 'too-long';
    }
    const caps = this.machine.search(subject, true);
    if (caps === undefined) {
      return undefined;
    }
    const start = this.program.hasGroup ? at(caps, 2) : -1;
    const end = this.program.hasGroup ? at(caps, 3) : -1;
    return {
      match: subject.slice(at(caps, 0), at(caps, 1)),
      group: start >= 0 && end >= 0 ? subject.slice(start, end) : undefined,
    };
  }
}
