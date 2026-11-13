import * as assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { LocalServer } from '../support/servers';
import { startStreamServer } from '../support/stream-server';
import { removeTemporaryFolder } from './temporary-folder';

interface HistoryEntry {
  id: number;
  label: string;
  description: string;
  detail: string;
}

interface BlockedActions {
  message: string;
  actions: string[];
  run: { title: string; command: string; arguments: unknown[] } | undefined;
}

const producerLine = 3;
const followUpLine = 7;

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`${what} within ${String(timeoutMs)} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function lensTitles(uri: vscode.Uri): Promise<string[]> {
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
    'vscode.executeCodeLensProvider',
    uri,
  );
  return lenses.map((lens) => lens.command?.title ?? '');
}

function send(uri: vscode.Uri, line: number): Thenable<unknown> {
  return vscode.commands.executeCommand('streamscope.sendRequest', uri, line);
}

function stop(uri: vscode.Uri, line: number): Thenable<unknown> {
  return vscode.commands.executeCommand('streamscope.stopRequest', uri, line);
}

function history(): Thenable<HistoryEntry[]> {
  return vscode.commands.executeCommand<HistoryEntry[]>('streamscope.showHistory', 0);
}

function agentFile(server: LocalServer, followUp: string, stream: string): string[] {
  return [
    '### Start agent run',
    '# @name startRun',
    '# @capture threadId = first(type == "RUN_STARTED").threadId',
    `GET ${server.url}/stream?${stream}`,
    '',
    '### Continue',
    `# @name ${followUp}`,
    `GET ${server.url}/continue?thread={{startRun.threadId}}`,
  ];
}

function followUps(server: LocalServer): string[] {
  return server.requests
    .filter((request) => request.url.startsWith('/continue'))
    .map((request) => request.url);
}

function streamed(server: LocalServer): boolean {
  return server.requests.some((request) => request.url.startsWith('/stream'));
}

async function waitingLens(uri: vscode.Uri): Promise<void> {
  await waitFor(
    async () =>
      (await lensTitles(uri)).some((title) => title.startsWith('Waiting for startRun › threadId')),
    'the follow-up never showed "Waiting for startRun › threadId"',
  );
}

describe('waiting for captured values', () => {
  let folder = '';
  const servers: LocalServer[] = [];

  async function serve(): Promise<LocalServer> {
    const server = await startStreamServer();
    servers.push(server);
    return server;
  }

  async function open(name: string, lines: string[]): Promise<vscode.Uri> {
    const file = path.join(folder, name);
    writeFileSync(file, lines.join('\n'));
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    return document.uri;
  }

  before(() => {
    folder = mkdtempSync(path.join(tmpdir(), 'streamscope-captures-'));
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  after(() => {
    removeTemporaryFolder(folder);
  });

  it("the follow-up waits for the stream's capture and then sends it", async () => {
    const server = await serve();
    const uri = await open(
      'waits.http',
      agentFile(server, 'continue', 'delayMs=1500&rate=10&seconds=3'),
    );

    const producing = send(uri, producerLine);
    await waitFor(() => streamed(server), 'the producer never reached the server');
    const following = send(uri, followUpLine);
    await waitingLens(uri);

    assert.deepEqual(followUps(server), []);
    await following;
    assert.deepEqual(followUps(server), ['/continue?thread=thread-1']);
    assert.equal((await lensTitles(uri))[0], 'Stop', 'the producer stream should still run');
    await stop(uri, producerLine);
    await producing;
  });

  it('Stop cancels a waiting request', async () => {
    const server = await serve();
    const uri = await open('stop.http', agentFile(server, 'stopped', 'delayMs=10000&seconds=0'));

    const producing = send(uri, producerLine);
    await waitFor(() => streamed(server), 'the producer never reached the server');
    const following = send(uri, followUpLine);
    await waitingLens(uri);
    await stop(uri, followUpLine);
    await following;

    const [latest] = (await history()).filter((entry) => entry.label === 'stopped');
    assert.match(latest?.description ?? '', /^Cancelled after /);
    assert.deepEqual(followUps(server), []);
    await stop(uri, producerLine);
    await producing;
  });

  it('the blocked toast offers Run startRun, and nothing runs until it is clicked', async () => {
    const server = await serve();
    const uri = await open('blocked.http', agentFile(server, 'blocked', 'seconds=0'));

    await send(uri, followUpLine);
    const blocked = await vscode.commands.executeCommand<BlockedActions | undefined>(
      'streamscope.test.blockedActions',
    );

    assert.ok(blocked, 'no blocked notification was shown');
    assert.equal(
      blocked.message,
      'Not sent: `{{startRun.threadId}}` comes from startRun, which has not run in this session. (line 8).',
    );
    assert.deepEqual(blocked.actions, ['Run startRun', 'Go to Line']);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(server.requests.length, 0);

    const run = blocked.run;
    assert.ok(run, 'the toast has no Run startRun action');
    assert.equal(run.title, 'Run startRun');
    await vscode.commands.executeCommand(run.command, ...run.arguments);

    assert.deepEqual(
      server.requests.map((request) => request.url),
      ['/stream?seconds=0'],
    );
  });

  it('the blocked toast offers Run for an unnamed producer too', async () => {
    const server = await serve();
    const uri = await open('unnamed.http', [
      '### Start an unnamed run',
      '# @capture unnamedThread = first(type == "RUN_STARTED").threadId',
      `GET ${server.url}/stream?seconds=0`,
      '',
      '###',
      `GET ${server.url}/continue?thread={{unnamedThread}}`,
    ]);

    await send(uri, 5);
    const blocked = await vscode.commands.executeCommand<BlockedActions | undefined>(
      'streamscope.test.blockedActions',
    );

    assert.ok(blocked, 'no blocked notification was shown');
    assert.equal(
      blocked.message,
      'Not sent: `{{unnamedThread}}` comes from Start an unnamed run, which has not run in this session. (line 6).',
    );
    assert.deepEqual(blocked.actions, ['Run Start an unnamed run', 'Go to Line']);
    assert.equal(server.requests.length, 0);
    const run = blocked.run;
    assert.ok(run, 'the toast has no Run action');
    await vscode.commands.executeCommand(run.command, ...run.arguments);

    assert.deepEqual(
      server.requests.map((request) => request.url),
      ['/stream?seconds=0'],
    );
  });

  it('the Run button sends exactly the producer when two unnamed requests share a title', async () => {
    const server = await serve();
    const uri = await open('shared-title.http', [
      '### Shared title',
      `GET ${server.url}/first`,
      '',
      '### Shared title',
      '# @capture sharedThread = first(type == "RUN_STARTED").threadId',
      `GET ${server.url}/stream?seconds=0`,
      '',
      '###',
      `GET ${server.url}/continue?thread={{sharedThread}}`,
    ]);

    await send(uri, 8);
    const blocked = await vscode.commands.executeCommand<BlockedActions | undefined>(
      'streamscope.test.blockedActions',
    );

    assert.ok(blocked, 'no blocked notification was shown');
    assert.deepEqual(blocked.actions, ['Run Shared title', 'Go to Line']);
    const run = blocked.run;
    assert.ok(run, 'the toast has no Run action');
    assert.equal(run.arguments[1], 5);
    await vscode.commands.executeCommand(run.command, ...run.arguments);

    assert.deepEqual(
      server.requests.map((request) => request.url),
      ['/stream?seconds=0'],
    );
  });

  it('a re-send replaces a waiting run', async () => {
    const server = await serve();
    const uri = await open('resend.http', agentFile(server, 'resent', 'delayMs=1500&seconds=0'));

    const producing = send(uri, producerLine);
    await waitFor(() => streamed(server), 'the producer never reached the server');
    const first = send(uri, followUpLine);
    await waitingLens(uri);
    const second = send(uri, followUpLine);
    await Promise.all([first, second, producing]);

    assert.deepEqual(followUps(server), ['/continue?thread=thread-1']);
    const runs = (await history()).filter((entry) => entry.label === 'resent');
    assert.equal(runs.length, 2);
    assert.match(runs[0]?.description ?? '', /^404 /);
    assert.match(runs[1]?.description ?? '', /^Cancelled after /);
  });
});

describe('captures in the editor', () => {
  let folder = '';
  const servers: LocalServer[] = [];

  async function serve(): Promise<LocalServer> {
    const server = await startStreamServer();
    servers.push(server);
    return server;
  }

  async function open(
    name: string,
    lines: string[],
    column = vscode.ViewColumn.One,
  ): Promise<vscode.TextDocument> {
    const file = path.join(folder, name);
    writeFileSync(file, lines.join('\n'));
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document, column);
    return document;
  }

  async function hintLabels(document: vscode.TextDocument): Promise<string[]> {
    const hints = await vscode.commands.executeCommand<vscode.InlayHint[]>(
      'vscode.executeInlayHintProvider',
      document.uri,
      new vscode.Range(0, 0, document.lineCount, 0),
    );
    return hints.map((hint) =>
      typeof hint.label === 'string' ? hint.label : hint.label.map((part) => part.value).join(''),
    );
  }

  async function hoverText(
    document: vscode.TextDocument,
    line: number,
    reference: string,
  ): Promise<string> {
    const character = document.lineAt(line).text.indexOf(reference) + 3;
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      new vscode.Position(line, character),
    );
    return hovers
      .flatMap((hover) => hover.contents)
      .map((content) => (content instanceof vscode.MarkdownString ? content.value : ''))
      .join('\n')
      .replace(/&nbsp;/g, ' ')
      .replace(/\\(.)/g, '$1');
  }

  function undefinedWarnings(document: vscode.TextDocument): vscode.Diagnostic[] {
    return vscode.languages
      .getDiagnostics(document.uri)
      .filter((diagnostic) => diagnostic.code === 'undefined-variable');
  }

  before(() => {
    folder = mkdtempSync(path.join(tmpdir(), 'streamscope-editor-captures-'));
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  after(() => {
    removeTemporaryFolder(folder);
  });

  it('an inlay hint after the capture line shows the value after the run', async () => {
    const server = await serve();
    const lines = agentFile(server, 'hinted', 'seconds=0');
    const document = await open('hints.http', lines);
    assert.deepEqual(await hintLabels(document), []);

    await send(document.uri, producerLine);
    await waitFor(
      async () => (await hintLabels(document)).includes('= thread-1'),
      'no inlay hint showed = thread-1',
    );

    const [hint] = await vscode.commands.executeCommand<vscode.InlayHint[]>(
      'vscode.executeInlayHintProvider',
      document.uri,
      new vscode.Range(0, 0, document.lineCount, 0),
    );
    assert.deepEqual([hint?.position.line, hint?.position.character], [2, lines[2]?.length]);
  });

  it('hovering {{startRun.threadId}} shows the value and its provenance', async () => {
    const server = await serve();
    const document = await open('hover.http', agentFile(server, 'hovered', 'seconds=0'));

    await send(document.uri, producerLine);
    const text = await hoverText(document, followUpLine, '{{startRun.threadId}}');

    assert.ok(text.includes('{{startRun.threadId}} = thread-1'), text);
    assert.match(text, /startRun › threadId · run \d+ · event \d+ at threadId · \d\d:\d\d:\d\d/);
  });

  it('completion after {{ offers startRun.threadId and threadId', async () => {
    const document = await open('complete.http', [
      '### Start agent run',
      '# @name startRun',
      '# @capture threadId = first(type == "RUN_STARTED").threadId',
      'GET https://api.example.test/stream',
      '',
      '###',
      'GET https://api.example.test/continue?thread={{',
    ]);

    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      document.uri,
      new vscode.Position(6, document.lineAt(6).text.length),
      '{',
    );
    const labels = list.items.map((item) =>
      typeof item.label === 'string' ? item.label : item.label.label,
    );

    assert.ok(labels.includes('startRun.threadId'), labels.join(', '));
    assert.ok(labels.includes('threadId'), labels.join(', '));
  });

  it('hovering a response reference still says its producer has not run', async () => {
    const document = await open('response-hover.http', [
      '# @name login',
      'POST https://api.example.test/login',
      '',
      '###',
      'GET https://api.example.test/me?token={{login.response.body.$.token}}',
    ]);

    const text = await hoverText(document, 4, '{{login.response.body.$.token}}');

    assert.equal(
      text,
      '`{{login.response.body.$.token}}` comes from login, which has not run in this session.',
    );
  });

  it('hovering a response reference says it is read from the latest response once its producer ran', async () => {
    const server = await serve();
    const document = await open('response-ran.http', [
      '# @name login',
      `POST ${server.url}/login`,
      '',
      '###',
      'GET https://api.example.test/me?token={{login.response.body.$.token}}',
    ]);

    await send(document.uri, 1);
    const text = await hoverText(document, 4, '{{login.response.body.$.token}}');

    assert.equal(
      text,
      "`{{login.response.body.$.token}}` is read from login's latest response when the request is sent.",
    );
  });

  it('hovering a 1 MiB capture shows at most 4,096 characters plus …', async () => {
    const server = await serve();
    const document = await open('large-hover.http', [
      '# @name bigRun',
      '# @capture padding = first(type == "RUN_STARTED").padding',
      `GET ${server.url}/stream?seconds=0&size=1040000`,
      '',
      '###',
      'GET https://api.example.test/continue?padding={{bigRun.padding}}',
    ]);

    await send(document.uri, 2);
    await waitFor(
      async () => (await hintLabels(document)).some((label) => label.startsWith('= xxx')),
      'the padding capture never resolved',
    );
    const text = await hoverText(document, 5, '{{bigRun.padding}}');

    assert.equal(text.split('\n')[0], `{{bigRun.padding}} = ${'x'.repeat(4_095)}…`);
    assert.ok(text.length < 4_400, String(text.length));
  });

  it('a run fires onDidChangeInlayHints when it begins and again when its value arrives', async () => {
    const server = await serve();
    const document = await open(
      'hint-events.http',
      agentFile(server, 'eventful', 'delayMs=1000&seconds=0'),
    );
    const changes = (): Thenable<number> =>
      vscode.commands.executeCommand<number>('streamscope.test.inlayHintChanges');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const before = await changes();

    await send(document.uri, producerLine);
    await new Promise((resolve) => setTimeout(resolve, 400));

    assert.equal((await changes()) - before, 2);
    assert.ok((await hintLabels(document)).includes('= thread-1'));
  });

  it('a secret capture is masked in the inlay hint and the hover', async () => {
    const server = await serve();
    const document = await open('secret.http', [
      '### Start agent run',
      '# @name secretRun',
      '# @capture secret runHandle = first(type == "RUN_STARTED").runId',
      `GET ${server.url}/stream?seconds=0`,
      '',
      '###',
      'GET https://api.example.test/continue?run={{secretRun.runHandle}}',
    ]);

    await send(document.uri, 3);
    await waitFor(
      async () => (await hintLabels(document)).includes('= ••••••'),
      'no masked inlay hint',
    );
    const text = await hoverText(document, 6, '{{secretRun.runHandle}}');

    assert.ok(text.includes('{{secretRun.runHandle}} = ••••••'), text);
    assert.ok(!text.includes('run-1'), text);
  });

  it('a bare capture from another file stops warning once its producer runs, and warns again when a re-run drops it', async () => {
    const server = await serve();
    const consumer = await open('consumer.http', [
      'GET https://api.example.test/continue?thread={{seededThread}}',
    ]);
    await waitFor(() => undefinedWarnings(consumer).length === 1, 'no undefined-variable warning');
    const producer = await open(
      'producer.http',
      [
        '### Seed',
        '# @name seedRun',
        '# @capture seededThread = first(type == "RUN_STARTED").threadId',
        `GET ${server.url}/stream?seconds=0`,
      ],
      vscode.ViewColumn.Two,
    );

    await send(producer.uri, 3);
    await waitFor(
      () => undefinedWarnings(consumer).length === 0,
      'the warning stayed after the producer ran',
    );
    assert.equal(consumer.isClosed, false);

    const edit = new vscode.WorkspaceEdit();
    edit.delete(producer.uri, new vscode.Range(2, 0, 3, 0));
    await vscode.workspace.applyEdit(edit);
    await send(producer.uri, 2);
    await waitFor(
      () => undefinedWarnings(consumer).length === 1,
      'the warning did not return after the re-run dropped the capture',
    );
  });
});
