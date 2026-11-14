import * as assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as vscode from 'vscode';

interface ItemState {
  id: string;
  label: string;
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
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function testItems(uri?: vscode.Uri): Thenable<ItemState[]> {
  return vscode.commands.executeCommand<ItemState[]>('streamscope.test.testItems', uri);
}

function resolveTests(uri?: vscode.Uri): Thenable<void> {
  return vscode.commands.executeCommand('streamscope.test.resolveTests', uri);
}

function workspaceUri(...segments: string[]): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'the workspace test needs a folder');
  return vscode.Uri.joinPath(folder.uri, ...segments);
}

describe('testing view discovery', () => {
  const created = (): vscode.Uri => workspaceUri('created.http');
  const dependency = (): vscode.Uri => workspaceUri('node_modules');

  before(async () => {
    await vscode.extensions.getExtension('achrafelkhnissi.streamscope')?.activate();
    mkdirSync(vscode.Uri.joinPath(dependency(), 'pkg').fsPath, { recursive: true });
    writeFileSync(
      vscode.Uri.joinPath(dependency(), 'pkg', 'example.http').fsPath,
      'GET https://api.example.test/dependency\n',
    );
  });

  after(() => {
    rmSync(created().fsPath, { force: true });
    rmSync(dependency().fsPath, { recursive: true, force: true });
  });

  it('discovers .http and .rest files without opening them, respecting files.exclude and skipping node_modules', async () => {
    await resolveTests();
    const labels = (await testItems()).map(({ label }) => label).sort();

    assert.deepEqual(labels, ['api/flow.http', 'notes/other.rest']);
    assert.ok(
      !vscode.workspace.textDocuments.some(({ uri }) => uri.path.endsWith('/api/flow.http')),
      'discovery opened a document',
    );
  });

  it("resolves a closed file's requests", async () => {
    const flow = workspaceUri('api', 'flow.http');
    await resolveTests();
    await resolveTests(flow);

    const item = (await testItems(flow))[0];
    const uri = flow.toString();
    assert.deepEqual(
      item?.children.map(({ id }) => id),
      [`${uri}\n@start`, `${uri}\n@continue`, `${uri}\n#2 GET {{baseUrl}}/status`],
    );
  });

  it('adds, updates and removes items as files are created, changed and deleted', async () => {
    await resolveTests();
    const uri = created();
    writeFileSync(uri.fsPath, 'GET https://api.example.test/one\n');
    await waitFor(
      async () => (await testItems(uri)).length === 1,
      'the created file never appeared',
    );

    await resolveTests(uri);
    writeFileSync(
      uri.fsPath,
      'GET https://api.example.test/one\n\n###\nGET https://api.example.test/two\n',
    );
    await waitFor(
      async () => (await testItems(uri))[0]?.children.length === 2,
      'the changed file never showed its second request',
    );

    rmSync(uri.fsPath);
    await waitFor(
      async () => (await testItems(uri)).length === 0,
      'the deleted file stayed in the tests',
    );
  });
});
