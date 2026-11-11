import * as assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

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

  await extension.activate();
  assert.equal(extension.isActive, true);

  const registered = await vscode.commands.getCommands(true);
  assert.ok(registered.includes('streamscope.showLog'), 'streamscope.showLog is not registered');
  await vscode.commands.executeCommand('streamscope.showLog');
}
