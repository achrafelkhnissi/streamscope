import * as vscode from 'vscode';
import { offerToHideOtherSendLenses } from './vscode/coexistence';
import { EnvironmentStore } from './vscode/environments/environment-store';
import { registerEnvironmentPicker } from './vscode/environments/picker';
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
  const environments = new EnvironmentStore(context, log);
  context.subscriptions.push(environments);
  registerEnvironmentPicker(context, environments);
  registerLanguageFeatures(context, cache);
  registerRequestFeatures(context, log, cache, environments);
  void offerToHideOtherSendLenses(context);
  log.info('Extension activated');
}
