import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

const extensionId = 'achrafelkhnissi.streamscope';

const sample = [
  '@baseUrl = https://api.example.test',
  '',
  '# @name login',
  'POST {{baseUrl}}/login',
  '',
  '### List items',
  'GET {{baseUrl}}/items',
  '',
  '###',
  'GET https://api.example.test/health',
].join('\n');

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${String(timeoutMs)} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('http language features', () => {
  let folder = '';

  before(() => {
    folder = mkdtempSync(path.join(tmpdir(), 'streamscope-language-'));
  });

  after(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  async function open(name: string, content: string): Promise<vscode.TextDocument> {
    const file = path.join(folder, name);
    writeFileSync(file, content);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document);
    return document;
  }

  it('opens .http files as the http language and activates', async () => {
    const document = await open('sample.http', sample);

    assert.equal(document.languageId, 'http');
    await waitFor(() => vscode.extensions.getExtension(extensionId)?.isActive === true);
  });

  it('lists one symbol per request and file variable', async () => {
    const document = await open('symbols.http', sample);
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      document.uri,
    );

    assert.deepEqual(symbols.map((symbol) => symbol.name).sort(), [
      'GET https://api.example.test/health',
      'List items',
      'baseUrl',
      'login',
    ]);
  });

  it('never shows file variable values in the outline', async () => {
    const document = await open(
      'secrets.http',
      ['@token = synthetic-secret-value', 'GET https://api.example.test/me'].join('\n'),
    );
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      document.uri,
    );
    const token = symbols.find((symbol) => symbol.name === 'token');

    assert.ok(token);
    assert.equal(token.detail, '');
  });

  it('folds each request', async () => {
    const document = await open('folding.http', sample);
    const ranges = await vscode.commands.executeCommand<vscode.FoldingRange[]>(
      'vscode.executeFoldingRangeProvider',
      document.uri,
    );

    assert.deepEqual(
      ranges.map((range) => [range.start, range.end]),
      [
        [0, 4],
        [5, 7],
        [8, 9],
      ],
    );
  });

  it('reports and clears syntax diagnostics', async () => {
    const document = await open(
      'diagnostics.http',
      ['@baseUrl = https://api.example.test', 'GET {{baseUrl/items'].join('\n'),
    );

    await waitFor(() => vscode.languages.getDiagnostics(document.uri).length === 1);
    const [diagnostic] = vscode.languages.getDiagnostics(document.uri);
    assert.equal(diagnostic?.code, 'unclosed-variable');
    assert.equal(diagnostic.source, 'Streamscope');

    const editor = vscode.window.activeTextEditor;
    assert.ok(editor);
    await editor.edit((builder) => {
      builder.insert(new vscode.Position(1, 13), '}}');
    });
    await waitFor(() => vscode.languages.getDiagnostics(document.uri).length === 0);
  });

  it('ignores http documents from other schemes', async () => {
    const provider = vscode.workspace.registerTextDocumentContentProvider('streamscope-test', {
      provideTextDocumentContent: () => 'GET {{unclosed',
    });
    try {
      const uri = vscode.Uri.parse('streamscope-test:/broken.http');
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
      await new Promise((resolve) => setTimeout(resolve, 500));

      assert.equal(document.languageId, 'http');
      assert.deepEqual(vscode.languages.getDiagnostics(uri), []);
    } finally {
      provider.dispose();
    }
  });

  async function hoverText(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<string> {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      position,
    );
    return hovers
      .flatMap((hover) => hover.contents)
      .map((content) => (content instanceof vscode.MarkdownString ? content.value : ''))
      .join('\n')
      .replace(/&nbsp;/g, ' ');
  }

  async function completionLabels(
    document: vscode.TextDocument,
    position: vscode.Position,
    trigger: string,
  ): Promise<string[]> {
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      document.uri,
      position,
      trigger,
    );
    return list.items.map((item) =>
      typeof item.label === 'string' ? item.label : item.label.label,
    );
  }

  it('shows the resolved value and its source on hover', async () => {
    const document = await open(
      'hover.http',
      ['@host = api.example.test', 'GET https://{{host}}/items'].join('\n'),
    );

    const text = await hoverText(document, new vscode.Position(1, 15));

    assert.ok(text.includes('api.example.test'), text);
    assert.ok(text.includes('file variable'), text);
  });

  it('masks a credential-named value on hover', async () => {
    const document = await open(
      'hover-secret.http',
      ['@apiToken = synthetic-token', 'GET https://api.example.test/{{apiToken}}'].join('\n'),
    );

    const text = await hoverText(document, new vscode.Position(1, 32));

    assert.ok(!text.includes('synthetic-token'), text);
    assert.ok(text.includes('••••••'), text);
  });

  it('completes file and system variables after {{', async () => {
    const document = await open(
      'complete.http',
      ['@base = https://api.example.test', 'GET {{'].join('\n'),
    );

    const labels = await completionLabels(document, new vscode.Position(1, 6), '{');

    assert.ok(labels.includes('base'), labels.join(', '));
    assert.ok(labels.includes('$guid'), labels.join(', '));
    assert.ok(labels.includes('$secret'), labels.join(', '));
  });

  it('completes directives after # @', async () => {
    const document = await open(
      'directives.http',
      ['# @', 'GET https://api.example.test/items'].join('\n'),
    );

    const labels = await completionLabels(document, new vscode.Position(0, 3), '@');

    assert.ok(labels.includes('name'), labels.join(', '));
    assert.ok(labels.includes('timeout'), labels.join(', '));
  });

  it('warns about an undefined variable and clears the warning when an environment defines it', async () => {
    const environmentFile = path.join(folder, 'http-client.env.json');
    const document = await open('undefined.http', 'GET https://api.example.test/{{envOnly}}');
    try {
      await waitFor(() =>
        vscode.languages
          .getDiagnostics(document.uri)
          .some((diagnostic) => diagnostic.code === 'undefined-variable'),
      );
      const [warning] = vscode.languages.getDiagnostics(document.uri);
      assert.equal(warning?.severity, vscode.DiagnosticSeverity.Warning);

      writeFileSync(environmentFile, JSON.stringify({ dev: { envOnly: 'value' } }));
      await vscode.commands.executeCommand('streamscope.selectEnvironment', 'dev');

      await waitFor(() => vscode.languages.getDiagnostics(document.uri).length === 0);
    } finally {
      await vscode.commands.executeCommand('streamscope.selectEnvironment', '');
      rmSync(environmentFile, { force: true });
    }
  });

  it('moves a literal credential into secret storage', async () => {
    const document = await open(
      'move.http',
      ['@integrationMoveToken = synthetic-token', 'GET https://api.example.test/items'].join('\n'),
    );
    try {
      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        'vscode.executeCodeActionProvider',
        document.uri,
        new vscode.Range(0, 2, 0, 2),
      );
      const move = actions.find((action) => action.title === 'Move to secret storage');
      assert.ok(move?.command, 'the quick fix is missing');

      const commandArguments: unknown[] = move.command.arguments ?? [];
      await vscode.commands.executeCommand(move.command.command, ...commandArguments);

      assert.equal(
        document.lineAt(0).text,
        '@integrationMoveToken = {{$secret integrationMoveToken}}',
      );
      const names = await vscode.commands.executeCommand<string[]>('streamscope.listSecrets');
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      assert.ok(names.includes('integrationMoveToken'));
    } finally {
      await vscode.commands.executeCommand('streamscope.clearSecret', 'integrationMoveToken');
    }
  });

  it('hides URL passwords on hover', async () => {
    const document = await open(
      'hover-url.http',
      ['@base = https://user:synthetic-password@api.example.test', 'GET {{base}}/items'].join('\n'),
    );

    const text = await hoverText(document, new vscode.Position(1, 7));

    assert.ok(!text.includes('synthetic-password'), text);
  });

  it('shows hovered values as plain text', async () => {
    const document = await open(
      'hover-markdown.http',
      [
        '@note = ![x](https://tracker.example.test/pixel)',
        'GET https://api.example.test/{{note}}',
      ].join('\n'),
    );

    const text = await hoverText(document, new vscode.Position(1, 32));

    assert.ok(text.includes('tracker'), text);
    assert.ok(!text.includes('![x]('), text);
  });

  it('replaces the typed part of a directive when completing it', async () => {
    const document = await open(
      'directive-range.http',
      ['# @no-', 'GET https://api.example.test/items'].join('\n'),
    );

    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      document.uri,
      new vscode.Position(0, 6),
    );
    const item = list.items.find((entry) => entry.label === 'no-redirect');
    assert.ok(item, 'no-redirect is not offered');
    const range = item.range instanceof vscode.Range ? item.range : item.range?.replacing;
    assert.equal(range?.start.character, 3);
    assert.equal(range.end.character, 6);
  });
});
