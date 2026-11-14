import * as assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

interface ItemState {
  id: string;
  label: string;
  error: string | undefined;
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

function runFileNotices(): Thenable<string[]> {
  return vscode.commands.executeCommand<string[]>('streamscope.test.runFileNotices');
}

function testReports(): Thenable<unknown[]> {
  return vscode.commands.executeCommand<unknown[]>('streamscope.test.testReports');
}

function workspaceUri(...segments: string[]): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'the workspace test needs a folder');
  return vscode.Uri.joinPath(folder.uri, ...segments);
}

describe('testing view discovery', () => {
  const created = (): vscode.Uri => workspaceUri('created.http');
  const big = (): vscode.Uri => workspaceUri('big.http');
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
    rmSync(big().fsPath, { force: true });
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

  it('clears a file error once the file reads again', async () => {
    await resolveTests();
    const uri = big();
    writeFileSync(uri.fsPath, `# ${'x'.repeat(1_048_574)}\n`);
    await waitFor(async () => (await testItems(uri)).length === 1, 'the big file never appeared');

    await resolveTests(uri);
    let item = (await testItems(uri))[0];
    assert.equal(
      item?.error,
      'This file is larger than 1 MiB, so Streamscope does not list its requests.',
    );
    assert.deepEqual(item.children, []);

    writeFileSync(uri.fsPath, 'GET https://api.example.test/big\n');
    await waitFor(
      async () => (await testItems(uri))[0]?.children.length === 1,
      'the rewritten file never listed its request',
    );
    item = (await testItems(uri))[0];
    assert.equal(item?.error, undefined);
  });
});

describe('Run File in a workspace', () => {
  before(async () => {
    await vscode.extensions.getExtension('achrafelkhnissi.streamscope')?.activate();
  });

  it('refuses Run File for a file outside the workspace', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'streamscope-outside-'));
    const file = vscode.Uri.file(path.join(outside, 'outside.http'));
    writeFileSync(file.fsPath, 'GET https://api.example.test/outside\n');
    try {
      await runFileNotices();
      await testReports();

      await vscode.commands.executeCommand('streamscope.runFile', file);

      assert.deepEqual(await runFileNotices(), [
        'Run File runs .http files in this workspace or untitled ones.',
      ]);
      assert.deepEqual(await testReports(), []);
      assert.ok(
        !vscode.workspace.textDocuments.some(({ uri }) => uri.toString() === file.toString()),
        'Run File opened the file',
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
