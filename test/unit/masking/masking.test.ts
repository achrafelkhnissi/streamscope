import { describe, expect, it } from 'vitest';
import {
  isCredentialCookie,
  isSensitiveHeader,
  looksLikeCredential,
  maskedPreview,
  maskedValue,
  maskHeaders,
  maskUrl,
  maskValues,
  sensitiveValuesIn,
} from '../../../src/masking/masking';
import { fastest } from '../timing';

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
    expect(maskUrl('{{scheme}}://admin:synthetic@api.example.test/x')).toBe(
      '{{scheme}}://••••••@api.example.test/x',
    );
    expect(maskUrl('{{base}}/redirect?to=https://admin:synthetic@api.example.test/x')).toBe(
      '{{base}}/redirect?to=https://••••••@api.example.test/x',
    );
    expect(maskUrl('//user:synthetic@files.example.test/a')).toBe('//••••••@files.example.test/a');
  });

  it('masks 1 MiB without a colon in linear time', () => {
    const dotted = 'a.'.repeat(524_288);
    const kebab = 'word-'.repeat(209_716).slice(0, 1_048_576);

    for (const text of [dotted, kebab]) {
      const { value, ms } = fastest(() => maskUrl(text));
      expect(value).toBe(text);
      expect(ms).toBeLessThan(100);
    }
  });

  it('masks user info after a scheme longer than 32 characters', () => {
    const scheme = `x${'-scheme'.repeat(8)}`;

    expect(maskUrl(`${scheme}://admin:synthetic-pass@api.example.test/a`)).toBe(
      `${scheme}://••••••@api.example.test/a`,
    );
    expect(maskUrl(`go to ${'y'.repeat(40)}://admin:synthetic-pass@api.example.test/a`)).toBe(
      `go to ${'y'.repeat(40)}://••••••@api.example.test/a`,
    );
  });

  it('maskedPreview hides a credential past the cut after many masked URLs shorten the text', () => {
    const urls = Array.from(
      { length: 40 },
      (_, index) => `//u:${'q'.repeat(30)}@h${String(index)}`,
    ).join(' ');
    const filler = 'b'.repeat(5_100 - urls.length - 1);
    const credential = 'https://admin:synthetic-pass@api.example.test/a';
    const text = `${urls} ${filler}${credential}${'c'.repeat(8_000)}`;
    expect(text.indexOf('@api.example.test')).toBe(5_128);

    const preview = maskedPreview(text);

    expect(preview).not.toMatch(/admin|synth|qqq/);
    expect(preview.endsWith('…')).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(4_096);
  });

  it('maskedPreview shows only … when masking shrinks the window below 1 KiB', () => {
    const units = `//${'k'.repeat(1_050)}@h`.repeat(4);
    const credential = '//admin:synthetic-pass';
    const window = `${units}${credential}${'P'.repeat(5_120 - units.length - credential.length)}`;
    const text = `${window}@h${'z'.repeat(1_000)}`;
    expect(maskUrl(window).length).toBeGreaterThanOrEqual(500);
    expect(maskUrl(window).length).toBeLessThan(1_024);

    const preview = maskedPreview(text);

    expect(preview).not.toMatch(/admin|synth/);
    expect(preview.length).toBeLessThanOrEqual(4_096);
  });

  it('maskedPreview never shows user info from a list of URLs at any offset', () => {
    const list = JSON.stringify(
      Array.from({ length: 120 }, (_, index) => {
        const id = String(index).padStart(3, '0');
        return `postgres://svc_${id}:Synthetic${id}Pass@db-${id}.example.test/app`;
      }),
    );
    const leaks: number[] = [];

    for (let offset = 0; offset < 90; offset += 1) {
      const preview = maskedPreview(`{"pad":"${'x'.repeat(offset)}","urls":${list}}`);
      expect(preview.length).toBeLessThanOrEqual(4_096);
      if (/svc_|Synth|Pass@/.test(preview)) {
        leaks.push(offset);
      }
    }

    expect(leaks).toEqual([]);
  });

  it('maskedPreview fits a length with … and masks user info just past the cut', () => {
    const userInfo = 'https://admin:synthetic-pass@api.example.test/a';
    const preview = maskedPreview(`${'b'.repeat(4_080)} ${userInfo} ${'c'.repeat(500)}`);
    const longer = maskedPreview(`${'b'.repeat(4_080)} ${userInfo} ${'c'.repeat(1_048_576)}`);

    expect(maskedPreview('short https://admin:synthetic-pass@api.example.test/a')).toBe(
      'short https://••••••@api.example.test/a',
    );
    expect(preview).toBe(`${'b'.repeat(4_080)} https://••••••…`);
    expect(preview.length).toBe(4_096);
    expect(longer).not.toMatch(/admin|synth/);
    expect(longer.length).toBeLessThanOrEqual(4_096);
    expect(maskedPreview('d'.repeat(4_096))).toBe('d'.repeat(4_096));
    expect(maskedPreview('d'.repeat(4_097))).toBe(`${'d'.repeat(4_095)}…`);
    expect(maskedPreview(`${'e'.repeat(8)}😀x`, 10)).toBe(`${'e'.repeat(8)}…`);
    expect(maskedPreview('f'.repeat(30), 10)).toBe(`${'f'.repeat(9)}…`);
    expect(maskedPreview('g'.repeat(10), 10)).toBe('g'.repeat(10));
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

  it('recognises credential names in any casing and separator style', () => {
    for (const name of [
      'token',
      'accessToken',
      'ACCESS_TOKEN',
      'api-key',
      'apiKey',
      'clientSecret',
      'db.password',
      'Bearer',
    ]) {
      expect(looksLikeCredential(name), name).toBe(true);
    }
    for (const name of ['host', 'baseUrl', 'userId', 'keyboard']) {
      expect(looksLikeCredential(name), name).toBe(false);
    }
  });

  it('masks every occurrence of every value, longest first', () => {
    expect(
      maskValues('a=synthetic-token-2;b=synthetic-token', ['synthetic-token', 'synthetic-token-2']),
    ).toBe('a=••••••;b=••••••');
  });

  it('masks percent-encoded forms of a value', () => {
    expect(
      maskValues('a=synthetic%20pass%22w&b=synthetic+pass%22w&c=synthetic pass"w', [
        'synthetic pass"w',
      ]),
    ).toBe('a=••••••&b=••••••&c=••••••');
  });

  it('ignores empty values', () => {
    expect(maskValues('abc', [''])).toBe('abc');
  });

  it('masks the JSON-escaped form of a value with a quote or a backslash', () => {
    const value = 'k3y"quoted\\08';
    const json = JSON.stringify({ key: value, other: 'plain' });

    expect(maskValues(json, [value])).toBe('{"key":"••••••","other":"plain"}');
    expect(sensitiveValuesIn(json, [value, 'absent"value'])).toEqual([value]);
  });

  it('finds and masks a value with a lone surrogate, raw or JSON-escaped, without throwing', () => {
    const high = 'synthetic-\ud800-token';
    const low = 'synthetic-\udc00-token';
    const text = `raw ${high} raw ${low} json ${JSON.stringify(high)}`;

    expect(sensitiveValuesIn(text, [high, low, 'absent-\ud800'])).toEqual([high, low]);
    expect(sensitiveValuesIn('{"t":"synthetic-\\ud800-token"}', [high])).toEqual([high]);
    expect(maskValues(text, [high, low])).toBe('raw •••••• raw •••••• json "••••••"');
  });

  it('masks a value with a lone surrogate in the forms the wire sends it, with U+FFFD for the surrogate', () => {
    const value = 'synthetic-\ud800-token';
    const text = 'a=synthetic-%EF%BF%BD-token&b=synthetic-\uFFFD-token';

    expect(sensitiveValuesIn(text, [value])).toEqual([value]);
    expect(maskValues(text, [value])).toBe('a=••••••&b=••••••');
  });

  it('recognises credential cookie names by case-insensitive substrings', () => {
    for (const name of [
      'session',
      'sess',
      'sid',
      'connect.sid',
      '__Host-session',
      'ASP.NET_SessionId',
      'XSRF-TOKEN',
      'csrf_token',
      'authToken',
      'myJWT',
      'app-secret',
      'db_password',
      'passwd',
      'login',
      'remember_me',
      'user.credential',
      'PHPSESSID',
      'JSESSIONID',
      'sessionid',
      'csrftoken',
      'author_pref',
      'sidebar_state',
      'assessment',
      'tokenizer',
    ]) {
      expect(isCredentialCookie(name), name).toBe(true);
    }
    for (const name of [
      'cookie_consent',
      'viewed_cookie_policy',
      'cookie_notice_accepted',
      'consent',
      'theme',
      'api_key',
    ]) {
      expect(isCredentialCookie(name), name).toBe(false);
    }
  });
});
