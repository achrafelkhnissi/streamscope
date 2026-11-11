import type { Headers } from '../transport/model';

export const maskedValue = '••••••';

const sensitiveHeaders: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
]);
const urlPasswordPattern = /^([a-z][a-z\d+.-]*:\/\/[^/?#@:]*:)[^/?#@]*@/i;

export function isSensitiveHeader(name: string): boolean {
  return sensitiveHeaders.has(name.toLowerCase());
}

export function maskHeaders(headers: Headers): [string, string][] {
  return headers.map(([name, value]) => [name, isSensitiveHeader(name) ? maskedValue : value]);
}

export function maskUrl(url: string): string {
  return url.replace(urlPasswordPattern, `$1${maskedValue}@`);
}
