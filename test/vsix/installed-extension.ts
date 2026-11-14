import * as assert from 'node:assert/strict';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import * as vscode from 'vscode';

const dialogTimeoutMs = 10_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + dialogTimeoutMs;
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
}
