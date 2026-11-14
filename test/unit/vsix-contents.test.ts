import { describe, expect, it } from 'vitest';
import { expectedVsixFiles, vsixContentsProblem } from '../../scripts/vsix-contents.mjs';

describe('VSIX contents', () => {
  it('lists the bundle, manifest, documents, language files and icon', () => {
    expect([...expectedVsixFiles].sort()).toEqual([
      'CHANGELOG.md',
      'LICENSE',
      'README.md',
      'ThirdPartyNotices.txt',
      'dist/capture-worker.js',
      'dist/extension.js',
      'dist/format-worker.js',
      'dist/response-view.js',
      'images/icon.png',
      'language-configuration.json',
      'package.json',
      'syntaxes/http.tmLanguage.json',
    ]);
  });

  it('accepts the expected files in any order', () => {
    expect(vsixContentsProblem([...expectedVsixFiles].reverse())).toBeUndefined();
  });

  it('names unexpected and missing files', () => {
    const packaged = [
      ...expectedVsixFiles.filter((file) => file !== 'images/icon.png'),
      'images/live-stream.gif',
      'images/icon.svg',
    ];
    expect(vsixContentsProblem(packaged)).toBe(
      'The VSIX holds files it should not: images/icon.svg, images/live-stream.gif. It is missing: images/icon.png.',
    );
    expect(vsixContentsProblem([...expectedVsixFiles, 'test/fixtures/a.http'])).toBe(
      'The VSIX holds files it should not: test/fixtures/a.http.',
    );
  });
});
