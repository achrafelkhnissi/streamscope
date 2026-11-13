export type RawTokenKind = 'key' | 'string' | 'number' | 'literal' | 'field' | 'comment' | 'plain';

export interface RawToken {
  kind: RawTokenKind;
  text: string;
}

export interface RawText {
  lines: string[];
  open: string;
}

const fieldPattern = /^(?:data|event|id|retry)(?=:|$)/;
const tokenPattern =
  /(?<key>"(?:[^"\\]|\\.)*"(?=\s*:))|(?<string>"(?:[^"\\]|\\.)*"?)|(?<number>-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|\b(?<literal>true|false|null)\b/g;
const lineBreak = /\r\n|\n|\r(?!$)/g;

function push(tokens: RawToken[], kind: RawTokenKind, text: string): void {
  const previous = tokens.at(-1);
  if (kind === 'plain' && previous?.kind === 'plain') {
    previous.text += text;
  } else {
    tokens.push({ kind, text });
  }
}

function kindOf(groups: Record<string, string | undefined>): RawTokenKind {
  if (groups.key !== undefined) {
    return 'key';
  }
  if (groups.string !== undefined) {
    return 'string';
  }
  return groups.number !== undefined ? 'number' : 'literal';
}

function valueTokens(tokens: RawToken[], text: string): void {
  let at = 0;
  for (const match of text.matchAll(tokenPattern)) {
    if (match.index > at) {
      push(tokens, 'plain', text.slice(at, match.index));
    }
    push(tokens, kindOf(match.groups ?? {}), match[0]);
    at = match.index + match[0].length;
  }
  if (at < text.length) {
    push(tokens, 'plain', text.slice(at));
  }
}

export function rawTokens(line: string): RawToken[] {
  if (line.startsWith(':')) {
    return [{ kind: 'comment', text: line }];
  }
  const tokens: RawToken[] = [];
  const field = fieldPattern.exec(line)?.[0];
  if (field !== undefined) {
    tokens.push({ kind: 'field', text: field });
  }
  valueTokens(tokens, line.slice(field?.length ?? 0));
  return tokens;
}

export function splitLines(open: string, text: string): RawText {
  const combined = open + text;
  const lines: string[] = [];
  let at = 0;
  for (const match of combined.matchAll(lineBreak)) {
    lines.push(combined.slice(at, match.index));
    at = match.index + match[0].length;
  }
  return { lines, open: combined.slice(at) };
}

export function rawTail(
  text: RawText,
  maxChars: number,
  maxLines: number,
): RawText & { cut: boolean } {
  const open = text.open.length > maxChars ? text.open.slice(-maxChars) : text.open;
  let cut = open !== text.open;
  let room = maxChars - open.length;
  let lineRoom = maxLines - (open === '' ? 0 : 1);
  const kept: string[] = [];
  let index = text.lines.length - 1;
  for (; index >= 0 && lineRoom > 0 && room > 0; index -= 1) {
    const line = text.lines[index] ?? '';
    if (line.length + 1 <= room) {
      kept.push(line);
      room -= line.length + 1;
    } else {
      kept.push(line.slice(line.length - (room - 1)));
      cut = true;
      room = 0;
    }
    lineRoom -= 1;
  }
  return { lines: kept.reverse(), open, cut: cut || index >= 0 };
}
