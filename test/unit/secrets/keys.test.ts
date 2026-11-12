import { describe, expect, it } from 'vitest';
import { secretKey, workspaceHash } from '../../../src/secrets/keys';

describe('secret keys', () => {
  it('hashes the workspace identity to 16 hex characters', () => {
    const hash = workspaceHash('file:///work/project');

    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(workspaceHash('file:///work/project')).toBe(hash);
    expect(workspaceHash('file:///work/other')).not.toBe(hash);
  });

  it('builds the documented key', () => {
    expect(secretKey('0123456789abcdef', 'apiToken')).toBe('streamscope:0123456789abcdef:apiToken');
  });
});
