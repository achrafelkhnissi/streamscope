export type PathSegment = string | number;

export type PositionProblem = 'not-json' | 'no-value' | 'too-deep';

export type PositionResult =
  { ok: true; segments: PathSegment[] } | { ok: false; problem: PositionProblem };

interface KeyRange {
  start: number;
  end: number;
}

type Segment = number | KeyRange;

type FrameState = 'key-or-close' | 'key' | 'colon' | 'value' | 'value-or-close' | 'comma-or-close';

interface Frame {
  kind: 'object' | 'array';
  segment: Segment | undefined;
  state: FrameState;
  key: KeyRange | undefined;
  index: number;
}

type TokenKind =
  '{' | '}' | '[' | ']' | ':' | ',' | 'string' | 'number' | 'literal' | 'invalid' | 'cut';

interface Token {
  kind: TokenKind;
  start: number;
  end: number;
}

interface Selection {
  frames: number;
  extra: Segment | undefined;
}

const maxDepth = 256;
const numberPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const numberPrefix = /^-?(?:0|[1-9]\d*)?(?:\.\d*)?(?:[eE][+-]?\d*)?$/;
const literals = ['true', 'false', 'null'];
const punctuation = new Set(['{', '}', '[', ']', ':', ',']);

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t';
}

function isNumberChar(char: string): boolean {
  return (
    (char >= '0' && char <= '9') ||
    char === '-' ||
    char === '+' ||
    char === '.' ||
    char === 'e' ||
    char === 'E'
  );
}

function isLetter(char: string): boolean {
  return char >= 'a' && char <= 'z';
}

function hasNewline(text: string, start: number, end: number): boolean {
  const found = text.indexOf('\n', start);
  return found !== -1 && found < end;
}

function isValue(kind: TokenKind): boolean {
  return (
    kind === 'string' || kind === 'number' || kind === 'literal' || kind === '{' || kind === '['
  );
}

export class JsonPositionScanner {
  private position = 0;
  private readonly frames: Frame[] = [];
  private rootDone = false;
  private last: Selection | undefined;
  private result: PositionResult | undefined;

  constructor(
    private readonly text: string,
    private readonly offset: number,
  ) {
    if (!Number.isInteger(offset) || offset < 0 || offset > text.length) {
      this.result = { ok: false, problem: 'no-value' };
    }
  }

  step(maxChars: number): PositionResult | undefined {
    const stop = this.position + Math.max(1, maxChars);
    while (this.result === undefined && this.position < stop) {
      this.advance();
    }
    return this.result;
  }

  private advance(): void {
    const { text, offset } = this;
    const gap = this.position;
    let position = gap;
    while (position < text.length && isWhitespace(text.charAt(position))) {
      position += 1;
    }
    this.position = position;
    let selectNext = false;
    if (offset >= gap && (offset < position || position === text.length)) {
      if (position < text.length && !hasNewline(text, offset, position)) {
        selectNext = true;
      } else if (this.last !== undefined && !hasNewline(text, gap, offset)) {
        this.finish(this.last);
        return;
      } else {
        this.result = { ok: false, problem: 'no-value' };
        return;
      }
    }
    if (position >= text.length) {
      this.result = { ok: false, problem: 'no-value' };
      return;
    }
    const token = this.read(position);
    if (token.kind === 'cut') {
      this.result = { ok: false, problem: 'no-value' };
      return;
    }
    if (token.kind === 'invalid') {
      this.result = { ok: false, problem: 'not-json' };
      return;
    }
    const selection = this.selectionFor(token);
    if (selection === undefined) {
      this.result = { ok: false, problem: 'not-json' };
      return;
    }
    if (selectNext || (offset >= token.start && offset < token.end)) {
      this.finish(selection);
      return;
    }
    this.last = selection;
    if (!this.apply(token)) {
      return;
    }
    this.position = token.end;
  }

  private read(start: number): Token {
    const { text } = this;
    const char = text.charAt(start);
    if (punctuation.has(char)) {
      return { kind: char as TokenKind, start, end: start + 1 };
    }
    if (char === '"') {
      let index = start + 1;
      while (index < text.length) {
        const current = text.charAt(index);
        if (current === '\\') {
          index += 2;
        } else if (current === '"') {
          return { kind: 'string', start, end: index + 1 };
        } else {
          index += 1;
        }
      }
      return { kind: 'cut', start, end: text.length };
    }
    if (isNumberChar(char)) {
      let end = start;
      while (end < text.length && isNumberChar(text.charAt(end))) {
        end += 1;
      }
      const written = text.slice(start, end);
      if (numberPattern.test(written)) {
        return { kind: 'number', start, end };
      }
      return end === text.length && numberPrefix.test(written)
        ? { kind: 'cut', start, end }
        : { kind: 'invalid', start, end };
    }
    if (isLetter(char)) {
      let end = start;
      while (end < text.length && isLetter(text.charAt(end))) {
        end += 1;
      }
      const written = text.slice(start, end);
      if (literals.includes(written)) {
        return { kind: 'literal', start, end };
      }
      return end === text.length && literals.some((literal) => literal.startsWith(written))
        ? { kind: 'cut', start, end }
        : { kind: 'invalid', start, end };
    }
    return { kind: 'invalid', start, end: start + 1 };
  }

  private selectionFor(token: Token): Selection | undefined {
    const top = this.frames.at(-1);
    const depth = this.frames.length;
    if (top === undefined) {
      return !this.rootDone && isValue(token.kind) ? { frames: 0, extra: undefined } : undefined;
    }
    const close = top.kind === 'object' ? '}' : ']';
    const closing: Selection = { frames: depth - 1, extra: top.segment };
    switch (top.state) {
      case 'key-or-close':
      case 'key':
        if (token.kind === 'string') {
          return { frames: depth, extra: { start: token.start, end: token.end } };
        }
        return top.state === 'key-or-close' && token.kind === close ? closing : undefined;
      case 'colon':
        return token.kind === ':' ? { frames: depth, extra: top.key } : undefined;
      case 'value':
      case 'value-or-close':
        if (isValue(token.kind)) {
          return { frames: depth, extra: this.current(top) };
        }
        return top.state === 'value-or-close' && token.kind === close ? closing : undefined;
      case 'comma-or-close':
        if (token.kind === ',') {
          return { frames: depth, extra: this.current(top) };
        }
        return token.kind === close ? closing : undefined;
    }
  }

  private current(frame: Frame): Segment | undefined {
    return frame.kind === 'object' ? frame.key : frame.index;
  }

  private apply(token: Token): boolean {
    const top = this.frames.at(-1);
    if (token.kind === '{' || token.kind === '[') {
      if (this.frames.length >= maxDepth) {
        this.result = { ok: false, problem: 'too-deep' };
        return false;
      }
      if (top === undefined) {
        this.rootDone = true;
      } else {
        top.state = 'comma-or-close';
      }
      this.frames.push({
        kind: token.kind === '{' ? 'object' : 'array',
        segment: top === undefined ? undefined : this.current(top),
        state: token.kind === '{' ? 'key-or-close' : 'value-or-close',
        key: undefined,
        index: 0,
      });
      return true;
    }
    if (top === undefined) {
      this.rootDone = true;
      return true;
    }
    if (token.kind === '}' || token.kind === ']') {
      this.frames.pop();
    } else if (token.kind === ':') {
      top.state = 'value';
    } else if (token.kind === ',') {
      if (top.kind === 'object') {
        top.state = 'key';
      } else {
        top.index += 1;
        top.state = 'value';
      }
    } else if (top.state === 'key' || top.state === 'key-or-close') {
      top.key = { start: token.start, end: token.end };
      top.state = 'colon';
    } else {
      top.state = 'comma-or-close';
    }
    return true;
  }

  private finish(selection: Selection): void {
    const segments: PathSegment[] = [];
    const parts = this.frames
      .slice(1, selection.frames)
      .map((frame) => frame.segment)
      .concat(selection.extra === undefined ? [] : [selection.extra]);
    for (const part of parts) {
      if (typeof part === 'number') {
        segments.push(part);
      } else if (part !== undefined) {
        const key = this.decode(part);
        if (key === undefined) {
          this.result = { ok: false, problem: 'not-json' };
          return;
        }
        segments.push(key);
      }
    }
    this.result = { ok: true, segments };
  }

  private decode(range: KeyRange): string | undefined {
    try {
      const key: unknown = JSON.parse(this.text.slice(range.start, range.end));
      return typeof key === 'string' ? key : undefined;
    } catch {
      return undefined;
    }
  }
}

export function jsonPathAt(text: string, offset: number): PositionResult {
  const scanner = new JsonPositionScanner(text, offset);
  for (;;) {
    const result = scanner.step(Number.MAX_SAFE_INTEGER);
    if (result !== undefined) {
      return result;
    }
  }
}
