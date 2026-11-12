import { createHash } from 'node:crypto';

export function workspaceHash(identity: string): string {
  return createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

export function secretKey(hash: string, name: string): string {
  return `streamscope:${hash}:${name}`;
}
