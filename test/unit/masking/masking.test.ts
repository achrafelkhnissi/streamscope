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
  });

  it('treats token, key, secret and session headers as sensitive', () => {
    for (const name of [
      'X-Auth-Token',
      'Private-Token',
      'X-Goog-Api-Key',
      'Ocp-Apim-Subscription-Key',
      'apikey',
      'X-Amz-Security-Token',
      'X-Client-Secret',
      'X-Session-Id',
      'X-CSRF-Token',
    ]) {
      expect(isSensitiveHeader(name), name).toBe(true);
    }
    for (const name of [
      'Content-Type',
      'Accept',
      'X-Trace',
      'Keep-Alive',
      'X-Request-Id',
      'Host',
    ]) {
      expect(isSensitiveHeader(name), name).toBe(false);
    }
  });

  it('masks URL user info and leaves other URLs unchanged', () => {
    expect(maskUrl('https://user:synthetic@api.example.test/a?b=1')).toBe(
      'https://••••••@api.example.test/a?b=1',
    );
    expect(maskUrl('https://synthetic-token@api.example.test/a')).toBe(
      'https://••••••@api.example.test/a',
    );
    expect(maskUrl('https://u:p@ss@api.example.test/a')).toBe('https://••••••@api.example.test/a');
    expect(maskUrl('https://api.example.test/a?b=c@d')).toBe('https://api.example.test/a?b=c@d');
    expect(maskUrl('https://api.example.test/a?token=x')).toBe(
      'https://api.example.test/a?token=x',
    );
    expect(maskUrl('not a url')).toBe('not a url');
    expect(maskUrl('https://user:pa ss@api.example.test/a')).toBe(
      'https://••••••@api.example.test/a',
    );
    expect(maskUrl('https://user:p"s`s@api.example.test/a')).toBe(
      'https://••••••@api.example.test/a',
    );
    expect(maskUrl('//user:synthetic@files.example.test/a')).toBe('//••••••@files.example.test/a');
  });

  it('masks URL user info inside other header values', () => {
    expect(
      maskHeaders([
        ['Location', 'https://user:synthetic@files.example.test/a'],
        ['Content-Location', 'https://user:p"ss@files.example.test/c'],
        ['Link', '<https://user:synthetic@files.example.test/b>; rel="next"'],
        ['X-Trace', 'plain'],
      ]),
    ).toEqual([
      ['Location', 'https://••••••@files.example.test/a'],
      ['Content-Location', 'https://••••••@files.example.test/c'],
      ['Link', '<https://••••••@files.example.test/b>; rel="next"'],
      ['X-Trace', 'plain'],
    ]);
  });
});
