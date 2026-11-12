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
  rawChars: number;
  replyChars: number;
  format: string | undefined;
  body: string;
  visible: boolean;
  readOnly: boolean;
  released: boolean;
  title: string | undefined;
  bodyText: string | undefined;
  statusBar: string | undefined;
}

interface HistoryEntry {
  id: number;
  label: string;
  description: string;
  detail: string;
}

function responseState(key?: string): Thenable<ResponseState | undefined> {
  return vscode.commands.executeCommand<ResponseState | undefined>(
    'streamscope.test.responseState',
    key,
  );
}

function showHistory(runId: number): Thenable<HistoryEntry[]> {
  return vscode.commands.executeCommand<HistoryEntry[]>('streamscope.showHistory', runId);
}

function listHistory(): Thenable<HistoryEntry[]> {
  return showHistory(0);
}

function bodySource(run: number): Thenable<string | undefined> {
  return vscode.commands.executeCommand<string | undefined>('streamscope.test.bodySource', run);
}

function newestEventInMemory(run: number): Thenable<boolean | undefined> {
  return vscode.commands.executeCommand<boolean | undefined>(
    'streamscope.test.newestEventInMemory',
    run,
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

  describe('history', () => {
    const maxHistory = 50;

    async function sendLine(uri: vscode.Uri, line: number): Promise<number> {
      await vscode.commands.executeCommand('streamscope.sendRequest', uri, line);
      const [newest] = await listHistory();
      if (newest === undefined) {
        throw new Error('the run was not added to the history');
      }
      return newest.id;
    }

    async function churn(uri: vscode.Uri, line: number, count: number): Promise<void> {
      for (let sent = 0; sent < count; sent += 1) {
        await vscode.commands.executeCommand('streamscope.sendRequest', uri, line);
      }
    }

    async function openPair(name: string, url: string): Promise<vscode.Uri> {
      const editor = await open(name, [
        '# @name kept',
        `GET ${url}/kept`,
        '',
        '###',
        '# @name churn',
        `GET ${url}/churn`,
      ]);
      return editor.document.uri;
    }

    it('lists the runs of the session, newest first', async () => {
      const server = await startHttpServer((_request, response) => {
        response.end('ok');
      });
      servers.push(server);
      const editor = await open('history-list.http', [
        '# @name first',
        `GET ${server.url}/first`,
        '',
        '###',
        '# @name second',
        `GET ${server.url}/second`,
        '',
        '###',
        '# @name third',
        `GET ${server.url}/third`,
      ]);
      const uri = editor.document.uri;

      const firstId = await sendLine(uri, 1);
      const secondId = await sendLine(uri, 5);
      const thirdId = await sendLine(uri, 9);
      const [third, second, first] = (await listHistory()).slice(0, 3);

      assert.deepEqual([third?.label, second?.label, first?.label], ['third', 'second', 'first']);
      assert.deepEqual([third?.id, second?.id, first?.id], [thirdId, secondId, firstId]);
      assert.ok(firstId < secondId && secondId < thirdId);
      for (const item of [third, second, first]) {
        assert.match(item?.description ?? '', /^200 OK · 2 B · \d+ ms$/);
        assert.match(item?.detail ?? '', /^\d{2}:\d{2}:\d{2}$/);
      }
    });

    it('lists a run that is still running', async function () {
      this.timeout(30_000);
      const server = await streamServer();
      await open('history-running.http', [`GET ${server.url}/stream?rate=100&seconds=30&size=256`]);

      start();
      await waitForState((seen) => seen.events >= 5, 'five events were not received');
      const [running] = await listHistory();

      assert.match(running?.description ?? '', /^Running · \d+ events · /);
      await vscode.commands.executeCommand('streamscope.stopRequest');
      await waitForState((seen) => seen.status === 'cancelled', 'the run did not end cancelled');
      const [ended] = await listHistory();
      assert.equal(ended?.id, running?.id);
      assert.match(ended?.description ?? '', /^Cancelled after /);
    });

    it('reopens an earlier run read-only with its events', async () => {
      const server = await streamServer();
      await open('history-reopen.http', [`GET ${server.url}/stream?rate=100&seconds=0.3&size=256`]);

      await send();
      const first = await waitForState(
        (seen) => seen.status === 'completed' && seen.rendered === seen.events,
        'the first run did not complete',
      );
      await send();
      const second = await waitForState(
        (seen) =>
          seen.run !== first.run && seen.status === 'completed' && seen.rendered === seen.events,
        'the second run did not complete',
      );
      assert.equal(second.readOnly, false);

      const list = await showHistory(first.run);
      const reopened = await waitForState(
        (seen) => seen.run === first.run && seen.visible && seen.rendered === seen.events,
        'the earlier run was not reopened and drawn',
      );

      assert.deepEqual(
        list.slice(0, 2).map((item) => item.id),
        [second.run, first.run],
      );
      assert.equal(reopened.readOnly, true);
      assert.equal(reopened.released, false);
      assert.equal(reopened.status, 'completed');
      assert.equal(reopened.events, first.events);
      assert.ok(reopened.events > 5);
      assert.match(
        reopened.title ?? '',
        /^GET http:\/\/127\.0\.0\.1:\d+\/stream\?.* · \d{2}:\d{2}:\d{2}$/,
      );
      assert.equal(panelTabs().length, 1);
    });

    it('shows the latest run again when its request is shown after an earlier run was reopened', async () => {
      const server = await streamServer();
      const editor = await open('history-latest.http', [
        `GET ${server.url}/stream?rate=100&seconds=0.3&size=256`,
      ]);

      await send();
      const first = await waitForState(
        (seen) => seen.status === 'completed' && seen.rendered === seen.events,
        'the first run did not complete',
      );
      await send();
      const second = await waitForState(
        (seen) => seen.run !== first.run && seen.status === 'completed',
        'the second run did not complete',
      );
      await showHistory(first.run);
      await waitForState((seen) => seen.run === first.run, 'the earlier run was not reopened');

      await vscode.commands.executeCommand('streamscope.showResponse', editor.document.uri, 0);
      const latest = await waitForState(
        (seen) => seen.run === second.run && seen.visible && seen.rendered === seen.events,
        'the latest run did not come back',
      );

      assert.equal(latest.readOnly, false);
      assert.equal(panelTabs().length, 1);
    });

    it('reads the Raw tail and the Reply of a stream back after its memory was released', async function () {
      this.timeout(30_000);
      const server = await streamServer();
      const editor = await open('history-raw-reply.http', [
        `GET ${server.url}/stream?rate=100&seconds=0.3&size=256`,
      ]);
      const selectView = async (view: string): Promise<void> => {
        await vscode.window.showTextDocument(editor.document, vscode.ViewColumn.One);
        await vscode.commands.executeCommand('streamscope.showResponseView', view);
      };
      await send();
      const live = await waitForState(
        (seen) => seen.status === 'completed' && seen.rendered === seen.events,
        'the stream did not complete',
      );
      await selectView('raw');
      const raw = await waitForState(
        (seen) => seen.view === 'raw' && seen.rawChars > 0,
        'the Raw view was not drawn',
      );
      await selectView('reply');
      const reply = await waitForState(
        (seen) => seen.view === 'reply' && seen.replyChars > 0,
        'the Reply view was not drawn',
      );
      await until(() => panelTabs().length === 1, 'the panel has no tab');
      await vscode.window.tabGroups.close(panelTabs());
      await until(
        async () => (await responseState(live.key)) === undefined,
        'the panel did not close',
      );
      await until(
        async () => (await newestEventInMemory(live.run)) === false,
        'the run was not compacted',
      );

      await showHistory(live.run);
      await selectView('raw');
      const rawAgain = await waitForState(
        (seen) => seen.run === live.run && seen.view === 'raw' && seen.rawChars > 0,
        'the Raw tail was not read back',
      );
      await selectView('reply');
      const replyAgain = await waitForState(
        (seen) => seen.run === live.run && seen.view === 'reply' && seen.replyChars > 0,
        'the Reply was not read back',
      );

      assert.equal(rawAgain.readOnly, true);
      assert.equal(rawAgain.rawChars, raw.rawChars);
      assert.equal(replyAgain.replyChars, reply.replyChars);
    });

    it('keeps a stream compacted once it ends with its panel closed', async function () {
      this.timeout(30_000);
      const server = await streamServer();
      await open('history-compact.http', [`GET ${server.url}/stream?rate=100&seconds=1&size=256`]);

      start();
      const streaming = await waitForState(
        (seen) => seen.rendered >= 10,
        'ten events were not drawn',
      );
      assert.equal(await newestEventInMemory(streaming.run), true);
      await vscode.window.tabGroups.close(panelTabs());
      await waitForState((seen) => !seen.visible, 'the panel did not close');
      await until(
        async () => (await runStatus(streaming.run)) === 'completed',
        'the stream did not complete',
      );

      await until(
        async () => (await newestEventInMemory(streaming.run)) === false,
        'the events of the ended run were not released from memory',
      );
    });

    it('drops the oldest runs past 50 and says so when a request shows one that left history', async function () {
      this.timeout(120_000);
      const server = await startHttpServer((_request, response) => {
        response.end('ok');
      });
      servers.push(server);
      const uri = await openPair('history-evict.http', server.url);

      const dropped = await sendLine(uri, 1);
      const kept = await waitForState(
        (seen) => seen.status === 'completed' && seen.visible,
        'the first panel did not open',
      );
      await until(() => panelTabs().length === 1, 'the first panel has no tab');
      await vscode.window.tabGroups.close(panelTabs());
      await until(
        async () => (await responseState(kept.key)) === undefined,
        'the first panel did not close',
      );
      await churn(uri, 5, maxHistory);
      const list = await listHistory();

      assert.equal(list.length, maxHistory);
      assert.ok(!list.some((item) => item.id === dropped), 'the oldest run is still listed');
      await vscode.commands.executeCommand('streamscope.showResponse', uri, 1);
      const gone = await waitForState(
        (seen) => seen.released && seen.visible && seen.body !== 'none',
        'the run that left history was not shown as released with its body',
        10_000,
        kept.key,
      );
      assert.equal(gone.run, dropped);
      assert.equal(gone.status, 'completed');
      assert.equal(gone.body, 'unavailable');
      assert.equal(gone.bodyText, undefined);
    });

    describe('bodies of earlier runs', () => {
      const json = { alpha: 1, beta: [1, 2, { gamma: 'synthetic' }] };

      async function bodyServer(): Promise<LocalServer> {
        const server = await startHttpServer((request, response) => {
          if (request.url === '/json') {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(json));
            return;
          }
          response.end('ok');
        });
        servers.push(server);
        return server;
      }

      async function sendAndCloseThePanel(uri: vscode.Uri, line: number): Promise<number> {
        const run = await sendLine(uri, line);
        const shown = await waitForState(
          (seen) => seen.run === run && seen.status === 'completed' && seen.visible,
          'the panel did not open',
        );
        await until(() => panelTabs().length === 1, 'the panel has no tab');
        await vscode.window.tabGroups.close(panelTabs());
        await until(
          async () => (await responseState(shown.key)) === undefined,
          'the panel did not close',
        );
        await until(
          async () => (await bodySource(run)) === 'spill',
          'the body of the run was not dropped from memory',
        );
        return run;
      }

      it('shows the Body of a run reopened after a newer run of another request', async () => {
        const server = await bodyServer();
        const editor = await open('history-body.http', [
          '# @name json',
          `GET ${server.url}/json`,
          '',
          '###',
          '# @name other',
          `GET ${server.url}/other`,
        ]);
        const uri = editor.document.uri;
        const run = await sendAndCloseThePanel(uri, 1);
        await sendLine(uri, 5);

        await showHistory(run);
        const reopened = await waitForState(
          (seen) => seen.run === run && seen.visible && seen.body === 'text',
          'the Body of the earlier run was not shown',
        );

        assert.equal(reopened.readOnly, true);
        assert.equal(reopened.view, 'body');
        assert.equal(reopened.bodyText, JSON.stringify(json, null, 2));
        assert.equal(await bodySource(run), 'spill');
      });

      it('saves the body of a run whose bytes were dropped from its spill file', async () => {
        const server = await bodyServer();
        const editor = await open('history-save.http', [`GET ${server.url}/json`]);
        await sendAndCloseThePanel(editor.document.uri, 0);
        await vscode.window.showTextDocument(editor.document, vscode.ViewColumn.One);
        const target = vscode.Uri.file(path.join(folder, 'saved-history-body.json'));

        await vscode.commands.executeCommand('streamscope.saveResponse', target);

        assert.equal(readFileSync(target.fsPath, 'utf8'), JSON.stringify(json));
      });
    });

    it('keeps a run that is still running while older runs are dropped', async function () {
      this.timeout(120_000);
      const server = await streamServer();
      const quick = await startHttpServer((_request, response) => {
        response.end('ok');
      });
      servers.push(quick);
      const streaming = await open('history-running-kept.http', [
        `GET ${server.url}/stream?rate=100&seconds=60&size=256`,
      ]);
      start();
      const running = await waitForState(
        (seen) => seen.rendered >= 5,
        'five events were not drawn',
      );
      await until(() => panelTabs().length === 1, 'the stream has no panel tab');
      await vscode.window.tabGroups.close(panelTabs());
      await waitForState((seen) => !seen.visible, 'the panel did not close', 10_000, running.key);
      const uri = await openPair('history-running-churn.http', quick.url);

      await churn(uri, 5, maxHistory + 1);
      const list = await listHistory();

      assert.equal(list.length, maxHistory);
      assert.ok(
        list.some((item) => item.id === running.run),
        'the running run was dropped',
      );
      const state = await responseState(running.key);
      assert.equal(state?.released, false);
      assert.equal(state.status, 'receiving');
      await vscode.commands.executeCommand('streamscope.stopRequest', streaming.document.uri, 0);
      await until(
        async () => (await runStatus(running.run)) === 'cancelled',
        'the run did not end cancelled',
      );
    });

    it('keeps a run that a panel shows while older runs are dropped', async function () {
      this.timeout(120_000);
      const server = await startHttpServer((_request, response) => {
        response.end('ok');
      });
      servers.push(server);
      const uri = await openPair('history-shown.http', server.url);

      const shown = await sendLine(uri, 1);
      const panel = await waitForState(
        (seen) => seen.status === 'completed' && seen.visible,
        'the panel did not open',
      );
      await churn(uri, 5, maxHistory + 1);
      const list = await listHistory();

      assert.equal(list.length, maxHistory);
      assert.ok(
        list.some((item) => item.id === shown),
        'the shown run was dropped',
      );
      const state = await responseState(panel.key);
      assert.equal(state?.released, false);
      assert.equal(state.run, shown);
    });
  });
});
