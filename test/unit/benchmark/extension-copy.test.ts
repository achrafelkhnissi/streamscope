import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyExtension } from '../../benchmark/view/extension-copy';

describe('copyExtension', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'extension-copy-'));
    mkdirSync(path.join(root, 'source', 'dist'), { recursive: true });
    mkdirSync(path.join(root, 'source', 'syntaxes'), { recursive: true });
    mkdirSync(path.join(root, 'source', '.vscode-test', 'app', 'extensions', 'theme-abyss'), {
      recursive: true,
    });
    writeFileSync(path.join(root, 'source', 'dist', 'extension.js'), 'bundle');
    writeFileSync(path.join(root, 'source', 'dist', 'ignored.js.map'), 'map');
    writeFileSync(path.join(root, 'source', 'syntaxes', 'http.json'), 'grammar');
    writeFileSync(
      path.join(root, 'source', '.vscode-test', 'app', 'extensions', 'theme-abyss', 'theme.json'),
      'theme',
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeManifest(files: unknown): void {
    writeFileSync(path.join(root, 'source', 'package.json'), JSON.stringify({ files }));
  }

  it('copies the manifest and the files it lists, and nothing else', () => {
    writeManifest(['dist/extension.js', 'syntaxes']);
    const destination = path.join(root, 'staged');

    copyExtension(path.join(root, 'source'), destination);

    expect(readFileSync(path.join(destination, 'dist', 'extension.js'), 'utf8')).toBe('bundle');
    expect(readFileSync(path.join(destination, 'syntaxes', 'http.json'), 'utf8')).toBe('grammar');
    expect(JSON.parse(readFileSync(path.join(destination, 'package.json'), 'utf8'))).toEqual({
      files: ['dist/extension.js', 'syntaxes'],
    });
    expect(existsSync(path.join(destination, 'dist', 'ignored.js.map'))).toBe(false);
    expect(existsSync(path.join(destination, '.vscode-test'))).toBe(false);
  });

  it('fails when a listed file is missing', () => {
    writeManifest(['dist/extension.js', 'dist/response-view.js']);

    expect(() => {
      copyExtension(path.join(root, 'source'), path.join(root, 'staged'));
    }).toThrow(/response-view\.js/);
  });

  it.each([undefined, 'dist/extension.js', [1], [['dist']]])(
    'refuses a manifest whose files are %j',
    (files) => {
      writeManifest(files);

      expect(() => {
        copyExtension(path.join(root, 'source'), path.join(root, 'staged'));
      }).toThrow('has no "files" list to copy.');
    },
  );
});
