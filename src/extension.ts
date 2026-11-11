import * as vscode from 'vscode';
import { offerToHideOtherSendLenses } from './vscode/coexistence';
import { registerLanguageFeatures } from './vscode/language/register';
import { ParseCache } from './vscode/language/parse-cache';
import { registerRequestFeatures } from './vscode/requests/register';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Streamscope', { log: true });
  const cache = new ParseCache();
  context.subscriptions.push(
    log,
    vscode.commands.registerCommand('streamscope.showLog', () => {
      log.show();
    }),
  );
  registerLanguageFeatures(context, cache);
  registerRequestFeatures(context, log, cache);
  void offerToHideOtherSendLenses(context);
  log.info('Extension activated');
}
