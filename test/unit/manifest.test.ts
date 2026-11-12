import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Manifest {
  name: string;
  publisher: string;
  displayName: string;
  license: string;
  repository: { type: string; url: string };
  bugs: { url: string };
  homepage: string;
  extensionKind: string[];
  main: string;
  files: string[];
  engines: { vscode: string };
  devDependencies: Record<string, string>;
  contributes: {
    commands: { command: string; title: string; category?: string }[];
    languages: unknown[];
    grammars: unknown[];
    keybindings: unknown[];
    configuration: { properties: Record<string, { default: unknown; type: string }> };
    menus: Record<string, { command: string; when?: string }[]>;
  };
}

const manifest = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as Manifest;

describe('extension manifest', () => {
  it('carries the Streamscope identity', () => {
    expect(manifest.name).toBe('streamscope');
    expect(manifest.publisher).toBe('achrafelkhnissi');
    expect(manifest.displayName).toBe('Streamscope: HTTP Client with Live Streaming');
    expect(manifest.license).toBe('MIT');
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'https://github.com/achrafelkhnissi/streamscope.git',
    });
    expect(manifest.bugs).toEqual({ url: 'https://github.com/achrafelkhnissi/streamscope/issues' });
    expect(manifest.homepage).toBe('https://github.com/achrafelkhnissi/streamscope#readme');
  });

  it('runs in the workspace extension host', () => {
    expect(manifest.extensionKind).toEqual(['workspace', 'ui']);
  });

  it('pins @types/vscode to the minimum supported VS Code version', () => {
    expect(manifest.engines.vscode).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(manifest.devDependencies['@types/vscode']).toBe(manifest.engines.vscode.slice(1));
  });

  it('gives every command an id prefix, a title and the shared category', () => {
    expect(manifest.contributes.commands.length).toBeGreaterThan(0);
    for (const command of manifest.contributes.commands) {
      expect(command.command).toMatch(/^streamscope\.[a-z][A-Za-z]+$/);
      expect(command.title.trim()).not.toBe('');
      expect(command.category).toBe('Streamscope');
    }
  });

  it('ships the bundled entry point that main refers to', () => {
    expect(manifest.main).toBe('./dist/extension.js');
    expect(manifest.files).toContain('dist/extension.js');
  });

  it('ships the bundle, format worker, language files, changelog and license', () => {
    expect(manifest.files).toEqual([
      'dist/extension.js',
      'dist/format-worker.js',
      'syntaxes/http.tmLanguage.json',
      'language-configuration.json',
      'CHANGELOG.md',
      'LICENSE',
    ]);
  });

  it('contributes the http language and grammar', () => {
    expect(manifest.contributes.languages).toEqual([
      {
        id: 'http',
        aliases: ['HTTP'],
        extensions: ['.http', '.rest'],
        configuration: './language-configuration.json',
      },
    ]);
    expect(manifest.contributes.grammars).toEqual([
      {
        language: 'http',
        scopeName: 'source.http.streamscope',
        path: './syntaxes/http.tmLanguage.json',
        embeddedLanguages: { 'meta.embedded.block.json': 'json' },
      },
    ]);
  });

  it('contributes the request commands with the shared category', () => {
    expect(manifest.contributes.commands.map((command) => command.command)).toEqual([
      'streamscope.sendRequest',
      'streamscope.stopRequest',
      'streamscope.saveResponse',
      'streamscope.showResponseHeaders',
      'streamscope.showResponseBody',
      'streamscope.selectEnvironment',
      'streamscope.showLog',
    ]);
  });

  it('binds Send Request to cmd+alt+enter and ctrl+alt+enter in http editors', () => {
    expect(manifest.contributes.keybindings).toEqual([
      {
        command: 'streamscope.sendRequest',
        key: 'ctrl+alt+enter',
        mac: 'cmd+alt+enter',
        when: 'editorTextFocus && editorLangId == http && resourceScheme != streamscope-response',
      },
    ]);
  });

  it('contributes request settings with their defaults', () => {
    const properties = manifest.contributes.configuration.properties;

    expect(
      Object.fromEntries(
        Object.entries(properties).map(([name, property]) => [name, property.default]),
      ),
    ).toEqual({
      'streamscope.request.connectTimeout': '30s',
      'streamscope.request.headersTimeout': '300s',
      'streamscope.request.followRedirects': true,
      'streamscope.request.maxRedirects': 10,
      'streamscope.request.caFile': '',
      'streamscope.codeLens.enabled': true,
    });
  });

  it('only offers response commands where they apply', () => {
    const palette = Object.fromEntries(
      manifest.contributes.menus.commandPalette?.map(({ command, when }) => [command, when]) ?? [],
    );

    expect(palette['streamscope.sendRequest']).toBe(
      'editorLangId == http && resourceScheme != streamscope-response',
    );
    expect(palette['streamscope.saveResponse']).toBe(
      'editorLangId == http || resourceScheme == streamscope-response',
    );
    expect(manifest.contributes.menus['editor/title']?.map(({ command }) => command)).toEqual([
      'streamscope.showResponseHeaders',
      'streamscope.showResponseBody',
      'streamscope.saveResponse',
    ]);
  });
});
