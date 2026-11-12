import * as assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type * as http from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import * as vscode from 'vscode';
import { createSelfSignedCertificate } from '../support/certificate';
import { startHttpServer, startHttpsServer, type LocalServer } from '../support/servers';

const responseScheme = 'streamscope-response';

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${String(timeoutMs)} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function responseTabs(): vscode.Uri[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .flatMap((tab) =>
      tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === responseScheme
        ? [tab.input.uri]
        : [],
    );
}

async function text(uri: vscode.Uri): Promise<string> {
  return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
}

async function lensTitles(uri: vscode.Uri): Promise<string[]> {
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
    'vscode.executeCodeLensProvider',
    uri,
  );
  return lenses.map((lens) => lens.command?.title ?? '');
}

async function firstLensEventually(uri: vscode.Uri, expected: string): Promise<string> {
  const deadline = Date.now() + 3000;
  let first = '';
  while (Date.now() < deadline) {
    first = (await lensTitles(uri))[0] ?? '';
    if (first === expected) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return first;
}

function send(): Thenable<unknown> {
  return vscode.commands.executeCommand('streamscope.sendRequest');
}

describe('sending requests', () => {
  let folder = '';
  const servers: LocalServer[] = [];

  async function serve(handler: http.RequestListener): Promise<LocalServer> {
    const server = await startHttpServer(handler);
    servers.push(server);
    return server;
  }

  async function open(name: string, lines: string[]): Promise<vscode.TextEditor> {
    const file = path.join(folder, name);
    writeFileSync(file, lines.join('\n'));
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    return vscode.window.showTextDocument(document, vscode.ViewColumn.One);
  }

  before(() => {
    folder = mkdtempSync(path.join(tmpdir(), 'streamscope-send-'));
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  after(() => {
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('sends the request under the cursor and shows the pretty body', async () => {
    const server = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"items":[1,2]}');
    });
    await open('pretty.http', [`GET ${server.url}/items`]);

    await send();

    const body = responseTabs().find((uri) => uri.path.endsWith('.json'));
    assert.ok(body, 'the body document is not open');
    assert.equal(await text(body), '{\n  "items": [\n    1,\n    2\n  ]\n}');
  });

  it('shows status, masked request headers and timing in the Headers view', async () => {
    const server = await serve((_request, response) => {
      response.end('ok');
    });
    await open('headers.http', [`GET ${server.url}/me`, 'Authorization: Bearer synthetic-token']);

    await send();
    await vscode.commands.executeCommand('streamscope.showResponseHeaders');

    const headers = responseTabs().find((uri) => uri.path.endsWith('.headers.http'));
    assert.ok(headers, 'the Headers document is not open');
    const content = await text(headers);
    assert.match(content, /^HTTP\/1\.1 200 OK\n/);
    assert.ok(content.includes('Authorization: ••••••'));
    assert.ok(!content.includes('synthetic-token'));
    assert.ok(content.includes('### Timing'));
  });

  it('lists each redirect hop', async () => {
    const server = await serve((request, response) => {
      if (request.url === '/a') {
        response.writeHead(302, { Location: '/b' });
        response.end();
        return;
      }
      response.end('landed');
    });
    await open('redirects.http', [`GET ${server.url}/a`]);

    await send();
    await vscode.commands.executeCommand('streamscope.showResponseHeaders');

    const headers = responseTabs().find((uri) => uri.path.endsWith('.headers.http'));
    assert.ok(headers);
    assert.ok((await text(headers)).includes(`### Redirects\nGET ${server.url}/a → 302 Found`));
  });

  it('shows Send, then the outcome, in the CodeLens', async () => {
    const server = await serve((_request, response) => {
      response.end('ok');
    });
    const editor = await open('lens.http', [`GET ${server.url}/lens`]);

    assert.deepEqual(await lensTitles(editor.document.uri), ['Send Request']);
    await send();

    const titles = await lensTitles(editor.document.uri);
    assert.equal(titles[0], 'Send Request');
    assert.match(titles[1] ?? '', /^200 OK · 2 B · /);
  });

  it('stops a running request and closes its socket', async () => {
    const server = await serve((_request, response) => {
      response.writeHead(200);
      response.write('partial');
    });
    const editor = await open('stop.http', [`GET ${server.url}/hold`]);

    const sending = send();
    await waitFor(() => server.requests.length === 1);
    assert.equal(await firstLensEventually(editor.document.uri, 'Stop'), 'Stop');
    await vscode.commands.executeCommand('streamscope.stopRequest');
    await sending;

    await waitFor(() => server.sockets.closed === server.sockets.opened);
    assert.match((await lensTitles(editor.document.uri))[1] ?? '', /^Cancelled after /);
  });

  it('does not send a request with an undefined variable', async () => {
    const server = await serve((_request, response) => {
      response.end('should not be reached');
    });
    const editor = await open('blocked.http', [`GET ${server.url}/{{missing}}`]);

    await send();

    assert.equal(server.requests.length, 0);
    assert.equal(server.sockets.opened, 0);
    assert.match((await lensTitles(editor.document.uri))[1] ?? '', /^Not sent: /);
  });

  it('re-sending replaces the response in the same tab', async () => {
    let count = 0;
    const server = await serve((_request, response) => {
      count += 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ count }));
    });
    await open('resend.http', [`GET ${server.url}/count`]);

    await send();
    await send();

    const bodies = responseTabs().filter((uri) => uri.path.endsWith('.json'));
    assert.equal(bodies.length, 1);
    const [body] = bodies;
    assert.ok(body);
    assert.equal(await text(body), '{\n  "count": 2\n}');
  });

  it('saves the raw decoded body', async () => {
    const json = '{"saved":true}';
    const server = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
      response.end(zlib.gzipSync(json));
    });
    await open('save.http', [`GET ${server.url}/save`]);
    const target = vscode.Uri.file(path.join(folder, 'saved.json'));

    await send();
    await vscode.commands.executeCommand('streamscope.saveResponse', target);

    assert.equal(readFileSync(target.fsPath, 'utf8'), json);
  });

  it('saves the response whose document the Save button was pressed in', async () => {
    const server = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"from":"title"}');
    });
    await open('save-title.http', [`GET ${server.url}/title`]);
    const target = vscode.Uri.file(path.join(folder, 'from-title.json'));

    await send();
    const body = responseTabs().find((uri) => uri.path.endsWith('.json'));
    assert.ok(body);
    await vscode.commands.executeCommand('streamscope.saveResponse', body, target);

    assert.equal(readFileSync(target.fsPath, 'utf8'), '{"from":"title"}');
  });

  it('keeps the newest response when an older one finishes formatting last', async function () {
    this.timeout(60_000);
    const large = Buffer.from(
      JSON.stringify({ items: Array.from({ length: 400_000 }, (_, id) => ({ id, first: true })) }),
    );
    let count = 0;
    const server = await serve((_request, response) => {
      count += 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(count === 1 ? large : '{"second":true}');
    });
    const editor = await open('stale.http', [`GET ${server.url}/stale`]);

    const first = send();
    const deadline = Date.now() + 10_000;
    while (
      !/^200 OK/.test((await lensTitles(editor.document.uri))[1] ?? '') &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const second = send();
    await Promise.all([first, second]);

    const body = responseTabs().find((uri) => uri.path.endsWith('.json'));
    assert.ok(body);
    assert.equal(await text(body), '{\n  "second": true\n}');
  });

  it('trusts the CA named in streamscope.request.caFile', async () => {
    const credentials = createSelfSignedCertificate(['localhost', '127.0.0.1']);
    const server = await startHttpsServer(credentials, (_request, response) => {
      response.end('trusted');
    });
    servers.push(server);
    const caFile = path.join(folder, 'ca.pem');
    writeFileSync(caFile, credentials.cert);
    const settings = vscode.workspace.getConfiguration('streamscope.request');
    const editor = await open('ca.http', [`GET ${server.url}/secure`]);

    await settings.update('caFile', caFile, vscode.ConfigurationTarget.Global);
    try {
      await send();
    } finally {
      await settings.update('caFile', undefined, vscode.ConfigurationTarget.Global);
    }

    assert.match((await lensTitles(editor.document.uri))[1] ?? '', /^200 OK · /);
  });
});
