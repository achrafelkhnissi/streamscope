import * as vscode from 'vscode';
import type { SecretStore } from './secret-store';

const namePattern = /^[\w.-]+$/;
const noSecrets = 'No secrets are stored for this workspace.';

function validName(value: string): string | undefined {
  return namePattern.test(value) ? undefined : 'Use letters, digits, ".", "-" or "_".';
}

export function askForSecret(name: string): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    title: `Secret ${name}`,
    prompt: 'Stored in VS Code secret storage for this workspace.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value === '' ? 'Enter a value.' : undefined),
  });
}

export function registerSecretCommands(context: vscode.ExtensionContext, store: SecretStore): void {
  const setSecret = async (name?: unknown, value?: unknown): Promise<void> => {
    const chosen =
      typeof name === 'string'
        ? name
        : await vscode.window.showInputBox({
            title: 'Set Secret',
            prompt: 'The name used in {{$secret name}}.',
            validateInput: validName,
          });
    if (chosen === undefined) {
      return;
    }
    if (validName(chosen) !== undefined) {
      void vscode.window.showErrorMessage(`"${chosen}" is not a valid secret name.`);
      return;
    }
    const secret = typeof value === 'string' ? value : await askForSecret(chosen);
    if (secret === undefined || secret === '') {
      return;
    }
    await store.set(chosen, secret);
    void vscode.window.showInformationMessage(`Stored secret ${chosen}.`);
  };

  const clearSecret = async (name?: unknown): Promise<void> => {
    const names = store.names();
    if (typeof name !== 'string' && names.length === 0) {
      void vscode.window.showInformationMessage(noSecrets);
      return;
    }
    const chosen =
      typeof name === 'string'
        ? name
        : await vscode.window.showQuickPick(names, { title: 'Clear Secret' });
    if (chosen === undefined) {
      return;
    }
    await store.clear(chosen);
    void vscode.window.showInformationMessage(`Cleared secret ${chosen}.`);
  };

  const manage = async (names: string[]): Promise<void> => {
    const chosen = await vscode.window.showQuickPick(
      names.map((label) => ({ label, description: 'stored' })),
      { title: 'Streamscope Secrets' },
    );
    if (!chosen) {
      return;
    }
    const action = await vscode.window.showQuickPick(['Set New Value', 'Clear'], {
      title: `Secret ${chosen.label}`,
    });
    if (action === 'Set New Value') {
      await setSecret(chosen.label);
    } else if (action === 'Clear') {
      await clearSecret(chosen.label);
    }
  };

  const listSecrets = (): string[] => {
    const names = store.names();
    if (names.length === 0) {
      void vscode.window.showInformationMessage(noSecrets);
    } else {
      void manage(names);
    }
    return names;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('streamscope.setSecret', setSecret),
    vscode.commands.registerCommand('streamscope.clearSecret', clearSecret),
    vscode.commands.registerCommand('streamscope.listSecrets', listSecrets),
  );
}
