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
