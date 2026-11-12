import type { JsonValue } from '../events/model';

const longDigitRun = /\d{16}/;
const integerSource = /^-?\d+$/;

function keepLargeIntegers(_key: string, value: unknown, context?: { source?: string }): unknown {
  const source = context?.source;
  if (
    typeof value === 'number' &&
    !Number.isSafeInteger(value) &&
    source !== undefined &&
    integerSource.test(source)
  ) {
    return BigInt(source);
  }
  return value;
}

export function parseJson(
  text: string,
): { ok: true; value: JsonValue } | { ok: false; message: string } {
  try {
    const value = (
      longDigitRun.test(text) ? JSON.parse(text, keepLargeIntegers) : JSON.parse(text)
    ) as JsonValue;
    return { ok: true, value };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}
