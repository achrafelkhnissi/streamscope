import { describe, expect, it } from 'vitest';
import { changelogSection, releaseVersion } from '../../scripts/release.mjs';

describe('releaseVersion', () => {
  it('takes the version from the tag or the dispatch input and marks odd minors as pre-releases', () => {
    expect(
      releaseVersion({ event: 'push', refName: 'v0.1.0', input: '', manifestVersion: '0.1.0' }),
    ).toEqual({ version: '0.1.0', preRelease: true });
    expect(
      releaseVersion({
        event: 'workflow_dispatch',
        refName: 'main',
        input: '0.2.0',
        manifestVersion: '0.2.0',
      }),
    ).toEqual({ version: '0.2.0', preRelease: false });
  });

  it('refuses a version that is not major.minor.patch or differs from package.json', () => {
    expect(() =>
      releaseVersion({
        event: 'workflow_dispatch',
        refName: 'main',
        input: '0.1.0-beta.1',
        manifestVersion: '0.1.0',
      }),
    ).toThrow('"0.1.0-beta.1" is not a major.minor.patch version.');
    expect(() =>
      releaseVersion({ event: 'push', refName: 'v0.1.1', input: '', manifestVersion: '0.1.0' }),
    ).toThrow('The release is 0.1.1 but package.json says 0.1.0.');
  });
});

describe('changelogSection', () => {
  const changelog = [
    '# Changelog',
    '',
    '## [0.3.0]',
    '',
    '### Added',
    '',
    '- Newer.',
    '',
    '## [0.1.0]',
    '',
    'The first pre-release.',
    '',
    '### Added',
    '',
    '- Streaming.',
    '',
    '[0.1.0]: https://github.com/achrafelkhnissi/streamscope/releases/tag/v0.1.0',
    '',
  ].join('\n');

  it("returns the version's section without its heading or the link definitions", () => {
    expect(changelogSection(changelog, '0.1.0')).toBe(
      'The first pre-release.\n\n### Added\n\n- Streaming.',
    );
    expect(changelogSection(changelog, '0.3.0')).toBe('### Added\n\n- Newer.');
  });

  it('finds a dated section and leaves the date out', () => {
    const dated = changelog.replace('## [0.1.0]', '## [0.1.0] - 2026-11-16');
    expect(changelogSection(dated, '0.1.0')).toBe(
      'The first pre-release.\n\n### Added\n\n- Streaming.',
    );
  });

  it('refuses a version the changelog does not describe', () => {
    expect(() => changelogSection(changelog, '0.2.0')).toThrow(
      'CHANGELOG.md has no section for 0.2.0.',
    );
  });
});
