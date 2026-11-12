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
    isSensitiveHeader(name)
      ? maskedValue
      : maskUrl(value).replace(embeddedUserInfoPattern, `$1${maskedValue}@`),
  ]);
}

export function maskUrl(url: string): string {
  return url.replace(urlUserInfoPattern, `$1${maskedValue}@`);
}
