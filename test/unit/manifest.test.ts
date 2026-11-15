import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Manifest {
  scripts: Record<string, string>;
  activationEvents?: string[];
  capabilities: unknown;
  name: string;
  publisher: string;
  displayName: string;
  license: string;
  repository: { type: string; url: string };
  bugs: { url: string };
  homepage: string;
  version: string;
  icon: string;
  pricing: string;
  preview: boolean;
  galleryBanner: { color: string; theme: string };
  categories: string[];
  keywords: string[];
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

const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const changelog = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
const trial = readFileSync(new URL('../../docs/team-trial.md', import.meta.url), 'utf8');

function defaultText(value: unknown): string {
  if (Array.isArray(value)) {
    return `\`${JSON.stringify(value)}\``;
  }
  return value === '' ? '`""`' : `\`${String(value)}\``;
}

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

  it('activates for a restored response document so its tab can be closed', () => {
    expect(manifest.activationEvents).toEqual([
      'onFileSystem:streamscope-response',
      'workspaceContains:**/*.http',
      'workspaceContains:**/*.rest',
    ]);
  });

  it('activates in workspaces with .http or .rest files', () => {
    expect(manifest.activationEvents).toContain('workspaceContains:**/*.http');
    expect(manifest.activationEvents).toContain('workspaceContains:**/*.rest');
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

  it('ships the bundle, format and capture workers, response page, language files, changelog, license and third-party notices', () => {
    expect(manifest.files).toEqual([
      'dist/extension.js',
      'dist/format-worker.js',
      'dist/capture-worker.js',
      'dist/response-view.js',
      'syntaxes/http.tmLanguage.json',
      'language-configuration.json',
      'CHANGELOG.md',
      'LICENSE',
      'ThirdPartyNotices.txt',
      'images/icon.png',
    ]);
  });

  it('ships a 256×256 PNG icon', () => {
    expect(manifest.icon).toBe('images/icon.png');
    const icon = readFileSync(new URL(`../../${manifest.icon}`, import.meta.url));
    expect([...icon.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(icon.toString('latin1', 12, 16)).toBe('IHDR');
    expect([icon.readUInt32BE(16), icon.readUInt32BE(20)]).toEqual([256, 256]);
  });

  it('carries the Marketplace listing fields', () => {
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.pricing).toBe('Free');
    expect(manifest.preview).toBe(true);
    expect(manifest.galleryBanner.color).toMatch(/^#[0-9A-F]{6}$/);
    expect(['dark', 'light']).toContain(manifest.galleryBanner.theme);
    expect(manifest.categories).toEqual(['Programming Languages', 'Testing', 'Other']);
    expect(manifest.keywords).toEqual([
      'http',
      'rest',
      'rest client',
      'api',
      'sse',
      'server-sent events',
      'ndjson',
      'streaming',
      'llm',
      'agent',
      'ag-ui',
      'api testing',
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
      'streamscope.showHistory',
      'streamscope.captureValue',
      'streamscope.runFile',
    ]);
  });

  it('contributes Run File for http editors', () => {
    expect(
      manifest.contributes.commands.find(({ command }) => command === 'streamscope.runFile'),
    ).toEqual({
      command: 'streamscope.runFile',
      title: 'Run File',
      category: 'Streamscope',
      icon: '$(run-all)',
    });
    expect(
      manifest.contributes.menus.commandPalette?.find(
        ({ command }) => command === 'streamscope.runFile',
      ),
    ).toEqual({ command: 'streamscope.runFile', when: 'editorLangId == http' });
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
          .filter(([name]) => !/^streamscope\.(stream|view|capture)\./.test(name))
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

  it('contributes the capture wait timeout as a window duration setting', () => {
    const property =
      manifest.contributes.configuration.properties['streamscope.capture.waitTimeout'];

    expect(property).toMatchObject({
      type: 'string',
      default: '30s',
      pattern: '^\\d+(ms|s|m)$',
      scope: 'window',
    });
    expect(property?.markdownDescription).toMatch(
      /^How long a request waits for a captured value that has not arrived yet\./,
    );
    const pattern = new RegExp(property?.pattern ?? '');
    expect(['500ms', '30s', '5m'].map((value) => pattern.test(value))).toEqual([true, true, true]);
    expect(['30 s', '30', '1h'].map((value) => pattern.test(value))).toEqual([false, false, false]);
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
    expect(palette['streamscope.captureValue']).toBe(
      "resourceScheme == streamscope-response || activeWebviewPanelId == 'streamscope.response'",
    );
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
    expect(titles['streamscope.showHistory']).toBe('Show History');
    expect(titles['streamscope.showResponseBody']).toBe('Open Response Body in Editor');
    expect(titles['streamscope.showResponseHeaders']).toBe('Open Response Headers in Editor');
  });

  it('offers Capture This Value in the context menu of event and Body documents', () => {
    const titles = Object.fromEntries(
      manifest.contributes.commands.map(({ command, title }) => [command, title]),
    );

    expect(titles['streamscope.captureValue']).toBe('Capture This Value…');
    expect(manifest.contributes.menus['editor/context']).toEqual([
      {
        command: 'streamscope.captureValue',
        when: 'resourceScheme == streamscope-response && !(resourceFilename =~ /\\.headers\\.http$/)',
        group: 'streamscope@1',
      },
    ]);
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
      [
        'streamscope.stopRequest',
        "activeWebviewPanelId == 'streamscope.response' && !streamscope.responseReadOnly",
      ],
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
          'streamscope.stream.typeFields',
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

describe('README and changelog', () => {
  it('states in the changelog exactly which values are masked and dropped on redirects', () => {
    expect(changelog).not.toContain('drop any header that carries a secret');
    expect(changelog).toContain('Credentials written in a URL query string are not masked');
    expect(changelog).toContain(
      'redirects to another origin drop credential headers and any header that contains one of those values',
    );
  });

  it('tells testers how to report a secret and what to keep out of the public results', () => {
    expect(trial).toContain('say where it showed, never the value');
    expect(trial).toContain('rotate the token');
    expect(trial).toContain('only public issue numbers or neutral summaries');
    expect(trial).toContain('the publisher is achrafelkhnissi');
  });

  it('documents # @stream ndjson for a first event that waits for the second line', () => {
    expect(readme).toMatch(/^\| `# @stream ndjson` +\|/m);
    expect(readme).toContain(
      'so a `first(…)` capture from its first line waits for that line; `# @stream ndjson` on the request reads it as NDJSON from the first line.',
    );
    expect(trial).toContain('Put `# @stream ndjson` on the request');
    expect(changelog).toContain('`# @stream`');
  });

  it('documents every setting in the README', () => {
    const rows = readme.split('\n').filter((line) => line.startsWith('| `streamscope.'));
    const { properties } = manifest.contributes.configuration;
    expect(rows).toHaveLength(Object.keys(properties).length);
    for (const [name, { default: value }] of Object.entries(properties)) {
      const row = rows.find((line) => line.startsWith(`| \`${name}\``));
      expect(row, name).toBeDefined();
      expect(row, name).toContain(defaultText(value));
    }
  });

  it('documents every command in the README', () => {
    for (const { title } of manifest.contributes.commands) {
      expect(readme, title).toContain(`**Streamscope: ${title}**`);
    }
  });

  it('links images through raw.githubusercontent.com over https', () => {
    const images = [...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)|<img[^>]*\ssrc="([^"]+)"/g)].map(
      (match) => match[1] ?? match[2] ?? '',
    );
    expect(images.length).toBeGreaterThanOrEqual(2);
    for (const url of images) {
      expect(url).toMatch(
        /^https:\/\/raw\.githubusercontent\.com\/achrafelkhnissi\/streamscope\/main\/images\/[a-z0-9-]+\.(gif|png)$/,
      );
    }
  });

  it('states the privacy promise and links the security policy', () => {
    expect(readme).toContain(
      'Streamscope sends no telemetry, needs no account, and makes no network requests except the ones you send.',
    );
    expect(readme).toContain('[SECURITY.md](SECURITY.md)');
  });

  it('has a dated 0.1.0 changelog section with only Added', () => {
    const start = changelog.search(/^## \[0\.1\.0\]/m);
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = changelog.slice(start + 1);
    const end = rest.search(/^## /m);
    const section = end === -1 ? rest : rest.slice(0, end);
    expect(section.match(/^### \w+$/gm)).toEqual(['### Added']);
    expect(changelog).toMatch(/^## \[0\.1\.0\] - \d{4}-\d{2}-\d{2}$/m);
    expect(changelog).toMatch(
      /^\[0\.1\.0\]: https:\/\/github\.com\/achrafelkhnissi\/streamscope\/releases\/tag\/v0\.1\.0$/m,
    );
  });
});
