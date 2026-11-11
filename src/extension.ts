import * as vscode from 'vscode';
import { registerLanguageFeatures } from './vscode/language/register';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Streamscope', { log: true });
  context.subscriptions.push(
    log,
    vscode.commands.registerCommand('streamscope.showLog', () => {
      log.show();
    }),
  );
  registerLanguageFeatures(context);
  log.info('Extension activated');
}
