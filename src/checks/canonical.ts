import type { Value } from '../expressions/ast';

type Part = Value | { text: string };

function isText(part: Part): part is { text: string } {
  return typeof part === 'object' && part !== null && !Array.isArray(part) && 'text' in part;
}

function scalar(
  value: Exclude<Value, readonly Value[] | { readonly [key: string]: Value }>,
): string {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? BigInt(value).toString() : String(value);
  }
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

export function canonicalKey(value: Value): string {
  const out: string[] = [];
  const pending: Part[] = [value];
  for (let part = pending.pop(); part !== undefined; part = pending.pop()) {
    if (isText(part)) {
      out.push(part.text);
    } else if (Array.isArray(part)) {
      const items = part as readonly Value[];
      out.push('[');
      pending.push({ text: ']' });
      for (let at = items.length - 1; at >= 0; at -= 1) {
        pending.push(items[at] ?? null);
        if (at > 0) {
          pending.push({ text: ',' });
        }
      }
    } else if (typeof part === 'object' && part !== null) {
      const fields = part as { readonly [key: string]: Value };
      const keys = Object.keys(fields).sort();
      out.push('{');
      pending.push({ text: '}' });
      for (let at = keys.length - 1; at >= 0; at -= 1) {
        const key = keys[at] ?? '';
        pending.push(fields[key] ?? null);
        pending.push({ text: `${at > 0 ? ',' : ''}${JSON.stringify(key)}:` });
      }
    } else {
      out.push(scalar(part));
    }
  }
  return out.join('');
}
