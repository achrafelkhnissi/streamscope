import { describe, expect, it } from 'vitest';
import { installedVersionProblem } from '../../scripts/clean-profile.mjs';

const id = 'achrafelkhnissi.streamscope';

describe('installedVersionProblem', () => {
  it('accepts the expected id and version among others', () => {
    expect(installedVersionProblem(`other.ext@1.0.0\n${id}@0.1.0\n`, id, '0.1.0')).toBeUndefined();
  });

  it('names the version it found when another one is installed', () => {
    expect(installedVersionProblem(`${id}@0.2.0\n`, id, '0.1.0')).toBe(
      `Expected ${id}@0.1.0 in the clean profile, found: ${id}@0.2.0`,
    );
  });

  it('says so when the extension is missing', () => {
    expect(installedVersionProblem('', id, '0.1.0')).toBe(
      `Expected ${id}@0.1.0 in the clean profile, found: nothing`,
    );
  });
});
