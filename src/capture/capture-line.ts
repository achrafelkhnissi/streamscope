import type { JsonValue, SseFields } from '../events/model';
import { isKeyword } from '../expressions/lexer';
import { looksLikeCredential } from '../masking/masking';
import type { PathSegment } from '../response/json-position';

export type EventCondition =
  | { kind: 'field'; field: string; value: string | number | bigint }
  | { kind: 'sse'; value: string };

export type CaptureSource =
  { kind: 'event'; occurrence: number; condition: EventCondition | undefined } | { kind: 'body' };

export type BuiltExpression = { ok: true; text: string } | { ok: false; message: string };

const maxExpressionLength = 4_096;
const maxNameLength = 64;
const tooLongMessage =
  'The path to this value is too long for a capture (more than 4,096 characters).';
const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const invisible = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const nameInput = /^(?:secret\s+)?([A-Za-z_]\w*)$/;
const wordSeparator = /[^A-Za-z0-9]+/;
const capitals = /^[A-Z0-9]+$/;

function stringLiteral(text: string): string {
  return JSON.stringify(text).replace(
    invisible,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function isPlainName(name: string): boolean {
  return identifier.test(name) && !isKeyword(name);
}

function literal(value: string | number | bigint): string {
  return typeof value === 'string' ? stringLiteral(value) : String(value);
}

function pathText(segments: readonly PathSegment[]): string {
  return segments
    .map((segment) =>
      typeof segment === 'number'
        ? `[${String(segment)}]`
        : isPlainName(segment)
          ? `.${segment}`
          : `[${stringLiteral(segment)}]`,
    )
    .join('');
}

function isTypeValue(value: JsonValue | undefined): value is string | number | bigint {
  return (
    (typeof value === 'string' && value !== '') ||
    typeof value === 'number' ||
    typeof value === 'bigint'
  );
}

export function eventCondition(
  value: JsonValue,
  sse: SseFields | undefined,
  typeFields: readonly string[],
): EventCondition | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const fields = value as { readonly [key: string]: JsonValue };
    for (const field of typeFields) {
      const candidate = Object.hasOwn(fields, field) ? fields[field] : undefined;
      if (isTypeValue(candidate)) {
        return { kind: 'field', field, value: candidate };
      }
    }
  }
  return sse?.event === undefined ? undefined : { kind: 'sse', value: sse.event };
}

export function conditionText(condition: EventCondition): string {
  if (condition.kind === 'sse') {
    return `@sse.event == ${stringLiteral(condition.value)}`;
  }
  const field = isPlainName(condition.field)
    ? condition.field
    : `@[${stringLiteral(condition.field)}]`;
  return `${field} == ${literal(condition.value)}`;
}

export function captureExpression(
  source: CaptureSource,
  segments: readonly PathSegment[],
): BuiltExpression {
  let head = 'body';
  if (source.kind === 'event') {
    const condition = source.condition === undefined ? '' : conditionText(source.condition);
    head =
      source.occurrence === 1
        ? `first(${condition})`
        : `nth(${String(source.occurrence)}${condition === '' ? '' : `, ${condition}`})`;
  }
  const text = `${head}${pathText(segments)}`;
  return text.length > maxExpressionLength
    ? { ok: false, message: tooLongMessage }
    : { ok: true, text };
}

function nameWord(word: string, first: boolean): string {
  if (capitals.test(word)) {
    const lower = word.toLowerCase();
    return first ? lower : `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
  }
  const initial = word.charAt(0);
  return `${first ? initial.toLowerCase() : initial.toUpperCase()}${word.slice(1)}`;
}

function nameFrom(base: string): string {
  const words = base.split(wordSeparator).filter((word) => word !== '');
  const joined = words.map((word, index) => nameWord(word, index === 0)).join('');
  if (joined === '') {
    return 'value';
  }
  const name = /^\d/.test(joined) ? `_${joined}` : joined;
  return name.slice(0, maxNameLength);
}

export function suggestedCaptureName(
  segments: readonly PathSegment[],
  condition: EventCondition | undefined,
  taken: ReadonlySet<string>,
): string {
  const key = segments.findLast((segment) => typeof segment === 'string');
  const base = key ?? (condition === undefined ? 'value' : String(condition.value));
  const name = nameFrom(base);
  if (!taken.has(name)) {
    return name;
  }
  let suffix = 2;
  while (taken.has(`${name}${String(suffix)}`)) {
    suffix += 1;
  }
  return `${name}${String(suffix)}`;
}

export function captureLine(
  marker: '#' | '//',
  name: string,
  secret: boolean,
  expression: string,
): string {
  return `${marker} @capture ${secret ? 'secret ' : ''}${name} = ${expression}`;
}

export function parseCaptureNameInput(
  input: string,
): { name: string; secret: boolean } | undefined {
  const trimmed = input.trim();
  const match = nameInput.exec(trimmed);
  const name = match?.[1];
  if (name === undefined) {
    return undefined;
  }
  return { name, secret: trimmed !== name || looksLikeCredential(name) };
}
