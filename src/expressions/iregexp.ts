const singleEscapes = '()*+-.?[\\]^nrt{|}';
const rangeQuantifier = /\{\d+(?:,\d*)?\}/y;
const categories = new Set([
  'L',
  'Ll',
  'Lm',
  'Lo',
  'Lt',
  'Lu',
  'M',
  'Mc',
  'Me',
  'Mn',
  'N',
  'Nd',
  'Nl',
  'No',
  'P',
  'Pc',
  'Pd',
  'Pe',
  'Pf',
  'Pi',
  'Po',
  'Ps',
  'S',
  'Sc',
  'Sk',
  'Sm',
  'So',
  'Z',
  'Zl',
  'Zp',
  'Zs',
  'C',
  'Cc',
  'Cf',
  'Cn',
  'Co',
]);

const messages = {
  group: 'Group syntax such as `(?:…)` and `(?<name>…)` is not part of I-Regexp (RFC 9485).',
  lazy: 'Lazy quantifiers such as `*?` are not part of I-Regexp (RFC 9485).',
  nothingToRepeat: 'Nothing to repeat.',
  quantifier:
    'A `{` must start a quantifier such as `{2}`, `{2,}` or `{2,3}` in I-Regexp (RFC 9485).',
  property: 'This Unicode property escape is not valid in I-Regexp (RFC 9485).',
  backslash: 'A backslash at the end of the regular expression has nothing to escape.',
  unmatched: 'Unmatched `)`.',
  unterminatedGroup: 'Unterminated group.',
  unterminatedClass: 'Unterminated character class.',
  characterClass: 'This character class is not valid in I-Regexp (RFC 9485).',
  surrogate: 'A lone surrogate is not valid in I-Regexp.',
};

class IRegexpError extends Error {}

function fail(message: string): never {
  throw new IRegexpError(message);
}

function codePointAt(pattern: string, index: number): number {
  const code = pattern.codePointAt(index) ?? 0;
  if (code >= 0xd800 && code <= 0xdfff) {
    fail(messages.surrogate);
  }
  return code;
}

function widthOf(code: number): number {
  return code > 0xffff ? 2 : 1;
}

function propertyEnd(pattern: string, index: number): number {
  const close = pattern.indexOf('}', index);
  if (
    pattern.charAt(index) !== '{' ||
    close < 0 ||
    !categories.has(pattern.slice(index + 1, close))
  ) {
    fail(messages.property);
  }
  return close + 1;
}

function escapeEnd(pattern: string, index: number): { end: number; property: boolean } {
  const next = pattern.charAt(index + 1);
  if (next === '') {
    fail(messages.backslash);
  }
  if (next === 'p' || next === 'P') {
    return { end: propertyEnd(pattern, index + 2), property: true };
  }
  if (singleEscapes.includes(next)) {
    return { end: index + 2, property: false };
  }
  const code = pattern.codePointAt(index + 1) ?? 0;
  return fail(`The escape \`\\${String.fromCodePoint(code)}\` is not part of I-Regexp (RFC 9485).`);
}

function isClassCharacter(code: number): boolean {
  return code <= 0x2c || (code >= 0x2e && code <= 0x5a) || code >= 0x5e;
}

function classCharacterEnd(pattern: string, index: number): number {
  if (pattern.charAt(index) === '\\') {
    const escape = escapeEnd(pattern, index);
    if (escape.property) {
      fail(messages.characterClass);
    }
    return escape.end;
  }
  const code = codePointAt(pattern, index);
  if (!isClassCharacter(code)) {
    fail(messages.characterClass);
  }
  return index + widthOf(code);
}

function classElementEnd(pattern: string, index: number): number {
  if (pattern.charAt(index) === '\\') {
    const escape = escapeEnd(pattern, index);
    if (escape.property) {
      return escape.end;
    }
  }
  const end = classCharacterEnd(pattern, index);
  const following = pattern.charAt(end + 1);
  if (pattern.charAt(end) === '-' && following !== ']' && following !== '') {
    return classCharacterEnd(pattern, end + 1);
  }
  return end;
}

function classEnd(pattern: string, start: number): number {
  let index = start + 1;
  if (pattern.charAt(index) === '^') {
    index += 1;
  }
  index = pattern.charAt(index) === '-' ? index + 1 : classElementEnd(pattern, index);
  for (;;) {
    const char = pattern.charAt(index);
    if (char === ']') {
      return index + 1;
    }
    if (char === '') {
      fail(messages.unterminatedClass);
    }
    index =
      char === '-' && pattern.charAt(index + 1) === ']'
        ? index + 1
        : classElementEnd(pattern, index);
  }
}

function check(pattern: string): void {
  let depth = 0;
  let repeatable = false;
  let quantified = false;
  let index = 0;
  while (index < pattern.length) {
    const char = pattern.charAt(index);
    let atom = true;
    if (char === '\\') {
      index = escapeEnd(pattern, index).end;
    } else if (char === '[') {
      index = classEnd(pattern, index);
    } else if (char === '(') {
      if (pattern.charAt(index + 1) === '?') {
        fail(messages.group);
      }
      depth += 1;
      index += 1;
      atom = false;
    } else if (char === ')') {
      if (depth === 0) {
        fail(messages.unmatched);
      }
      depth -= 1;
      index += 1;
    } else if (char === '|') {
      index += 1;
      atom = false;
    } else if (char === '*' || char === '+' || char === '?') {
      if (!repeatable) {
        fail(quantified && char === '?' ? messages.lazy : messages.nothingToRepeat);
      }
      index += 1;
      atom = false;
      quantified = true;
    } else if (char === '{') {
      rangeQuantifier.lastIndex = index;
      const found = rangeQuantifier.exec(pattern);
      if (found === null) {
        fail(messages.quantifier);
      }
      if (!repeatable) {
        fail(messages.nothingToRepeat);
      }
      index += found[0].length;
      atom = false;
      quantified = true;
    } else if (char === '}' || char === ']') {
      fail(`The character \`${char}\` must be escaped in I-Regexp (RFC 9485).`);
    } else {
      index += widthOf(codePointAt(pattern, index));
    }
    repeatable = atom;
    if (atom || char === '|' || char === '(') {
      quantified = false;
    }
  }
  if (depth > 0) {
    fail(messages.unterminatedGroup);
  }
}

export function iRegexpProblem(pattern: string): string | undefined {
  try {
    check(pattern);
    return undefined;
  } catch (error) {
    if (error instanceof IRegexpError) {
      return error.message;
    }
    throw error;
  }
}
