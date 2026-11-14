import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

const extensionId = 'achrafelkhnissi.streamscope';

interface ContributedCommands {
  contributes: { commands: { command: string }[] };
}

describe('extension activation', () => {
  it('activates and registers every contributed command', async () => {
    const extension = vscode.extensions.getExtension(extensionId);
    assert.ok(extension, `${extensionId} is not loaded`);

    await extension.activate();
    assert.equal(extension.isActive, true);

    const { contributes } = extension.packageJSON as ContributedCommands;
    const registered = await vscode.commands.getCommands(true);
    for (const { command } of contributes.commands) {
      assert.ok(registered.includes(command), `${command} is not registered`);
    }
  });

  it('registers the benchmark commands only when STREAMSCOPE_BENCHMARK is 1', async () => {
    await vscode.extensions.getExtension(extensionId)?.activate();

    const registered = await vscode.commands.getCommands(true);
    const enabled = process.env.STREAMSCOPE_BENCHMARK === '1';
    for (const command of [
      'streamscope.benchmark.stream',
      'streamscope.benchmark.walkthrough',
      'streamscope.benchmark.activation',
    ]) {
      assert.equal(registered.includes(command), enabled, command);
    }
  });

  it('records how long activation took', async () => {
    await vscode.extensions.getExtension(extensionId)?.activate();

    const activation = await vscode.commands.executeCommand<{ ms: number; logged: string }>(
      'streamscope.test.activation',
    );
    assert.ok(Number.isFinite(activation.ms) && activation.ms > 0, String(activation.ms));
    assert.match(activation.logged, /^Extension activated in \d+\.\d ms$/);
  });

  it('keeps the bundle in strict mode after the load-time banner', () => {
    const extension = vscode.extensions.getExtension(extensionId);
    assert.ok(extension);
    const { main } = extension.packageJSON as { main: string };
    const bundle = readFileSync(path.join(extension.extensionPath, main), 'utf8');
    assert.equal(bundle.split('\n', 1)[0], '"use strict";');
  });

  it('runs the Show Log command', async () => {
    await vscode.commands.executeCommand('streamscope.showLog');
  });
});
