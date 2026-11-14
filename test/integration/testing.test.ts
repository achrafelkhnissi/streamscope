import * as assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { removeTemporaryFolder } from './temporary-folder';

interface ItemState {
  id: string;
  label: string;
  description: string | undefined;
  sortText: string | undefined;
  range: [number, number] | undefined;
  children: ItemState[];
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`${what} within ${String(timeoutMs)} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function testItems(uri?: vscode.Uri): Thenable<ItemState[]> {
  return vscode.commands.executeCommand<ItemState[]>('streamscope.test.testItems', uri);
}

async function fileItem(uri: vscode.Uri): Promise<ItemState | undefined> {
  return (await testItems(uri))[0];
}

describe('testing view items', () => {
  let folder = '';

  before(() => {
    folder = mkdtempSync(path.join(tmpdir(), 'streamscope-testing-'));
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  after(() => {
    removeTemporaryFolder(folder);
  });

  async function open(name: string, lines: readonly string[]) {
    const file = path.join(folder, name);
    writeFileSync(file, [...lines, ''].join('\n'));
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    return { document, editor, uri: document.uri };
  }

  const flowLines = [
    '@baseUrl = https://api.example.test',
    '',
    '### Start',
    '# @name start',
    'POST {{baseUrl}}/agent/run',
    '',
    '### Continue',
    'POST {{baseUrl}}/agent/continue',
    '',
    '###',
    'GET {{baseUrl}}/status',
  ];

  it('lists an open .http file with one test per request, in file order, with ranges', async () => {
    const opened = await open('flow.http', flowLines);
    await waitFor(
      async () => (await fileItem(opened.uri))?.children.length === 3,
      'the requests never appeared',
    );
    const item = await fileItem(opened.uri);
    assert.ok(item);
    assert.equal(item.id, opened.uri.toString());
    const uri = opened.uri.toString();
    assert.deepEqual(
      item.children.map(({ id, label, description, sortText, range }) => ({
        id,
        label,
        description,
        sortText,
        range,
      })),
      [
        {
          id: `${uri}\n@start`,
          label: 'start',
          description: 'POST {{baseUrl}}/agent/run',
          sortText: '00000',
          range: [2, 5],
        },
        {
          id: `${uri}\n#1 POST {{baseUrl}}/agent/continue`,
          label: 'Continue',
          description: 'POST {{baseUrl}}/agent/continue',
          sortText: '00001',
          range: [6, 8],
        },
        {
          id: `${uri}\n#2 GET {{baseUrl}}/status`,
          label: 'GET {{baseUrl}}/status',
          description: undefined,
          sortText: '00002',
          range: [9, 11],
        },
      ],
    );
  });

  it('updates the tests when the file changes', async () => {
    const opened = await open('edited.http', flowLines);
    await waitFor(
      async () => (await fileItem(opened.uri))?.children.length === 3,
      'the requests never appeared',
    );
    const uri = opened.uri.toString();

    await opened.editor.edit((edit) => {
      edit.insert(new vscode.Position(2, 0), '### Health\nGET {{baseUrl}}/health\n\n');
    });
    await waitFor(
      async () => (await fileItem(opened.uri))?.children.length === 4,
      'the inserted request never appeared',
    );
    let ids = (await fileItem(opened.uri))?.children.map(({ id }) => id) ?? [];
    assert.deepEqual(ids, [
      `${uri}\n#0 GET {{baseUrl}}/health`,
      `${uri}\n@start`,
      `${uri}\n#2 POST {{baseUrl}}/agent/continue`,
      `${uri}\n#3 GET {{baseUrl}}/status`,
    ]);

    const line = opened.document.getText().split('\n').indexOf('GET {{baseUrl}}/status');
    await opened.editor.edit((edit) => {
      edit.replace(new vscode.Range(line, 4, line, 22), '{{baseUrl}}/ready');
    });
    await waitFor(
      async () =>
        (await fileItem(opened.uri))?.children.some(({ id }) => id.endsWith('/ready')) === true,
      'the changed URL never reached the item',
    );
    ids = (await fileItem(opened.uri))?.children.map(({ id }) => id) ?? [];
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.includes(`${uri}\n#3 GET {{baseUrl}}/ready`));
  });

  it('gives a duplicate @name its own item', async () => {
    const opened = await open('duplicate.http', [
      '# @name same',
      'GET https://api.example.test/one',
      '',
      '###',
      '# @name same',
      'GET https://api.example.test/two',
    ]);
    await waitFor(
      async () => (await fileItem(opened.uri))?.children.length === 2,
      'the requests never appeared',
    );
    const uri = opened.uri.toString();
    assert.deepEqual(
      (await fileItem(opened.uri))?.children.map(({ id }) => id),
      [`${uri}\n@same`, `${uri}\n@same\n#1`],
    );
  });

  it('lists an untitled http document', async () => {
    const document = await vscode.workspace.openTextDocument({
      language: 'http',
      content: 'GET https://api.example.test/untitled\n',
    });
    await vscode.window.showTextDocument(document);
    await waitFor(
      async () => (await fileItem(document.uri))?.children.length === 1,
      'the untitled request never appeared',
    );
  });

  it('removes an item when its document closes', async () => {
    const opened = await open('closing.http', ['GET https://api.example.test/closing']);
    await waitFor(
      async () => (await fileItem(opened.uri)) !== undefined,
      'the file never appeared',
    );

    await vscode.languages.setTextDocumentLanguage(opened.document, 'plaintext');

    await waitFor(
      async () => (await fileItem(opened.uri)) === undefined,
      'the file item stayed after its document closed',
    );
  });
});
