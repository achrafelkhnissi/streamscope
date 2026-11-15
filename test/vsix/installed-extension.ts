import * as assert from 'node:assert/strict';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import * as vscode from 'vscode';

const dialogTimeoutMs = 10_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function until(
  condition: () => boolean,
  what: string,
  timeoutMs = dialogTimeoutMs,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < deadline, what);
    await delay(50);
  }
}

function responsePanelTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) =>
        tab.input instanceof vscode.TabInputWebview &&
        tab.input.viewType.endsWith('streamscope.response'),
    );
}

async function dismissed(command: Thenable<unknown>): Promise<void> {
  const progress = { settled: false };
  const finished = Promise.resolve(command).finally(() => {
    progress.settled = true;
  });
  const deadline = Date.now() + dialogTimeoutMs;
  while (!progress.settled) {
    assert.ok(Date.now() < deadline, 'the dialog or pick did not close');
    await delay(250);
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  }
  await finished;
}

async function ignoresTestArguments(scratch: string): Promise<void> {
  const server = createServer((_request, response) => {
    response.end('synthetic body');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const { port } = server.address() as AddressInfo;
    const file = path.join(scratch, 'production.http');
    writeFileSync(file, `GET http://127.0.0.1:${String(port)}/synthetic`);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('streamscope.sendRequest');
    await until(() => responsePanelTabs().length === 1, 'the response panel did not open');

    const target = path.join(scratch, 'saved-by-argument.txt');
    await dismissed(
      vscode.commands.executeCommand('streamscope.saveResponse', vscode.Uri.file(target)),
    );
    assert.equal(existsSync(target), false, 'Save Response wrote to the argument it was given');

    await vscode.window.tabGroups.close(responsePanelTabs());
    await until(() => responsePanelTabs().length === 0, 'the response panel did not close');
    await dismissed(vscode.commands.executeCommand('streamscope.showHistory', 1));
    await delay(500);
    assert.equal(responsePanelTabs().length, 0, 'Show History reopened the run it was given');
  } finally {
    server.close();
  }
}

interface LiveStreamState {
  started: boolean;
  finished: boolean;
  continuedWhileOpen: boolean;
  threadId: string | undefined;
}

const syntheticThreadId = 'thread-synthetic-7f3a';
const streamHoldMs = 15_000;

function liveStreamServer(state: LiveStreamState): Server {
  const continued = { release: (): void => undefined };
  const continuation = new Promise<void>((resolve) => {
    continued.release = resolve;
  });
  return createServer((request, response) => {
    if (request.url === '/agent/run') {
      request.resume();
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write(
        [
          JSON.stringify({ type: 'RUN_STARTED', threadId: syntheticThreadId }),
          JSON.stringify({ type: 'TEXT_MESSAGE_START', messageId: 'message-synthetic-1' }),
          '',
        ].join('\n'),
      );
      state.started = true;
      const timer = setTimeout(continued.release, streamHoldMs);
      void continuation.then(() => {
        clearTimeout(timer);
        state.finished = true;
        response.end(`${JSON.stringify({ type: 'RUN_FINISHED' })}\n`);
      });
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { threadId?: unknown };
      state.threadId = typeof body.threadId === 'string' ? body.threadId : undefined;
      state.continuedWhileOpen = !state.finished;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"ok":true}');
      continued.release();
    });
  });
}

async function capturesFromALiveStream(scratch: string): Promise<void> {
  const state: LiveStreamState = {
    started: false,
    finished: false,
    continuedWhileOpen: false,
    threadId: undefined,
  };
  const server = liveStreamServer(state);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const { port } = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${String(port)}`;
    const text = [
      '### Start agent run',
      '# @name startRun',
      '# @capture threadId = first(type == "RUN_STARTED").threadId',
      `POST ${origin}/agent/run`,
      'Content-Type: application/json',
      '',
      '{"message": "hello"}',
      '',
      '### Continue',
      `POST ${origin}/agent/continue`,
      'Content-Type: application/json',
      '',
      '{"threadId": "{{startRun.threadId}}"}',
      '',
    ].join('\n');
    const file = path.join(scratch, 'live.http');
    writeFileSync(file, text);
    const lines = text.split('\n');
    const runLine = lines.indexOf(`POST ${origin}/agent/run`);
    const continueLine = lines.indexOf(`POST ${origin}/agent/continue`);
    const uri = vscode.Uri.file(file);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));

    const first = vscode.commands.executeCommand('streamscope.sendRequest', uri, runLine);
    await until(() => state.started, 'the stream did not start');
    await vscode.commands.executeCommand('streamscope.sendRequest', uri, continueLine);
    await until(() => state.threadId !== undefined, 'Continue was never sent', 20_000);

    assert.equal(
      state.threadId,
      syntheticThreadId,
      'Continue was not sent with the captured threadId',
    );
    assert.ok(state.continuedWhileOpen, 'Continue was sent only after the stream ended');
    await first;

    await until(() => responsePanelTabs().length === 2, 'both response panels did not open');
    await vscode.window.tabGroups.close(responsePanelTabs());
    await until(() => responsePanelTabs().length === 0, 'the response panels did not close');
  } finally {
    server.close();
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  assert.ok(value, `${name} is not set`);
  return value;
}

export async function run(): Promise<void> {
  const extensionId = requiredEnv('EXPECTED_EXTENSION_ID');
  const extensionsDir = requiredEnv('EXPECTED_EXTENSIONS_DIR');

  const extension = vscode.extensions.getExtension(extensionId);
  assert.ok(extension, `${extensionId} is not installed`);

  const installedFrom = realpathSync(extension.extensionPath);
  assert.ok(
    installedFrom.startsWith(extensionsDir + path.sep),
    `${extensionId} was loaded from ${installedFrom}, not from ${extensionsDir}`,
  );

  for (const file of [
    'dist/format-worker.js',
    'dist/capture-worker.js',
    'dist/response-view.js',
    'ThirdPartyNotices.txt',
    'syntaxes/http.tmLanguage.json',
    'language-configuration.json',
  ]) {
    assert.ok(existsSync(path.join(installedFrom, file)), `${file} is missing from the package`);
  }

  await extension.activate();
  assert.equal(extension.isActive, true);

  const registered = await vscode.commands.getCommands(true);
  assert.ok(registered.includes('streamscope.showLog'), 'streamscope.showLog is not registered');
  await vscode.commands.executeCommand('streamscope.showLog');

  await ignoresTestArguments(requiredEnv('SCRATCH_DIR'));
  await capturesFromALiveStream(requiredEnv('SCRATCH_DIR'));
}
