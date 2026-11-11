import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createSelfSignedCertificate } from '../support/certificate';
import { startHttpsServer, type LocalServer } from '../support/servers';

interface Proxy {
  url: string;
  seen: string[];
  close(): Promise<void>;
}

function startProxy(tunnelPort = 0): Promise<Proxy> {
  const seen: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((request, response) => {
    seen.push(`${request.method ?? ''} ${request.url ?? ''}`);
    response.end('proxied');
  });
  server.on('connection', (socket: net.Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('connect', (request: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    seen.push(`CONNECT ${request.url ?? ''}`);
    const upstream = net.connect(tunnelPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({
        url: `http://127.0.0.1:${String(port)}`,
        seen,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) {
              socket.destroy();
            }
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}

async function usingProxy(url: string, run: () => Promise<void>): Promise<void> {
  const settings = vscode.workspace.getConfiguration('http');
  await settings.update('proxy', url, vscode.ConfigurationTarget.Global);
  try {
    const deadline = Date.now() + 3000;
    while (
      vscode.workspace.getConfiguration('http').get('proxy') !== url &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await run();
  } finally {
    await settings.update('proxy', undefined, vscode.ConfigurationTarget.Global);
  }
}

async function outcome(uri: vscode.Uri): Promise<string> {
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
    'vscode.executeCodeLensProvider',
    uri,
  );
  return lenses[1]?.command?.title ?? '';
}

describe('proxies', () => {
  let folder = '';
  let proxy: Proxy | undefined;
  let tunnelTarget: LocalServer | undefined;

  async function send(name: string, lines: string[]): Promise<vscode.Uri> {
    const file = path.join(folder, name);
    writeFileSync(file, lines.join('\n'));
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    await vscode.commands.executeCommand('streamscope.sendRequest');
    return document.uri;
  }

  before(() => {
    folder = mkdtempSync(path.join(tmpdir(), 'streamscope-proxy-'));
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await proxy?.close();
    await tunnelTarget?.close();
    proxy = undefined;
    tunnelTarget = undefined;
  });

  after(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it('routes http requests through http.proxy', async () => {
    const started = await startProxy();
    proxy = started;

    await usingProxy(started.url, async () => {
      const uri = await send('proxied.http', ['GET http://api.streamscope.test/items']);

      assert.match(await outcome(uri), /^200 OK · /);
    });
    assert.deepEqual(started.seen, ['GET http://api.streamscope.test/items']);
  });

  it('tunnels an # @insecure https request through the proxy', async () => {
    const target = await startHttpsServer(
      createSelfSignedCertificate(['localhost', '127.0.0.1']),
      (_request, response) => {
        response.end('tunneled');
      },
    );
    tunnelTarget = target;
    const started = await startProxy(target.port);
    proxy = started;

    await usingProxy(started.url, async () => {
      const uri = await send('tunneled.http', [
        '# @insecure',
        'GET https://secure.streamscope.test/items',
      ]);

      assert.match(await outcome(uri), /^200 OK · /);
    });
    assert.deepEqual(started.seen, ['CONNECT secure.streamscope.test:443']);
    assert.equal(target.requests[0]?.url, '/items');
  });
});
