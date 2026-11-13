import { describe, expect, it } from 'vitest';
import { captureDisplayText } from '../../../src/masking/capture-display';
import {
  maskedValue,
  sensitiveHeaderValues,
  sensitiveValuesIn,
} from '../../../src/masking/masking';

function shown(
  text: string,
  options: { name?: string; secret?: boolean; sensitive?: readonly string[] } = {},
  length?: number,
): string {
  return captureDisplayText(
    {
      name: options.name ?? 'threadId',
      secret: options.secret ?? false,
      text,
      sensitive: options.sensitive ?? [],
    },
    length,
  );
}

describe('captureDisplayText', () => {
  it('shows a plain value as it is', () => {
    expect(shown('thread-1')).toBe('thread-1');
  });

  it('masks the whole value of a secret capture or a credential-looking name', () => {
    expect(shown('synthetic-value', { secret: true })).toBe(maskedValue);
    expect(shown('synthetic-value', { name: 'accessToken' })).toBe(maskedValue);
    expect(shown('synthetic-value', { name: 'login.apiKey' })).toBe(maskedValue);
  });

  it('masks every carried sensitive value where it appears, and URL user info', () => {
    expect(
      shown('Bearer synthetic-token, again synthetic-token', { sensitive: ['synthetic-token'] }),
    ).toBe(`Bearer ${maskedValue}, again ${maskedValue}`);
    expect(shown('https://user:synthetic-password@hooks.example.test/done')).toBe(
      `https://${maskedValue}@hooks.example.test/done`,
    );
  });

  it('cuts at the given length after masking', () => {
    expect(shown('a'.repeat(300), {}, 200)).toBe(`${'a'.repeat(199)}…`);
    expect(
      shown(
        `${'b'.repeat(190)}synthetic-token${'c'.repeat(100)}`,
        { sensitive: ['synthetic-token'] },
        200,
      ),
    ).toBe(`${'b'.repeat(190)}${maskedValue}ccc…`);
  });

  it('shows an empty value as ""', () => {
    expect(shown('')).toBe('""');
  });
});

describe('sensitive values of a response', () => {
  it('takes sensitive header values and the cookie values of Set-Cookie', () => {
    expect(
      sensitiveHeaderValues([
        ['Content-Type', 'application/json'],
        ['Set-Cookie', 'session=synthetic-cookie; Path=/; HttpOnly'],
        ['set-cookie', 'theme=dark'],
        ['X-Api-Key', 'synthetic-key'],
        ['X-Trace', 'trace-1'],
        ['Authorization', ''],
      ]),
    ).toEqual([
      'session=synthetic-cookie; Path=/; HttpOnly',
      'synthetic-cookie',
      'theme=dark',
      'dark',
      'synthetic-key',
    ]);
  });

  it('keeps only the values that occur in a text, in any encoded form', () => {
    expect(
      sensitiveValuesIn('received Bearer synthetic-token and a%20b', [
        'synthetic-token',
        'a b',
        'absent-value',
        '',
      ]),
    ).toEqual(['synthetic-token', 'a b']);
  });
});
