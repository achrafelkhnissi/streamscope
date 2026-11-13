import type { Span } from './ast';
import { checkFlags } from './regex';

const keywords = ['true', 'false', 'null', 'in', 'contains', 'startsWith', 'matches'] as const;
const punctuations = [
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '<',
  '>',
  '!',
  '|',
  '.',
  ',',
  '(',
  ')',
  '[',
  ']',
  '*',
  '?',
] as const;

export type Keyword = (typeof keywords)[number];
export type Punctuation = (typeof punctuations)[number];

export interface IdentifierToken {
  kind: 'identifier';
  text: string;
  span: Span;
}

export interface KeywordToken {
  kind: 'keyword';
  text: Keyword;
  span: Span;
}

export interface StringToken {
  kind: 'string';
  value: string;
  span: Span;
}

export interface NumberToken {
  kind: 'number';
  value: number | bigint;
  span: Span;
}

export interface RegexToken {
  kind: 'regex';
  pattern: string;
  flags: string;
  span: Span;
}

export interface AtToken {
  kind: 'at';
  name: string;
  span: Span;
}

export interface PunctuationToken {
  kind: 'punctuation';
  text: Punctuation;
  span: Span;
}

export interface EndToken {
  kind: 'end';
  span: Span;
}

export interface ErrorToken {
  kind: 'error';
  message: string;
  span: Span;
}

export type Token =
  | IdentifierToken
  | KeywordToken
  | StringToken
  | NumberToken
  | RegexToken
  | AtToken
  | PunctuationToken
  | EndToken
  | ErrorToken;

const keywordSet: ReadonlySet<string> = new Set(keywords);
const punctuationSet: ReadonlySet<string> = new Set(punctuations);
const identifierStart = /[A-Za-z_$]/;
const identifierPattern = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const integerSource = /^-?\d+$/;
const flagsPattern = /[A-Za-z]*/y;
const hexDigits = /^[0-9a-fA-F]{0,4}/;
const simpleEscapes: ReadonlyMap<string, string> = new Map([
  ['"', '"'],
  ["'", "'"],
  ['\\', '\\'],
  ['/', '/'],
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
]);

type Escape = { ok: true; value: string; end: number } | { ok: false; end: number };

function isKeyword(word: string): word is Keyword {
  return keywordSet.has(word);
}

function isPunctuation(text: string): text is Punctuation {
  return punctuationSet.has(text);
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function readEscape(text: string, index: number): Escape | undefined {
  if (index + 1 >= text.length) {
    return undefined;
  }
  const kind = text.charAt(index + 1);
  const simple = simpleEscapes.get(kind);
  if (simple !== undefined) {
    return { ok: true, value: simple, end: index + 2 };
  }
  if (kind === 'u') {
    const digits = hexDigits.exec(text.slice(index + 2, index + 6))?.[0] ?? '';
    if (digits.length === 4) {
      return { ok: true, value: String.fromCharCode(parseInt(digits, 16)), end: index + 6 };
    }
    return { ok: false, end: index + 2 + digits.length };
  }
  return { ok: false, end: index + 2 };
}

export class Lexer {
  private position = 0;

  constructor(private readonly text: string) {}

  next(): Token {
    const text = this.text;
    let start = this.position;
    while (start < text.length && isSpace(text.charCodeAt(start))) {
      start += 1;
    }
    this.position = start;
    if (start >= text.length) {
      return { kind: 'end', span: { start: text.length, end: text.length } };
    }
    const char = text.charAt(start);
    if (char === '"' || char === "'") {
      return this.string(start, char);
    }
    if (char === '/') {
      return this.regex(start);
    }
    if (char === '@') {
      return this.at(start);
    }
    if (char === '-' || isDigit(char)) {
      return this.number(start);
    }
    if (identifierStart.test(char)) {
      return this.word(start);
    }
    return this.punctuation(start);
  }

  private error(message: string, start: number, end: number): ErrorToken {
    this.position = this.text.length;
    return { kind: 'error', message, span: { start, end } };
  }

  private string(start: number, quote: string): Token {
    const text = this.text;
    let value = '';
    let run = start + 1;
    let index = run;
    while (index < text.length) {
      const char = text.charAt(index);
      if (char === quote) {
        this.position = index + 1;
        return {
          kind: 'string',
          value: value + text.slice(run, index),
          span: { start, end: index + 1 },
        };
      }
      if (char !== '\\') {
        index += 1;
        continue;
      }
      value += text.slice(run, index);
      const escape = readEscape(text, index);
      if (escape === undefined) {
        break;
      }
      if (!escape.ok) {
        return this.error('Invalid escape sequence.', index, escape.end);
      }
      value += escape.value;
      index = escape.end;
      run = index;
    }
    return this.error('Unterminated string.', start, text.length);
  }

  private regex(start: number): Token {
    const text = this.text;
    let inClass = false;
    let index = start + 1;
    while (index < text.length) {
      const char = text.charAt(index);
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (inClass) {
        inClass = char !== ']';
      } else if (char === '[') {
        inClass = true;
      } else if (char === '/') {
        return this.regexFlags(start, index);
      }
      index += 1;
    }
    return this.error('Unterminated regular expression.', start, text.length);
  }

  private regexFlags(start: number, close: number): Token {
    flagsPattern.lastIndex = close + 1;
    const flags = flagsPattern.exec(this.text)?.[0] ?? '';
    const problem = checkFlags(flags);
    if (problem !== undefined) {
      const at = close + 1 + problem.index;
      return this.error(problem.message, at, at + 1);
    }
    this.position = close + 1 + flags.length;
    return {
      kind: 'regex',
      pattern: this.text.slice(start + 1, close),
      flags,
      span: { start, end: this.position },
    };
  }

  private at(start: number): Token {
    identifierPattern.lastIndex = start + 1;
    const name = identifierPattern.exec(this.text)?.[0] ?? '';
    this.position = start + 1 + name.length;
    return { kind: 'at', name, span: { start, end: this.position } };
  }

  private number(start: number): Token {
    numberPattern.lastIndex = start;
    const source = numberPattern.exec(this.text)?.[0];
    if (source === undefined) {
      return this.unexpected(start);
    }
    this.position = start + source.length;
    const number = Number(source);
    const value =
      integerSource.test(source) && !Number.isSafeInteger(number) ? BigInt(source) : number;
    return { kind: 'number', value, span: { start, end: this.position } };
  }

  private word(start: number): Token {
    identifierPattern.lastIndex = start;
    const word = identifierPattern.exec(this.text)?.[0] ?? '';
    this.position = start + word.length;
    const span = { start, end: this.position };
    return isKeyword(word)
      ? { kind: 'keyword', text: word, span }
      : { kind: 'identifier', text: word, span };
  }

  private punctuation(start: number): Token {
    const text = this.text;
    const pair = text.slice(start, start + 2);
    if (pair.length === 2 && isPunctuation(pair)) {
      this.position = start + 2;
      return { kind: 'punctuation', text: pair, span: { start, end: start + 2 } };
    }
    const single = text.charAt(start);
    if (isPunctuation(single)) {
      this.position = start + 1;
      return { kind: 'punctuation', text: single, span: { start, end: start + 1 } };
    }
    return this.unexpected(start);
  }

  private unexpected(start: number): ErrorToken {
    const text = this.text;
    const code = text.charCodeAt(start);
    const next = text.charCodeAt(start + 1);
    const pair = code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
    const end = start + (pair ? 2 : 1);
    return this.error(`Unexpected \`${text.slice(start, end)}\`.`, start, end);
  }
}
