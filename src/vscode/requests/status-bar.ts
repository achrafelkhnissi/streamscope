import * as vscode from 'vscode';
import { runPickItems, runStatusText, runStatusTooltip } from '../../response/run-status';
import type { RunRegistry } from '../../runs/registry';
import { LiveTicker } from '../../runs/ticker';

export const stopRunningCommand = 'streamscope.stopRunningRequest';

export class RunStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly ticker: LiveTicker;
  private readonly unsubscribe: () => void;
  private readonly command: vscode.Disposable;
  private shownText: string | undefined;

  constructor(private readonly registry: RunRegistry) {
    this.item = vscode.window.createStatusBarItem(
      'streamscope.runs',
      vscode.StatusBarAlignment.Left,
      99,
    );
    this.item.name = 'Streamscope Running Requests';
    this.item.command = stopRunningCommand;
    this.ticker = new LiveTicker(
      () => registry.isRunning(),
      () => {
        this.update();
      },
    );
    this.unsubscribe = registry.onDidChange(() => {
      this.ticker.poke();
    });
    this.command = vscode.commands.registerCommand(stopRunningCommand, () => this.stop());
  }

  text(): string | undefined {
    return this.shownText;
  }

  dispose(): void {
    this.ticker.dispose();
    this.unsubscribe();
    this.command.dispose();
    this.item.dispose();
  }

  private update(): void {
    const runs = this.registry.running().map((handle) => handle.snapshot());
    const text = runStatusText(runs);
    if (text === undefined) {
      this.shownText = undefined;
      this.item.hide();
      return;
    }
    if (text !== this.shownText) {
      this.shownText = text;
      this.item.text = text;
      this.item.show();
    }
    this.item.tooltip = runStatusTooltip(runs);
  }

  private async stop(): Promise<void> {
    const runs = this.registry.running().map((handle) => handle.snapshot());
    if (runs.length > 1) {
      const picked = await vscode.window.showQuickPick(runPickItems(runs), {
        placeHolder: 'Stop a running request',
      });
      if (picked !== undefined) {
        this.cancel(picked.key);
      }
      return;
    }
    this.cancel(runs[0]?.key);
  }

  private cancel(key: string | undefined): void {
    if (key === undefined || !this.registry.cancel(key)) {
      void vscode.window.showInformationMessage('This request is not running.');
    }
  }
}
