import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Streamscope', { log: true });
  context.subscriptions.push(
    log,
    vscode.commands.registerCommand('streamscope.showLog', () => {
      log.show();
    }),
  );
  log.info('Extension activated');
}
