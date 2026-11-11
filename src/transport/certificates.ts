import { getCACertificates } from 'node:tls';

export function trustedCertificates(custom: readonly string[]): string[] {
  return [...new Set([...getCACertificates('default'), ...getCACertificates('system'), ...custom])];
}
