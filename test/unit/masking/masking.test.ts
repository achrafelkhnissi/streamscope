import { describe, expect, it } from 'vitest';
import { isSensitiveHeader, maskedValue, maskHeaders, maskUrl } from '../../../src/masking/masking';

describe('masking', () => {
  it('masks sensitive header values in any letter case and keeps names and order', () => {
    expect(maskedValue).toBe('••••••');
    expect(
      maskHeaders([
        ['authorization', 'Bearer synthetic'],
        ['X-Trace', '1'],
        ['PROXY-AUTHORIZATION', 'Basic synthetic'],
        ['Cookie', 'a=1'],
        ['set-cookie', 'b=2'],
        ['X-Api-Key', 'synthetic'],
        ['Api-Key', 'synthetic'],
        ['Accept', 'application/json'],
      ]),
    ).toEqual([
      ['authorization', '••••••'],
      ['X-Trace', '1'],
      ['PROXY-AUTHORIZATION', '••••••'],
      ['Cookie', '••••••'],
      ['set-cookie', '••••••'],
      ['X-Api-Key', '••••••'],
      ['Api-Key', '••••••'],
      ['Accept', 'application/json'],
    ]);
    expect(isSensitiveHeader('X-API-KEY')).toBe(true);
    expect(isSensitiveHeader('X-Api-Keys')).toBe(false);
  });

  it('masks a URL password and leaves other URLs unchanged', () => {
    expect(maskUrl('https://user:synthetic@api.example.test/a?b=1')).toBe(
      'https://user:••••••@api.example.test/a?b=1',
    );
    expect(maskUrl('https://user@api.example.test/a')).toBe('https://user@api.example.test/a');
    expect(maskUrl('https://api.example.test/a?token=x')).toBe(
      'https://api.example.test/a?token=x',
    );
    expect(maskUrl('not a url')).toBe('not a url');
  });
});
