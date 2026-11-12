import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Manifest {
  scripts: Record<string, string>;
  capabilities: unknown;
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
    configuration: {
      properties: Record<
        string,
        {
          default: unknown;
          type: string;
          pattern?: string;
          minimum?: number;
          maximum?: number;
          scope?: string;
          enum?: string[];
          items?: { type: string };
          markdownDescription?: string;
        }
      >;
    };
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

  it('ships the bundle, format worker, response page, language files, changelog and license', () => {
    expect(manifest.files).toEqual([
      'dist/extension.js',
      'dist/format-worker.js',
      'dist/response-view.js',
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
      'streamscope.showResponse',
      'streamscope.showResponseView',
      'streamscope.selectEnvironment',
      'streamscope.setSecret',
      'streamscope.clearSecret',
      'streamscope.listSecrets',
      'streamscope.moveToSecretStorage',
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
        Object.entries(properties)
          .filter(([name]) => !/^streamscope\.(stream|view)\./.test(name))
          .map(([name, property]) => [name, property.default]),
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

  it('contributes stream and view settings with their defaults', () => {
    const properties = manifest.contributes.configuration.properties;
    const names = [
      'streamscope.stream.maxEventSize',
      'streamscope.stream.memoryEvents',
      'streamscope.stream.maxSpillSize',
      'streamscope.stream.maxTotalSpillSize',
      'streamscope.stream.typeFields',
      'streamscope.view.default',
    ];

    expect(
      Object.keys(properties).filter((name) => /^streamscope\.(stream|view)\./.test(name)),
    ).toEqual(names);
    expect(Object.fromEntries(names.map((name) => [name, properties[name]?.default]))).toEqual({
      'streamscope.stream.maxEventSize': '16MiB',
      'streamscope.stream.memoryEvents': 10_000,
      'streamscope.stream.maxSpillSize': '512MiB',
      'streamscope.stream.maxTotalSpillSize': '2GiB',
      'streamscope.stream.typeFields': ['type', 'event', 'object'],
      'streamscope.view.default': 'events',
    });

    for (const name of [
      'streamscope.stream.maxEventSize',
      'streamscope.stream.maxSpillSize',
      'streamscope.stream.maxTotalSpillSize',
    ]) {
      const property = properties[name];
      expect(property?.type).toBe('string');
      expect(property?.pattern).toBe('^\\d+(KiB|MiB|GiB)$');
      const pattern = new RegExp(property?.pattern ?? '');
      expect(pattern.test('512KiB')).toBe(true);
      expect(pattern.test('16MiB')).toBe(true);
      expect(pattern.test('2GiB')).toBe(true);
      expect(pattern.test('16 MiB')).toBe(false);
      expect(pattern.test('16mb')).toBe(false);
    }

    expect(properties['streamscope.stream.memoryEvents']).toMatchObject({
      type: 'integer',
      minimum: 100,
      maximum: 1_000_000,
    });
    expect(properties['streamscope.stream.typeFields']).toMatchObject({
      type: 'array',
      items: { type: 'string' },
    });
    expect(properties['streamscope.view.default']).toMatchObject({
      type: 'string',
      enum: ['events', 'reply', 'raw'],
    });
    for (const name of names) {
      expect(properties[name]?.markdownDescription?.trim()).toBeTruthy();
    }
  });

  it('keeps a workspace from lifting the limits on memory and disk', () => {
    const properties = manifest.contributes.configuration.properties;

    expect(
      Object.fromEntries(
        Object.entries(properties)
          .filter(([name]) => name.startsWith('streamscope.stream.'))
          .map(([name, property]) => [name, property.scope]),
      ),
    ).toEqual({
      'streamscope.stream.maxEventSize': 'resource',
      'streamscope.stream.memoryEvents': 'resource',
      'streamscope.stream.maxSpillSize': 'machine',
      'streamscope.stream.maxTotalSpillSize': 'machine',
      'streamscope.stream.typeFields': 'resource',
    });
  });

  it('says that the spill size settings apply after a reload', () => {
    const properties = manifest.contributes.configuration.properties;

    expect(properties['streamscope.stream.maxSpillSize']?.markdownDescription).toMatch(/reload/i);
    expect(properties['streamscope.stream.maxTotalSpillSize']?.markdownDescription).toMatch(
      /reload/i,
    );
  });

  it('only offers response commands where they apply', () => {
    const palette = Object.fromEntries(
      manifest.contributes.menus.commandPalette?.map(({ command, when }) => [command, when]) ?? [],
    );
    const anywhere =
      "editorLangId == http || resourceScheme == streamscope-response || activeWebviewPanelId == 'streamscope.response'";

    expect(palette['streamscope.sendRequest']).toBe(
      'editorLangId == http && resourceScheme != streamscope-response',
    );
    expect(palette['streamscope.moveToSecretStorage']).toBe('false');
    for (const command of [
      'streamscope.stopRequest',
      'streamscope.saveResponse',
      'streamscope.showResponseHeaders',
      'streamscope.showResponseBody',
      'streamscope.showResponse',
      'streamscope.showResponseView',
    ]) {
      expect(palette[command]).toBe(anywhere);
    }
  });

  it('names the response commands after what they open', () => {
    const titles = Object.fromEntries(
      manifest.contributes.commands.map(({ command, title }) => [command, title]),
    );

    expect(titles['streamscope.showResponse']).toBe('Show Response');
    expect(titles['streamscope.showResponseView']).toBe('Switch Response View…');
    expect(titles['streamscope.showResponseBody']).toBe('Open Response Body in Editor');
    expect(titles['streamscope.showResponseHeaders']).toBe('Open Response Headers in Editor');
  });

  it('puts Show Response on response documents and the run actions on the response panel', () => {
    expect(
      manifest.contributes.menus['editor/title']?.map(({ command, when }) => [command, when]),
    ).toEqual([
      ['streamscope.showResponse', 'resourceScheme == streamscope-response'],
      [
        'streamscope.showResponseHeaders',
        'resourceScheme == streamscope-response && !(resourceFilename =~ /\\.headers\\.http$/)',
      ],
      [
        'streamscope.showResponseBody',
        'resourceScheme == streamscope-response && resourceFilename =~ /\\.headers\\.http$/',
      ],
      ['streamscope.saveResponse', 'resourceScheme == streamscope-response'],
      ['streamscope.stopRequest', "activeWebviewPanelId == 'streamscope.response'"],
      ['streamscope.saveResponse', "activeWebviewPanelId == 'streamscope.response'"],
      ['streamscope.showResponseBody', "activeWebviewPanelId == 'streamscope.response'"],
    ]);
  });

  it('declares limited support for restricted and virtual workspaces', () => {
    expect(manifest.capabilities).toEqual({
      untrustedWorkspaces: {
        supported: 'limited',
        description: expect.stringMatching(/\S/) as unknown,
        restrictedConfigurations: [
          'streamscope.request.caFile',
          'streamscope.stream.maxEventSize',
          'streamscope.stream.memoryEvents',
        ],
      },
      virtualWorkspaces: {
        supported: 'limited',
        description: expect.stringMatching(/\S/) as unknown,
      },
    });
    expect(manifest.scripts['test:restricted']).toBe(
      'npm run build && npm run compile:host-tests && node scripts/run-restricted-tests.mjs',
    );
  });
});
