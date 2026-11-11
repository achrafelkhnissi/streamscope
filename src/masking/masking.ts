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
const userInfoPattern = /^([a-z][a-z\d+.-]*:\/\/)[^/?#]*@/i;

export function isSensitiveHeader(name: string): boolean {
  return name
    .toLowerCase()
    .split(/[-_]/)
    .some((word) => sensitiveWords.has(word));
}

export function maskHeaders(headers: Headers): [string, string][] {
  return headers.map(([name, value]) => [name, isSensitiveHeader(name) ? maskedValue : value]);
}

export function maskUrl(url: string): string {
  return url.replace(userInfoPattern, `$1${maskedValue}@`);
}
