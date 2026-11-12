import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

async function names(): Promise<string[]> {
  const listed = await vscode.commands.executeCommand<string[]>('streamscope.listSecrets');
  await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  return listed;
}

describe('secrets', () => {
  after(async () => {
    await vscode.commands.executeCommand('streamscope.clearSecret', 'integrationToken');
  });

  it('stores, lists and clears a secret through the commands', async () => {
    await vscode.commands.executeCommand(
      'streamscope.setSecret',
      'integrationToken',
      'synthetic-token',
    );
    assert.ok((await names()).includes('integrationToken'));

    await vscode.commands.executeCommand('streamscope.clearSecret', 'integrationToken');
    assert.ok(!(await names()).includes('integrationToken'));
  });

  it('never shows the value in the list', async () => {
    await vscode.commands.executeCommand(
      'streamscope.setSecret',
      'integrationToken',
      'synthetic-token',
    );

    const listed = await names();

    assert.ok(listed.includes('integrationToken'));
    assert.ok(listed.every((name) => !name.includes('synthetic-token')));
  });
});
