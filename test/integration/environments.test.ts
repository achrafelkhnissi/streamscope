import * as assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { startHttpServer, type LocalServer } from '../support/servers';
import { removeTemporaryFolder } from './temporary-folder';

describe('environments', () => {
  let folder = '';
  let server: LocalServer;

  async function sendFrom(name: string, lines: string[]): Promise<string | undefined> {
    const file = path.join(folder, name);
    writeFileSync(file, lines.join('\n'));
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    const before = server.requests.length;
    await vscode.commands.executeCommand('streamscope.sendRequest');
    return server.requests.length > before
      ? server.requests[server.requests.length - 1]?.url
      : undefined;
  }

  before(async () => {
    folder = mkdtempSync(path.join(tmpdir(), 'streamscope-environments-'));
    server = await startHttpServer((_request, response) => {
      response.end('ok');
    });
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('streamscope.selectEnvironment', '');
  });

  after(async () => {
    await server.close();
    removeTemporaryFolder(folder);
  });

  it('uses the environment selected for the workspace', async () => {
    writeFileSync(
      path.join(folder, 'http-client.env.json'),
      JSON.stringify({ dev: { path: 'dev-path' }, prod: { path: 'prod-path' } }),
    );
    const lines = [`GET ${server.url}/{{path}}`];

    await vscode.commands.executeCommand('streamscope.selectEnvironment', 'dev');
    assert.equal(await sendFrom('select.http', lines), '/dev-path');
    await vscode.commands.executeCommand('streamscope.selectEnvironment', 'prod');
    assert.equal(await sendFrom('select.http', lines), '/prod-path');
  });

  it('lets the private file override the public file', async () => {
    writeFileSync(
      path.join(folder, 'http-client.env.json'),
      JSON.stringify({ dev: { path: 'public-path' } }),
    );
    writeFileSync(
      path.join(folder, 'http-client.private.env.json'),
      JSON.stringify({ dev: { path: 'private-path' } }),
    );

    await vscode.commands.executeCommand('streamscope.selectEnvironment', 'dev');
    assert.equal(await sendFrom('private.http', [`GET ${server.url}/{{path}}`]), '/private-path');
    removeTemporaryFolder(path.join(folder, 'http-client.private.env.json'));
  });

  it('picks up an edited environment file on the next send', async () => {
    const environmentFile = path.join(folder, 'http-client.env.json');
    writeFileSync(environmentFile, JSON.stringify({ dev: { path: 'first' } }));
    await vscode.commands.executeCommand('streamscope.selectEnvironment', 'dev');
    assert.equal(await sendFrom('edit.http', [`GET ${server.url}/{{path}}`]), '/first');

    writeFileSync(environmentFile, JSON.stringify({ dev: { path: 'second-value' } }));
    assert.equal(await sendFrom('edit.http', [`GET ${server.url}/{{path}}`]), '/second-value');
  });

  it('uses $shared when no environment is selected', async () => {
    writeFileSync(
      path.join(folder, 'http-client.env.json'),
      JSON.stringify({ $shared: { path: 'shared-path' }, dev: { path: 'dev-path' } }),
    );

    assert.equal(await sendFrom('shared.http', [`GET ${server.url}/{{path}}`]), '/shared-path');
  });
});
