import type { Headers } from '../transport/model';

export const maskedValue = '••••••';

const sensitiveWords: ReadonlySet<string> = new Set([
  'authorization',
  'auth',
  'token',
  'apikey',
  'key',
  'secret',
  'password',
  'passwd',
  'credential',
  'credentials',
  'session',
  'cookie',
  'signature',
]);
const urlUserInfoPattern = /^((?:[a-z][a-z\d+.-]*:)?\/\/)[^/?#]*@/i;
const embeddedUserInfoPattern = /(\/\/)[^\s/?#<>"'`]*@/g;
const previewLookahead = 1_024;

const maxDisplayLength = 4_096;

export function isSensitiveHeader(name: string): boolean {
  return name
    .toLowerCase()
    .split(/[-_]/)
    .some((word) => sensitiveWords.has(word));
}

export function maskHeaders(headers: Headers): [string, string][] {
  return headers.map(([name, value]) => [
    name,
    isSensitiveHeader(name) ? maskedValue : maskUrl(value),
  ]);
}

export function maskUrl(url: string): string {
  return url
    .replace(urlUserInfoPattern, `$1${maskedValue}@`)
    .replace(embeddedUserInfoPattern, `$1${maskedValue}@`);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function maskedPreview(text: string, length = maxDisplayLength): string {
  const whole = text.length <= length + previewLookahead;
  const masked = maskUrl(text.slice(0, length + previewLookahead));
  if (whole && masked.length <= length) {
    return masked;
  }
  const end = whole ? length - 1 : Math.min(length - 1, masked.length - previewLookahead);
  const kept = isHighSurrogate(masked.charCodeAt(end - 1)) ? end - 1 : end;
  return `${masked.slice(0, Math.max(0, kept))}…`;
}

const credentialWords = ['token', 'bearer', 'apikey', 'secret', 'password'];
const nameSeparators = /[-_.\s]/g;

export function looksLikeCredential(name: string): boolean {
  const normalized = name.toLowerCase().replace(nameSeparators, '');
  return credentialWords.some((word) => normalized.includes(word));
}

function encodedForms(value: string): string[] {
  const component = encodeURIComponent(value);
  return [value, component, component.replace(/%20/g, '+'), encodeURI(value)];
}

export function maskValues(text: string, values: readonly string[]): string {
  return [...new Set(values.flatMap(encodedForms))]
    .filter((value) => value !== '')
    .sort((a, b) => b.length - a.length)
    .reduce((masked, value) => masked.split(value).join(maskedValue), text);
}

export function sensitiveValuesIn(text: string, values: readonly string[]): string[] {
  return values.filter(
    (value) => value !== '' && encodedForms(value).some((form) => text.includes(form)),
  );
}

const minimumHeaderValueLength = 8;

function cookieValue(setCookie: string): string | undefined {
  const pair = setCookie.split(';', 1)[0] ?? '';
  const equals = pair.indexOf('=');
  if (equals === -1) {
    return undefined;
  }
  const name = pair.slice(0, equals).trim();
  const value = pair.slice(equals + 1).trim();
  const credential = looksLikeCredential(name) || isSensitiveHeader(name);
  return value.length >= minimumHeaderValueLength || (credential && value !== '')
    ? value
    : undefined;
}

export function sensitiveHeaderValues(headers: Headers): string[] {
  const values: string[] = [];
  for (const [name, value] of headers) {
    if (!isSensitiveHeader(name)) {
      continue;
    }
    if (value.length >= minimumHeaderValueLength) {
      values.push(value);
    }
    const cookie = name.toLowerCase() === 'set-cookie' ? cookieValue(value) : undefined;
    if (cookie !== undefined) {
      values.push(cookie);
    }
  }
  return values;
}
