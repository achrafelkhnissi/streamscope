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

export function eventLabel(
  value: JsonValue,
  sse: SseFields | undefined,
  typeFields: readonly string[],
): string | undefined {
  return (typeName(value, typeFields) ?? sse?.event)?.slice(0, maxLabelLength);
}
