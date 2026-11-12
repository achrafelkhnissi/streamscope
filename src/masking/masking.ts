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
const embeddedUserInfoPattern = /((?:\b[a-z][a-z\d+.-]*:)?\/\/)[^\s/?#<>"'`]*@/gi;

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
