export const expectedVsixFiles = [
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'ThirdPartyNotices.txt',
  'language-configuration.json',
  'package.json',
  'dist/capture-worker.js',
  'dist/extension.js',
  'dist/format-worker.js',
  'dist/response-view.js',
  'syntaxes/http.tmLanguage.json',
  'images/icon.png',
];

export function vsixContentsProblem(files) {
  const packaged = new Set(files);
  const expected = new Set(expectedVsixFiles);
  const extra = [...packaged].filter((file) => !expected.has(file)).sort();
  const missing = [...expected].filter((file) => !packaged.has(file)).sort();
  const parts = [];
  if (extra.length > 0) {
    parts.push(`The VSIX holds files it should not: ${extra.join(', ')}.`);
  }
  if (missing.length > 0) {
    parts.push(`It is missing: ${missing.join(', ')}.`);
  }
  return parts.length === 0 ? undefined : parts.join(' ');
}
