import { modeOf, readAtom, type Mode } from './atoms';
import { fullSet, intersection, intersects, union, type CharSet } from './charset';

const maxPatternLength = 500;
const allowedFlags = 'imsu';
const braceQuantifier = /\{(\d+)(?:(,)(\d*))?\}/y;
const groupModifiers = /[a-zA-Z-]/;

const tooLong = `A regular expression is at most ${String(maxPatternLength)} characters.`;
const backreference =
  'This regular expression uses a backreference, which can take very long on some inputs. Rewrite it without one.';
const lookaround =
  'This regular expression uses lookahead or lookbehind, which can take very long on some inputs. Rewrite it without lookaround.';
const nestedRepetition =
  'This regular expression can take very long on some inputs, because a repeated group contains another repetition. Rewrite it without nested repetition.';
const repeatedAlternatives =
  'This regular expression can take very long on some inputs, because a repeated group contains alternatives. Rewrite it without alternatives inside a repeated group.';
const adjacentRepetitions =
  'This regular expression can take very long on some inputs, because two repetitions next to each other can match the same text. Separate them with a character only one of them matches.';

type Pending = Map<number, CharSet>;

interface Group {
  variable: boolean;
  alternation: boolean;
  start: Pending;
  ends: Pending;
  pending: Pending;
}

interface Quantifier {
  min: number;
  max: number;
  variable: boolean;
  end: number;
}

export interface FlagProblem {
  index: number;
  message: string;
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

export function checkPattern(pattern: string, flags: string): string | undefined {
  const flagProblem = checkFlags(flags);
  if (flagProblem !== undefined) {
    return flagProblem.message;
  }
  if (pattern.length > maxPatternLength) {
    return tooLong;
  }
  return new Scan(pattern, modeOf(flags)).run();
}

function newGroup(outer: Pending): Group {
  return {
    variable: false,
    alternation: false,
    start: new Map(outer),
    ends: new Map(),
    pending: new Map(outer),
  };
}

function mergeInto(target: Pending, source: Pending): void {
  for (const [id, set] of source) {
    const existing = target.get(id);
    target.set(id, existing === undefined ? set : union(existing, set));
  }
}

function overlapsAny(pending: Pending, set: CharSet): boolean {
  for (const common of pending.values()) {
    if (intersects(common, set)) {
      return true;
    }
  }
  return false;
}

function narrow(pending: Pending, set: CharSet): void {
  for (const [id, common] of pending) {
    const narrowed = intersection(common, set);
    if (narrowed.length === 0) {
      pending.delete(id);
    } else {
      pending.set(id, narrowed);
    }
  }
}

class Scan {
  private readonly parents: Group[] = [];
  private current = newGroup(new Map());
  private index = 0;
  private repetitions = 0;

  constructor(
    private readonly pattern: string,
    private readonly mode: Mode,
  ) {}

  run(): string | undefined {
    while (this.index < this.pattern.length) {
      const problem = this.step();
      if (problem !== undefined) {
        return problem;
      }
    }
    return undefined;
  }

  private step(): string | undefined {
    switch (this.pattern.charAt(this.index)) {
      case '(':
        return this.open();
      case ')':
        return this.close();
      case '|':
        this.alternate();
        return undefined;
      case '^':
      case '$':
        this.index += 1;
        return undefined;
      default:
        return this.atom();
    }
  }

  private open(): string | undefined {
    if (isLookaround(this.pattern, this.index)) {
      return lookaround;
    }
    this.parents.push(this.current);
    this.current = newGroup(this.current.pending);
    this.index = groupBodyStart(this.pattern, this.index);
    return undefined;
  }

  private alternate(): void {
    this.current.alternation = true;
    mergeInto(this.current.ends, this.current.pending);
    this.current.pending = new Map(this.current.start);
    this.index += 1;
  }

  private close(): string | undefined {
    this.index += 1;
    const parent = this.parents.pop();
    if (parent === undefined) {
      return undefined;
    }
    const closed = this.current;
    mergeInto(closed.ends, closed.pending);
    const quantifier = readQuantifier(this.pattern, this.index);
    const min = quantifier?.min ?? 1;
    const max = quantifier?.max ?? 1;
    if (quantifier !== undefined) {
      if (max > 1 && closed.variable) {
        return nestedRepetition;
      }
      if (max > 1 && closed.alternation) {
        return repeatedAlternatives;
      }
      this.index = quantifier.end;
    }
    parent.variable ||= closed.variable || (quantifier?.variable ?? false);
    parent.alternation ||= closed.alternation;
    this.current = parent;
    if (max > 1) {
      return max === Infinity ? this.addRepetition(fullSet, min) : undefined;
    }
    if (max === 1) {
      if (min === 0) {
        mergeInto(closed.ends, parent.pending);
      }
      parent.pending = closed.ends;
    }
    return undefined;
  }

  private atom(): string | undefined {
    const start = this.index;
    if (isBackreference(this.pattern, start)) {
      return backreference;
    }
    const atom = readAtom(this.pattern, start, this.mode);
    if (atom.set === undefined) {
      this.index = atom.end;
      return undefined;
    }
    const quantifier = readQuantifier(this.pattern, atom.end);
    this.index = quantifier?.end ?? atom.end;
    if (quantifier?.variable) {
      this.current.variable = true;
    }
    const min = quantifier?.min ?? 1;
    const max = quantifier?.max ?? 1;
    if (max === Infinity) {
      return this.addRepetition(atom.set, min);
    }
    if (min > 0) {
      narrow(this.current.pending, atom.set);
    }
    return undefined;
  }

  private addRepetition(set: CharSet, min: number): string | undefined {
    const pending = this.current.pending;
    if (overlapsAny(pending, set)) {
      return adjacentRepetitions;
    }
    if (min > 0) {
      narrow(pending, set);
    }
    this.repetitions += 1;
    pending.set(this.repetitions, set);
    return undefined;
  }
}

function isBackreference(pattern: string, index: number): boolean {
  if (pattern.charAt(index) !== '\\') {
    return false;
  }
  const next = pattern.charAt(index + 1);
  return (next >= '1' && next <= '9') || (next === 'k' && pattern.charAt(index + 2) === '<');
}

function isLookaround(pattern: string, index: number): boolean {
  if (pattern.charAt(index + 1) !== '?') {
    return false;
  }
  const kind = pattern.charAt(index + 2);
  if (kind === '=' || kind === '!') {
    return true;
  }
  const after = pattern.charAt(index + 3);
  return kind === '<' && (after === '=' || after === '!');
}

function groupBodyStart(pattern: string, index: number): number {
  if (pattern.charAt(index + 1) !== '?') {
    return index + 1;
  }
  if (pattern.charAt(index + 2) === '<') {
    const close = pattern.indexOf('>', index + 3);
    return close === -1 ? pattern.length : close + 1;
  }
  let position = index + 2;
  while (groupModifiers.test(pattern.charAt(position))) {
    position += 1;
  }
  return pattern.charAt(position) === ':' ? position + 1 : position;
}

function readQuantifier(pattern: string, index: number): Quantifier | undefined {
  let min: number;
  let max: number;
  let end: number;
  switch (pattern.charAt(index)) {
    case '*':
      min = 0;
      max = Infinity;
      end = index + 1;
      break;
    case '+':
      min = 1;
      max = Infinity;
      end = index + 1;
      break;
    case '?':
      min = 0;
      max = 1;
      end = index + 1;
      break;
    case '{': {
      braceQuantifier.lastIndex = index;
      const match = braceQuantifier.exec(pattern);
      if (match === null) {
        return undefined;
      }
      const [, minText, comma, maxText] = match;
      min = Number(minText);
      max = comma === undefined ? min : maxText === '' ? Infinity : Number(maxText);
      end = braceQuantifier.lastIndex;
      break;
    }
    default:
      return undefined;
  }
  if (pattern.charAt(end) === '?') {
    end += 1;
  }
  return { min, max, variable: min !== max, end };
}
