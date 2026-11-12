import * as assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { startHttpServer, startRawServer, type LocalServer } from '../support/servers';
import { startStreamServer } from '../support/stream-server';
import { removeTemporaryFolder } from './temporary-folder';

interface ResponseState {
  key: string;
  run: number;
  view: string;
  status: string;
  events: number;
  rendered: number;
  format: string | undefined;
  body: string;
  visible: boolean;
  readOnly: boolean;
}

function responseState(): Thenable<ResponseState | undefined> {
  return vscode.commands.executeCommand<ResponseState | undefined>(
    'streamscope.test.responseState',
  );
}

function runStatus(run: number): Thenable<string | undefined> {
  return vscode.commands.executeCommand<string | undefined>('streamscope.test.runStatus', run);
}

async function waitForState(
  check: (state: ResponseState) => boolean,
  what: string,
  timeoutMs = 10_000,
): Promise<ResponseState> {
  const deadline = Date.now() + timeoutMs;
  let last: ResponseState | undefined;
  while (Date.now() < deadline) {
    last = await responseState();
    if (last !== undefined && check(last)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${what} within ${String(timeoutMs)} ms; last state ${JSON.stringify(last)}`);
}

function panelTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) =>
        tab.input instanceof vscode.TabInputWebview &&
        tab.input.viewType.endsWith('streamscope.response'),
    );
}

function send(): Thenable<unknown> {
  return vscode.commands.executeCommand('streamscope.sendRequest');
}

function chunk(text: string): string {
  return `${Buffer.byteLength(text).toString(16)}\r\n${text}\r\n`;
}

describe('the response panel', () => {
  let folder = '';
  const servers: LocalServer[] = [];
  const sending: Thenable<unknown>[] = [];

  async function streamServer(): Promise<LocalServer> {
    const server = await startStreamServer();
    servers.push(server);
    return server;
  }

  async function open(name: string, lines: string[]): Promise<vscode.TextEditor> {
    const file = path.join(folder, name);
    writeFileSync(file, lines.join('\n'));
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    return vscode.window.showTextDocument(document, vscode.ViewColumn.One);
  }

  function start(): void {
    sending.push(send());
  }

  before(() => {
    folder = mkdtempSync(path.join(tmpdir(), 'streamscope-panel-'));
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(sending.splice(0));
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  after(() => {
    removeTemporaryFolder(folder);
  });

  it('opens the panel when the headers arrive, before the stream ends', async () => {
    const server = await streamServer();
    await open('live.http', [`GET ${server.url}/stream?rate=100&seconds=20&size=256`]);

    start();
    const state = await waitForState((seen) => seen.rendered >= 10, 'ten events were not drawn');

    assert.equal(state.status, 'receiving');
    assert.equal(state.visible, true);
    assert.equal(state.readOnly, false);
    assert.equal(panelTabs().length, 1);
  });

  it('switching views mid-stream keeps everything', async function () {
    this.timeout(30_000);
    const server = await streamServer();
    await open('views.http', [`GET ${server.url}/stream?rate=100&seconds=4&size=128`]);
    const expected = 400 + 2;

    start();
    await waitForState((seen) => seen.rendered >= 5, 'the first events were not drawn');
    for (const view of ['reply', 'raw', 'headers', 'body', 'events']) {
      const before = (await responseState())?.events ?? 0;
      await vscode.commands.executeCommand('streamscope.showResponseView', view);
      const seen = await waitForState(
        (state) => state.view === view && state.events > before,
        `the ${view} view did not show while events arrived`,
      );
      assert.equal(seen.status, 'receiving');
    }
    const done = await waitForState(
      (state) => state.status === 'completed' && state.rendered === state.events,
      'the list did not catch up with the completed stream',
    );

    assert.equal(done.events, expected);
    assert.equal(done.rendered, expected);
    assert.equal(done.view, 'events');
  });

  it('streams NDJSON labelled application/json live', async () => {
    const server = await streamServer();
    await open('labelled.http', [
      `GET ${server.url}/stream?type=application/json&rate=100&seconds=20&size=256`,
    ]);

    start();
    const state = await waitForState(
      (seen) => seen.format?.startsWith('NDJSON (detected') === true && seen.rendered >= 5,
      'the stream was not detected as NDJSON and drawn',
    );

    assert.equal(state.status, 'receiving');
    assert.equal(state.view, 'events');
    assert.equal(state.body, 'stream');
  });

  it('Stop ends the run with partial data visible', async () => {
    const server = await streamServer();
    await open('stop.http', [`GET ${server.url}/stream?rate=100&seconds=30&size=256`]);

    start();
    await waitForState((seen) => seen.rendered >= 10, 'ten events were not drawn');
    await vscode.commands.executeCommand('streamscope.stopRequest');
    const stopped = await waitForState(
      (seen) => seen.status === 'cancelled',
      'the run did not end cancelled',
    );
    assert.ok(stopped.events > 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const later = await waitForState(
      (seen) => seen.rendered === seen.events,
      'the list did not catch up after Stop',
    );

    assert.equal(later.status, 'cancelled');
    assert.equal(later.events, stopped.events);
    assert.equal(later.rendered, later.events);
  });

  it('re-sending a running stream resets the panel to the new run', async () => {
    const server = await streamServer();
    await open('resend.http', [`GET ${server.url}/stream?rate=100&seconds=30&size=256`]);

    start();
    const first = await waitForState((seen) => seen.rendered >= 20, 'twenty events were not drawn');
    start();
    const second = await waitForState(
      (seen) => seen.run !== first.run,
      'the panel did not move to the new run',
    );

    assert.ok(second.rendered < first.rendered);
    assert.equal(await runStatus(first.run), 'cancelled');
    assert.equal(panelTabs().length, 1);
    const drawn = await waitForState(
      (seen) => seen.run === second.run && seen.rendered >= 5,
      'the new run was not drawn',
    );
    assert.equal(drawn.status, 'receiving');
  });

  it('reopening a closed panel mid-stream shows the events received so far', async () => {
    const server = await streamServer();
    const editor = await open('reopen.http', [
      `GET ${server.url}/stream?rate=100&seconds=30&size=256`,
    ]);

    start();
    await waitForState((seen) => seen.rendered >= 10, 'ten events were not drawn');
    await vscode.window.tabGroups.close(panelTabs());
    const closed = await waitForState((seen) => !seen.visible, 'the panel did not close');
    assert.equal(closed.status, 'receiving');
    await new Promise((resolve) => setTimeout(resolve, 300));

    await vscode.commands.executeCommand('streamscope.showResponse', editor.document.uri, 0);
    const reopened = (await responseState())?.events ?? 0;
    const shown = await waitForState(
      (seen) => seen.visible && seen.rendered >= reopened,
      'the reopened panel did not catch up with the events received so far',
    );

    assert.ok(reopened > closed.events);
    assert.equal(shown.run, closed.run);
    assert.equal(shown.status, 'receiving');
    assert.equal(panelTabs().length, 1);
  });

  it('a stream that breaks mid-way keeps its events and shows the failure', async () => {
    const lines = Array.from(
      { length: 5 },
      (_, index) => `${JSON.stringify({ type: 'PART', index })}\n`,
    ).join('');
    const server = await startRawServer((socket) => {
      socket.once('data', () => {
        socket.write(
          'HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\n\r\n',
        );
        socket.write(chunk(lines));
        setTimeout(() => socket.destroy(), 100);
      });
    });
    servers.push(server);
    await open('broken.http', [`GET ${server.url}/broken`]);

    await send();
    const state = await waitForState(
      (seen) => seen.status === 'failed' && seen.rendered === seen.events,
      'the failed stream did not keep its events',
    );

    assert.equal(state.events, 5);
  });

  it('a large body shows a preview and opens in the editor', async function () {
    this.timeout(30_000);
    const value = {
      items: Array.from({ length: 70_000 }, (_, id) => ({ id, name: `item-${String(id)}` })),
    };
    const body = Buffer.from(JSON.stringify(value));
    assert.ok(body.length > 2 * 1_048_576);
    const server = await startHttpServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(body);
    });
    servers.push(server);
    await open('large.http', [`GET ${server.url}/large`]);

    await send();
    const state = await waitForState(
      (seen) => seen.status === 'completed' && seen.body === 'preview',
      'the large body did not show as a preview',
    );
    assert.equal(state.view, 'body');
    await vscode.commands.executeCommand('streamscope.showResponseBody');

    const document = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .flatMap((tab) =>
        tab.input instanceof vscode.TabInputText &&
        tab.input.uri.scheme === 'streamscope-response' &&
        tab.input.uri.path.endsWith('.json')
          ? [tab.input.uri]
          : [],
      )[0];
    assert.ok(document, 'the body document is not open');
    const text = Buffer.from(await vscode.workspace.fs.readFile(document)).toString('utf8');
    assert.equal(text, JSON.stringify(value, null, 2));
  });
});
