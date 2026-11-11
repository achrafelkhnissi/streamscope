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
    const document = await open('diagnostics.http', 'GET {{baseUrl/items');

    await waitFor(() => vscode.languages.getDiagnostics(document.uri).length === 1);
    const [diagnostic] = vscode.languages.getDiagnostics(document.uri);
    assert.equal(diagnostic?.code, 'unclosed-variable');
    assert.equal(diagnostic.source, 'Streamscope');

    const editor = vscode.window.activeTextEditor;
    assert.ok(editor);
    await editor.edit((builder) => {
      builder.insert(new vscode.Position(0, 13), '}}');
    });
    await waitFor(() => vscode.languages.getDiagnostics(document.uri).length === 0);
  });
});
