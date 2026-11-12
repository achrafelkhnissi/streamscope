import { describe, expect, it } from 'vitest';
import { parseJson } from '../../../src/streaming/json';

function nativeMessage(text: string): string {
  try {
    JSON.parse(text);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`${text} is valid JSON`);
}

describe('parseJson', () => {
  it('keeps the exact digits of integers beyond the safe range', () => {
    expect(parseJson('{"id":12345678901234567890}')).toStrictEqual({
      ok: true,
      value: { id: 12345678901234567890n },
    });
  });

  it('keeps the exact digits of negative, nested and top-level large integers', () => {
    expect(
      parseJson(
        '{"ids":[-12345678901234567890,18446744073709551616],"deep":{"n":98765432109876543210}}',
      ),
    ).toStrictEqual({
      ok: true,
      value: {
        ids: [-12345678901234567890n, 18446744073709551616n],
        deep: { n: 98765432109876543210n },
      },
    });
    expect(parseJson('12345678901234567890')).toStrictEqual({
      ok: true,
      value: 12345678901234567890n,
    });
  });

  it('switches to bigint exactly at the first integer beyond the safe range', () => {
    expect(
      parseJson('[9007199254740991,9007199254740992,-9007199254740991,-9007199254740992]'),
    ).toStrictEqual({
      ok: true,
      value: [9007199254740991, 9007199254740992n, -9007199254740991, -9007199254740992n],
    });
  });

  it('keeps safe integers and decimals as numbers', () => {
    expect(parseJson('{"a":9007199254740991,"b":1.5,"c":1e21}')).toStrictEqual({
      ok: true,
      value: { a: 9007199254740991, b: 1.5, c: 1e21 },
    });
  });

  it('keeps decimals and exponents with long digit runs as numbers', () => {
    const text =
      '{"a":12345678901234567890.5,"b":12345678901234567890e0,"c":1.2345678901234567890}';

    const expected: unknown = JSON.parse(text);

    expect(parseJson(text)).toStrictEqual({ ok: true, value: expected });
  });

  it('leaves long digit runs inside strings and keys alone', () => {
    expect(parseJson('{"12345678901234567890":"12345678901234567890"}')).toStrictEqual({
      ok: true,
      value: { '12345678901234567890': '12345678901234567890' },
    });
  });

  it('reports the parser message for invalid JSON', () => {
    const invalid = ['', 'not json', '{"a":', '{"a":1}}', '{"id":12345678901234567890'];

    for (const text of invalid) {
      const result = parseJson(text);

      expect(result.ok, text).toBe(false);
      if (!result.ok) {
        expect(result.message.length, text).toBeGreaterThan(0);
        expect(result.message, text).toBe(nativeMessage(text));
      }
    }
  });

  it('parses top-level strings, numbers, arrays and null', () => {
    expect(parseJson('"text"')).toStrictEqual({ ok: true, value: 'text' });
    expect(parseJson('42')).toStrictEqual({ ok: true, value: 42 });
    expect(parseJson('-1.25')).toStrictEqual({ ok: true, value: -1.25 });
    expect(parseJson('[1,"two",null,true,{"three":3}]')).toStrictEqual({
      ok: true,
      value: [1, 'two', null, true, { three: 3 }],
    });
    expect(parseJson('null')).toStrictEqual({ ok: true, value: null });
    expect(parseJson('false')).toStrictEqual({ ok: true, value: false });
  });

  it('accepts surrounding whitespace', () => {
    expect(parseJson('  \t{"type":"RUN_STARTED","threadId":"thread-1"}\r\n')).toStrictEqual({
      ok: true,
      value: { type: 'RUN_STARTED', threadId: 'thread-1' },
    });
  });

  it('keeps very long integer literals as numbers', () => {
    const result = parseJson(`{"id":${'9'.repeat(2000)}}`);

    expect(result.ok).toBe(true);
    expect(result.ok && typeof (result.value as { id: unknown }).id).toBe('number');
    expect(parseJson(`{"id":${'9'.repeat(1000)}}`)).toMatchObject({
      ok: true,
      value: { id: BigInt('9'.repeat(1000)) },
    });
  });
});
