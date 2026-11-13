import type { Value } from './ast';
import type { ValueObject } from './value';
import { isList } from './value';

interface ListFrame {
  readonly items: readonly Value[];
  index: number;
}

interface ObjectFrame {
  readonly source: ValueObject;
  readonly keys: readonly string[];
  index: number;
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

export function compactJson(root: Value): string {
  const parts: string[] = [];
  const stack: (ListFrame | ObjectFrame)[] = [];
  const keyText = new Map<string, string>();
  let pending: Value | undefined = root;
  for (;;) {
    if (pending !== undefined) {
      if (typeof pending !== 'object' || pending === null) {
        parts.push(scalarJson(pending));
      } else if (isList(pending)) {
        parts.push('[');
        stack.push({ items: pending, index: 0 });
      } else {
        parts.push('{');
        stack.push({ source: pending, keys: Object.keys(pending), index: 0 });
      }
      pending = undefined;
    }
    const frame = stack[stack.length - 1];
    if (frame === undefined) {
      return parts.join('');
    }
    if ('items' in frame) {
      if (frame.index === frame.items.length) {
        parts.push(']');
        stack.pop();
        continue;
      }
      if (frame.index > 0) {
        parts.push(',');
      }
      pending = frame.items[frame.index];
    } else {
      if (frame.index === frame.keys.length) {
        parts.push('}');
        stack.pop();
        continue;
      }
      const key = frame.keys[frame.index] as string;
      let text = keyText.get(key);
      if (text === undefined) {
        text = `${JSON.stringify(key)}:`;
        keyText.set(key, text);
      }
      if (frame.index > 0) {
        parts.push(',');
      }
      parts.push(text);
      pending = frame.source[key];
    }
    frame.index += 1;
  }
}

export function insertText(value: Value): string {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
      return String(value);
    default:
      return compactJson(value);
  }
}
