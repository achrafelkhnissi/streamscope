import type { Value } from './ast';
import type { ValueObject } from './value';
import { isList } from './value';

export type BoundedText = { ok: true; text: string } | { ok: false };

export const maxInsertedLength = 1_048_576;

export const valueTooLargeReason = 'the value is larger than 1 MiB';

interface ListFrame {
  readonly items: readonly Value[];
  index: number;
}

interface ObjectFrame {
  readonly source: ValueObject;
  readonly keys: readonly string[];
  index: number;
}

const tooLarge: BoundedText = Object.freeze({ ok: false });

function fit(text: string, maxLength: number): BoundedText {
  return text.length > maxLength ? tooLarge : { ok: true, text };
}

function scalarJson(value: null | boolean | number | bigint | string): string {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
      return value.toString();
    case 'number':
      return Number.isFinite(value) ? String(value) : 'null';
    default:
      return String(value);
  }
}

export function compactJson(root: Value, maxLength: number): BoundedText {
  const parts: string[] = [];
  const stack: (ListFrame | ObjectFrame)[] = [];
  const keyText = new Map<string, string>();
  let length = 0;
  let pending: Value | undefined = root;
  for (;;) {
    if (pending !== undefined) {
      if (typeof pending !== 'object' || pending === null) {
        if (typeof pending === 'string' && length + pending.length + 2 > maxLength) {
          return tooLarge;
        }
        const text = scalarJson(pending);
        parts.push(text);
        length += text.length;
      } else if (isList(pending)) {
        parts.push('[');
        length += 1;
        stack.push({ items: pending, index: 0 });
      } else {
        parts.push('{');
        length += 1;
        stack.push({ source: pending, keys: Object.keys(pending), index: 0 });
      }
      pending = undefined;
    }
    if (length > maxLength) {
      return tooLarge;
    }
    const frame = stack[stack.length - 1];
    if (frame === undefined) {
      return { ok: true, text: parts.join('') };
    }
    if ('items' in frame) {
      if (frame.index === frame.items.length) {
        parts.push(']');
        length += 1;
        stack.pop();
        continue;
      }
      if (frame.index > 0) {
        parts.push(',');
        length += 1;
      }
      pending = frame.items[frame.index];
    } else {
      if (frame.index === frame.keys.length) {
        parts.push('}');
        length += 1;
        stack.pop();
        continue;
      }
      const key = frame.keys[frame.index] as string;
      let text = keyText.get(key);
      if (text === undefined) {
        if (length + key.length + 3 > maxLength) {
          return tooLarge;
        }
        text = `${JSON.stringify(key)}:`;
        keyText.set(key, text);
      }
      if (frame.index > 0) {
        parts.push(',');
        length += 1;
      }
      parts.push(text);
      length += text.length;
      pending = frame.source[key];
    }
    frame.index += 1;
  }
}

export function insertText(value: Value, maxLength: number): BoundedText {
  switch (typeof value) {
    case 'string':
      return fit(value, maxLength);
    case 'number':
      return fit(String(value), maxLength);
    default:
      return compactJson(value, maxLength);
  }
}
