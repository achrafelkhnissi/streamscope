const maxPatternLength = 500;
const allowedFlags = 'imsu';
const braceQuantifier = /\{(\d+)(?:(,)(\d*))?\}/y;

const tooLong = `A regular expression is at most ${String(maxPatternLength)} characters.`;
const backreference =
  'This regular expression uses a backreference, which can take very long on some inputs. Rewrite it without one.';
const lookaround =
  'This regular expression uses lookahead or lookbehind, which can take very long on some inputs. Rewrite it without lookaround.';
const nestedRepetition =
  'This regular expression can take very long on some inputs, because a repeated group contains another repetition. Rewrite it without nested repetition.';
const repeatedAlternatives =
  'This regular expression can take very long on some inputs, because a repeated group contains alternatives. Rewrite it without alternatives inside a repeated group.';

interface Group {
  variable: boolean;
  alternation: boolean;
}

interface Quantifier {
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
  return checkFlags(flags)?.message ?? checkSource(pattern);
}

function checkSource(pattern: string): string | undefined {
  if (pattern.length > maxPatternLength) {
    return tooLong;
  }
  const parents: Group[] = [];
  let current: Group = { variable: false, alternation: false };
  let index = 0;
  while (index < pattern.length) {
    switch (pattern.charAt(index)) {
      case '\\':
        if (isBackreference(pattern, index)) {
          return backreference;
        }
        index = skipEscape(pattern, index);
        break;
      case '[':
        index = endOfClass(pattern, index);
        break;
      case '(':
        if (pattern.charAt(index + 1) === '?') {
          if (isLookaround(pattern, index)) {
            return lookaround;
          }
          index += 2;
        } else {
          index += 1;
        }
        parents.push(current);
        current = { variable: false, alternation: false };
        break;
      case ')': {
        index += 1;
        const parent = parents.pop();
        if (parent === undefined) {
          break;
        }
        const quantifier = readQuantifier(pattern, index);
        if (quantifier !== undefined) {
          if (quantifier.max > 1 && current.variable) {
            return nestedRepetition;
          }
          if (quantifier.max > 1 && current.alternation) {
            return repeatedAlternatives;
          }
          index = quantifier.end;
        }
        parent.variable ||= current.variable || (quantifier?.variable ?? false);
        parent.alternation ||= current.alternation;
        current = parent;
        break;
      }
      case '|':
        current.alternation = true;
        index += 1;
        break;
      default: {
        const quantifier = readQuantifier(pattern, index);
        if (quantifier === undefined) {
          index += 1;
        } else {
          current.variable ||= quantifier.variable;
          index = quantifier.end;
        }
      }
    }
  }
  return undefined;
}

function isBackreference(pattern: string, index: number): boolean {
  const next = pattern.charAt(index + 1);
  return (next >= '1' && next <= '9') || (next === 'k' && pattern.charAt(index + 2) === '<');
}

function isLookaround(pattern: string, index: number): boolean {
  const kind = pattern.charAt(index + 2);
  if (kind === '=' || kind === '!') {
    return true;
  }
  const after = pattern.charAt(index + 3);
  return kind === '<' && (after === '=' || after === '!');
}

function skipEscape(pattern: string, index: number): number {
  const kind = pattern.charAt(index + 1);
  if ((kind === 'u' || kind === 'p' || kind === 'P') && pattern.charAt(index + 2) === '{') {
    const close = pattern.indexOf('}', index + 3);
    return close === -1 ? pattern.length : close + 1;
  }
  return index + 2;
}

function endOfClass(pattern: string, start: number): number {
  let index = start + 1;
  while (index < pattern.length) {
    const char = pattern.charAt(index);
    if (char === '\\') {
      index += 2;
    } else if (char === ']') {
      return index + 1;
    } else {
      index += 1;
    }
  }
  return pattern.length;
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
  return { max, variable: min !== max, end };
}
