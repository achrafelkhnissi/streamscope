import * as vscode from 'vscode';
import { CaptureRegistry } from './capture/registry';
import { offerToHideOtherSendLenses } from './vscode/coexistence';
import { EnvironmentStore } from './vscode/environments/environment-store';
import { registerEnvironmentPicker } from './vscode/environments/picker';
import { registerSecretCommands } from './vscode/secrets/commands';
import { SecretStore, workspaceIdentity } from './vscode/secrets/secret-store';
import { registerLanguageFeatures } from './vscode/language/register';
import { createLanguageVariables, registerVariableFeatures } from './vscode/language/variables';
import { ParseCache } from './vscode/language/parse-cache';
import { registerRequestFeatures } from './vscode/requests/register';

let shutdown: (() => Promise<void>) | undefined;

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
  const secrets = new SecretStore(context.secrets, context.workspaceState, workspaceIdentity());
  registerSecretCommands(context, secrets);
  const captures = new CaptureRegistry();
  const variables = createLanguageVariables(context, environments, secrets, cache, captures);
  registerVariableFeatures(context, cache, variables, secrets);
  registerLanguageFeatures(context, cache, variables, captures);
  shutdown = registerRequestFeatures(context, log, cache, environments, secrets, captures);
  void offerToHideOtherSendLenses(context);
  log.info('Extension activated');
}

export async function deactivate(): Promise<void> {
  await shutdown?.();
}
