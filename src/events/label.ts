import { maxLabelLength } from '../streaming/limits';
import type { JsonValue, SseFields } from './model';

function typeName(value: JsonValue, typeFields: readonly string[]): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const fields = value as { readonly [key: string]: JsonValue };
  for (const field of typeFields) {
    const candidate = Object.hasOwn(fields, field) ? fields[field] : undefined;
    if (
      (typeof candidate === 'string' && candidate !== '') ||
      typeof candidate === 'number' ||
      typeof candidate === 'bigint'
    ) {
      return String(candidate);
    }
  }
  return undefined;
}

function cut(label: string): string {
  if (label.length <= maxLabelLength) {
    return label;
  }
  const end = /[\uD800-\uDBFF]/.test(label.charAt(maxLabelLength - 1))
    ? maxLabelLength - 1
    : maxLabelLength;
  return Buffer.from(label.slice(0, end), 'utf16le').toString('utf16le');
}

export function eventLabel(
  value: JsonValue,
  sse: SseFields | undefined,
  typeFields: readonly string[],
): string | undefined {
  const label = typeName(value, typeFields) ?? sse?.event;
  return label === undefined ? undefined : cut(label);
}
