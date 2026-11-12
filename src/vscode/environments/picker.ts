import * as vscode from 'vscode';
import type { EnvironmentStore } from './environment-store';

const noEnvironment = 'No Environment';

export function registerEnvironmentPicker(
  context: vscode.ExtensionContext,
  store: EnvironmentStore,
): void {
  const item = vscode.window.createStatusBarItem(
    'streamscope.environment',
    vscode.StatusBarAlignment.Left,
    100,
  );
  item.name = 'Streamscope Environment';
  item.command = 'streamscope.selectEnvironment';
  item.tooltip = 'Select the Streamscope environment';

  const update = (): void => {
    item.text = `$(server-environment) ${store.active() ?? noEnvironment}`;
    if (vscode.window.activeTextEditor?.document.languageId === 'http') {
      item.show();
    } else {
      item.hide();
    }
  };

  const select = async (name?: string): Promise<void> => {
    if (typeof name === 'string') {
      await store.setActive(name === '' ? undefined : name);
      return;
    }
    const catalog = await store.catalogFor(vscode.window.activeTextEditor?.document.uri);
    const picked = await vscode.window.showQuickPick(
      [
        ...catalog.names.map((label) => ({
          label,
          description: label === catalog.active ? 'active' : undefined,
        })),
        { label: noEnvironment, description: catalog.active === undefined ? 'active' : undefined },
      ],
      { title: 'Streamscope Environment', placeHolder: 'Choose the environment for requests' },
    );
    if (picked) {
      await store.setActive(picked.label === noEnvironment ? undefined : picked.label);
    }
  };

  context.subscriptions.push(
    item,
    vscode.commands.registerCommand('streamscope.selectEnvironment', select),
    vscode.window.onDidChangeActiveTextEditor(update),
    store.onDidChange(update),
  );
  update();
}
