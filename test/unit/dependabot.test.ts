import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const config = readFileSync(new URL('../../.github/dependabot.yml', import.meta.url), 'utf8');

describe('dependabot configuration', () => {
  it('never proposes @types/vscode, which must equal the engines.vscode floor', () => {
    expect(config).toMatch(/- dependency-name: '@types\/vscode'\n(?!\s+update-types)/);
  });

  it('never proposes a new @types/node major, which follows the floor Node version', () => {
    expect(config).toMatch(
      /- dependency-name: '@types\/node'\n\s+update-types: \['version-update:semver-major'\]/,
    );
  });

  it('keeps typescript on 6.0.x, the range typescript-eslint supports', () => {
    expect(config).toMatch(
      /- dependency-name: typescript\n\s+update-types:\s*\[\s*'version-update:semver-major',\s*'version-update:semver-minor',?\s*\]/,
    );
  });
});
