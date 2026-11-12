import * as assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { headerPairs } from '../support/headers';
import { startHttpServer, type LocalServer } from '../support/servers';
import { removeTemporaryFolder } from './temporary-folder';

const responseScheme = 'streamscope-response';

describe('sending with every variable source', () => {
  let folder = '';
  let server: LocalServer;

  async function send(name: string, lines: string[]): Promise<vscode.Uri> {
    const file = path.join(folder, name);
    writeFileSync(file, lines.join('\n'));
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    await vscode.commands.executeCommand('streamscope.sendRequest');
    return document.uri;
  }

  async function outcome(uri: vscode.Uri): Promise<string> {
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider',
      uri,
    );
    return lenses[1]?.command?.title ?? '';
  }

  before(async () => {
    folder = mkdtempSync(path.join(tmpdir(), 'streamscope-variables-'));
    server = await startHttpServer((_request, response) => {
      response.end('ok');
    });
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  after(async () => {
    await vscode.commands.executeCommand('streamscope.clearSecret', 'integrationApiToken');
    await server.close();
    removeTemporaryFolder(folder);
  });

  it('sends a stored secret and masks it in the Headers view and the outcome', async () => {
    await vscode.commands.executeCommand(
      'streamscope.setSecret',
      'integrationApiToken',
      'synthetic-secret-value',
    );

    const uri = await send('secret.http', [
      `GET ${server.url}/secret`,
      'Authorization: Bearer {{$secret integrationApiToken}}',
      'X-Echo: {{$secret integrationApiToken}}',
    ]);
    await vscode.commands.executeCommand('streamscope.showResponseHeaders');

    const recorded = headerPairs(server.requests[server.requests.length - 1]?.rawHeaders ?? []);
    assert.deepEqual(
      recorded.find(([name]) => name === 'X-Echo'),
      ['X-Echo', 'synthetic-secret-value'],
    );
    const headersUri = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .flatMap((tab) =>
        tab.input instanceof vscode.TabInputText &&
        tab.input.uri.scheme === responseScheme &&
        tab.input.uri.path.endsWith('.headers.http')
          ? [tab.input.uri]
          : [],
      )[0];
    assert.ok(headersUri);
    const headers = Buffer.from(await vscode.workspace.fs.readFile(headersUri)).toString();
    assert.ok(!headers.includes('synthetic-secret-value'));
    assert.ok(headers.includes('X-Echo: ••••••'));
    assert.ok(!(await outcome(uri)).includes('synthetic-secret-value'));
  });

  it('sends a .env value found next to the file', async () => {
    writeFileSync(path.join(folder, '.env'), 'API_PATH=from-dotenv\n');

    await send('dotenv.http', [`GET ${server.url}/{{$dotenv API_PATH}}`]);

    assert.equal(server.requests[server.requests.length - 1]?.url, '/from-dotenv');
  });

  it('sends a process variable', async () => {
    process.env.STREAMSCOPE_TEST_VALUE = 'from-process';
    try {
      await send('process.http', [`GET ${server.url}/{{$processEnv STREAMSCOPE_TEST_VALUE}}`]);
    } finally {
      delete process.env.STREAMSCOPE_TEST_VALUE;
    }

    assert.equal(server.requests[server.requests.length - 1]?.url, '/from-process');
  });

  it('does not send when a process variable is unset', async () => {
    const before = server.requests.length;

    const uri = await send('unset.http', [
      `GET ${server.url}/{{$processEnv STREAMSCOPE_UNSET_VALUE}}`,
    ]);

    assert.equal(server.requests.length, before);
    assert.match(await outcome(uri), /^Not sent: /);
  });
});
