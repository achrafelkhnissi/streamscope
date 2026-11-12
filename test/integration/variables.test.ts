import * as assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
    await vscode.commands.executeCommand('streamscope.clearSecret', 'integrationBodyToken');
    await vscode.commands.executeCommand('streamscope.clearSecret', 'integrationEscapedToken');
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

  it('keeps sending and checking when .env and the environment file are folders', async () => {
    const venv = path.join(folder, 'venv');
    mkdirSync(path.join(venv, '.env'), { recursive: true });
    mkdirSync(path.join(venv, 'http-client.env.json'));
    const sendFile = path.join(venv, 'plain.http');
    writeFileSync(sendFile, `GET ${server.url}/plain`);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sendFile));
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    const before = server.requests.length;

    await vscode.commands.executeCommand('streamscope.sendRequest');

    assert.equal(server.requests.length, before + 1);
    const broken = path.join(venv, 'broken.http');
    writeFileSync(broken, 'GET {{broken');
    const brokenDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(broken));
    await vscode.window.showTextDocument(brokenDocument, vscode.ViewColumn.One);
    const deadline = Date.now() + 3000;
    while (
      vscode.languages.getDiagnostics(brokenDocument.uri).length === 0 &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(vscode.languages.getDiagnostics(brokenDocument.uri)[0]?.code, 'unclosed-variable');
  });

  it('sends a stored secret used only inside a <@ body file', async () => {
    await vscode.commands.executeCommand(
      'streamscope.setSecret',
      'integrationBodyToken',
      'synthetic-body-secret',
    );
    writeFileSync(path.join(folder, 'body.json'), '{"token":"{{$secret integrationBodyToken}}"}');

    await send('body-secret.http', [`POST ${server.url}/body`, '', '<@ ./body.json']);

    assert.equal(
      server.requests[server.requests.length - 1]?.body.toString(),
      '{"token":"synthetic-body-secret"}\n',
    );
  });

  it('stores the unescaped value when moving a credential into secret storage', async () => {
    const file = path.join(folder, 'move-escaped.http');
    writeFileSync(
      file,
      [
        String.raw`@integrationEscapedToken = synthetic\-token`,
        `GET ${server.url}/{{integrationEscapedToken}}`,
      ].join('\n'),
    );
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);

    await vscode.commands.executeCommand('streamscope.moveToSecretStorage', document.uri, 0);
    assert.equal(
      document.lineAt(0).text,
      '@integrationEscapedToken = {{$secret integrationEscapedToken}}',
    );
    await vscode.window.showTextDocument(document, { selection: new vscode.Range(1, 0, 1, 0) });
    await vscode.commands.executeCommand('streamscope.sendRequest');

    assert.equal(server.requests[server.requests.length - 1]?.url, '/synthetic-token');
  });
});
