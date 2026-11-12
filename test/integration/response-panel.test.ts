import * as assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  statusBar: string | undefined;
}

function responseState(key?: string): Thenable<ResponseState | undefined> {
  return vscode.commands.executeCommand<ResponseState | undefined>(
    'streamscope.test.responseState',
    key,
  );
}

function runStatus(run: number): Thenable<string | undefined> {
  return vscode.commands.executeCommand<string | undefined>('streamscope.test.runStatus', run);
}

async function waitForState(
  check: (state: ResponseState) => boolean,
  what: string,
  timeoutMs = 10_000,
  key?: string,
): Promise<ResponseState> {
  const deadline = Date.now() + timeoutMs;
  let last: ResponseState | undefined;
  while (Date.now() < deadline) {
    last = await responseState(key);
    if (last !== undefined && check(last)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${what} within ${String(timeoutMs)} ms; last state ${JSON.stringify(last)}`);
}

async function until(
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

async function lenses(uri: vscode.Uri): Promise<[vscode.Command, vscode.Command]> {
  const found = await vscode.commands.executeCommand<vscode.CodeLens[]>(
    'vscode.executeCodeLensProvider',
    uri,
  );
  const [first, second] = found.flatMap((lens) =>
    lens.command === undefined ? [] : [lens.command],
  );
  if (first === undefined || second === undefined) {
    throw new Error(`expected two lenses, found ${String(found.length)}`);
  }
  return [first, second];
}

function runLens(command: vscode.Command): Thenable<unknown> {
  return vscode.commands.executeCommand(
    command.command,
    ...((command.arguments ?? []) as unknown[]),
  );
}

function liveEvents(command: vscode.Command): number {
  const match = /^Running · (\d+) events? · \d+(?:\.\d)? m?s$/.exec(command.title);
  return match?.[1] === undefined ? -1 : Number(match[1]);
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
  let remembered = 0;
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

  async function rememberView(view: string): Promise<void> {
    const server = await startStreamServer();
    try {
      remembered += 1;
      await open(`remember-${String(remembered)}.http`, [
        `GET ${server.url}/stream?rate=50&seconds=30&size=128`,
      ]);
      const running = send();
      await waitForState(
        (state) => state.visible && state.status === 'receiving',
        'the stream for setting the view did not open',
      );
      await vscode.commands.executeCommand('streamscope.showResponseView', view);
      await waitForState((state) => state.view === view, `the ${view} view was not selected`);
      await vscode.commands.executeCommand('streamscope.stopRequest');
      await running;
    } finally {
      await server.close();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  }

  before(() => {
    folder = mkdtempSync(path.join(tmpdir(), 'streamscope-panel-'));
  });

  beforeEach(async () => {
    await rememberView('events');
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
    await open('views.http', [`GET ${server.url}/stream?rate=100&seconds=30&size=128`]);

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
    await vscode.commands.executeCommand('streamscope.stopRequest');
    const stopped = await waitForState(
      (state) => state.status === 'cancelled',
      'the stream did not stop',
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const done = await waitForState(
      (state) => state.rendered === state.events,
      'the list did not catch up with the stopped stream',
    );

    assert.equal(done.events, stopped.events);
    assert.ok(done.events > 5);
    assert.equal(done.rendered, done.events);
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

  it('saves a stream as .ndjson with every event', async () => {
    const server = await streamServer();
    await open('save-stream.http', [`GET ${server.url}/stream?rate=100&seconds=0.3&size=256`]);

    await send();
    const done = await waitForState(
      (seen) => seen.status === 'completed' && seen.rendered === seen.events,
      'the stream did not complete',
    );
    const target = vscode.Uri.file(path.join(folder, 'saved-stream.ndjson'));
    await vscode.commands.executeCommand('streamscope.saveResponse', target);

    const lines = readFileSync(target.fsPath, 'utf8').split('\n');
    assert.equal(lines.pop(), '');
    assert.equal(lines.length, done.events);
    const events = lines.map((line) => JSON.parse(line) as { type: string });
    assert.equal(events[0]?.type, 'RUN_STARTED');
    assert.equal(events.at(-1)?.type, 'RUN_FINISHED');
  });

  it('saves the events a running stream has received so far', async function () {
    this.timeout(30_000);
    const server = await streamServer();
    await open('save-running.http', [`GET ${server.url}/stream?rate=100&seconds=30&size=256`]);

    start();
    await waitForState((seen) => seen.rendered >= 10, 'ten events were not drawn');
    const partial = vscode.Uri.file(path.join(folder, 'saved-running.ndjson'));
    await vscode.commands.executeCommand('streamscope.saveResponse', partial);
    const savedAt = (await responseState())?.events ?? 0;
    await waitForState((seen) => seen.events >= savedAt + 3, 'the stream did not go on');
    await vscode.commands.executeCommand('streamscope.stopRequest');
    await waitForState((seen) => seen.status === 'cancelled', 'the run did not end cancelled');
    const final = vscode.Uri.file(path.join(folder, 'saved-stopped.ndjson'));
    await vscode.commands.executeCommand('streamscope.saveResponse', final);

    const early = readFileSync(partial.fsPath, 'utf8');
    const later = readFileSync(final.fsPath, 'utf8');
    const complete = early.split('\n').slice(0, -1);
    assert.ok(complete.length >= 10);
    for (const line of complete) {
      JSON.parse(line);
    }
    assert.ok(later.startsWith(early));
    assert.ok(later.length > early.length);
  });

  it('shows Stop and the live event count in the CodeLens while streaming', async function () {
    this.timeout(30_000);
    const server = await streamServer();
    const editor = await open('lens-live.http', [
      `GET ${server.url}/stream?rate=100&seconds=30&size=256`,
    ]);
    const uri = editor.document.uri;

    start();
    await waitForState((seen) => seen.events >= 10, 'ten events were not received');
    const [stop, outcome] = await lenses(uri);
    assert.equal(stop.title, 'Stop');
    assert.equal(stop.command, 'streamscope.stopRequest');
    const first = liveEvents(outcome);
    assert.ok(first >= 10, `the lens shows ${outcome.title}`);
    await until(async () => {
      const [, later] = await lenses(uri);
      return liveEvents(later) >= first + 20;
    }, 'the event count in the lens did not grow');

    await runLens(stop);
    await waitForState((seen) => seen.status === 'cancelled', 'the lens Stop did not end the run');
    const [resend, ended] = await lenses(uri);
    assert.equal(resend.title, 'Send Request');
    assert.match(ended.title, /^Cancelled after /);
  });

  it('the outcome lens reveals the response panel', async () => {
    const server = await startHttpServer((_request, response) => {
      response.end('ok');
    });
    servers.push(server);
    const editor = await open('lens-reveal.http', [`GET ${server.url}/reveal`]);

    await send();
    await waitForState((seen) => seen.status === 'completed' && seen.visible, 'no panel opened');
    await vscode.window.tabGroups.close(panelTabs());
    await until(() => panelTabs().length === 0, 'the panel did not close');
    const [, outcome] = await lenses(editor.document.uri);
    assert.match(outcome.title, /^200 OK · 2 B · /);

    await runLens(outcome);

    await waitForState((seen) => seen.visible, 'the outcome lens did not reveal the panel');
    assert.equal(panelTabs().length, 1);
  });

  it('shows the running request in the status bar and stops it from there', async function () {
    this.timeout(30_000);
    const server = await streamServer();
    await open('status-bar.http', [`GET ${server.url}/stream?rate=100&seconds=30&size=256`]);

    start();
    const running = await waitForState(
      (seen) => / · \d+ events$/.test(seen.statusBar ?? ''),
      'the status bar did not show the running stream with its events',
    );
    assert.match(
      running.statusBar ?? '',
      /^\$\(debug-stop\) GET http:\/\/127\.0\.0\.1:\d+\/stream\?/,
    );

    await vscode.commands.executeCommand('streamscope.stopRunningRequest');
    const stopped = await waitForState(
      (seen) => seen.status === 'cancelled' && seen.statusBar === undefined,
      'the status bar did not stop the run and hide',
    );

    assert.ok(stopped.events > 0);
  });

  it('counts the running requests in the status bar and follows each one that stops', async function () {
    this.timeout(30_000);
    const server = await streamServer();
    const url = `${server.url}/stream?rate=100&seconds=30&size=256`;
    const editor = await open('status-bar-several.http', [
      `GET ${url}&request=first`,
      '',
      '###',
      '',
      `GET ${url}&request=second`,
    ]);
    const uri = editor.document.uri;

    sending.push(vscode.commands.executeCommand('streamscope.sendRequest', uri, 0));
    sending.push(vscode.commands.executeCommand('streamscope.sendRequest', uri, 4));
    const both = await waitForState(
      (seen) => seen.statusBar === '$(debug-stop) 2 running',
      'the status bar did not count both requests',
    );

    await vscode.commands.executeCommand('streamscope.stopRequest', uri, 0);
    const left = await waitForState(
      (seen) => seen.statusBar?.includes('request=second') === true,
      'the status bar did not move to the request still running',
      10_000,
      both.key,
    );
    assert.match(left.statusBar ?? '', /^\$\(debug-stop\) GET .*request=second · /);

    await vscode.commands.executeCommand('streamscope.stopRequest', uri, 4);
    await waitForState(
      (seen) => seen.statusBar === undefined,
      'the status bar did not hide once nothing ran',
      10_000,
      both.key,
    );
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
