import * as vscode from 'vscode';
import type { HttpRequest } from '../../http-file/model';
import { describeOutcome } from '../../response/labels';
import type { RunRegistry } from '../../runs/registry';
import { requestKey, type RunSnapshot } from '../../runs/run';
import { LiveTicker } from '../../runs/ticker';
import type { ParseCache } from '../language/parse-cache';

function toRange(request: HttpRequest): vscode.Range {
  const { start, end } = request.requestLine.range;
  return new vscode.Range(start.line, start.character, end.line, end.character);
}

function isActive(run: RunSnapshot): boolean {
  return run.status === 'sending' || run.status === 'receiving';
}

export class RequestCodeLenses implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly ticker: LiveTicker;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly cache: ParseCache,
    private readonly registry: RunRegistry,
  ) {
    this.ticker = new LiveTicker(
      () => registry.isRunning(),
      () => {
        this.changed.fire();
      },
    );
    this.unsubscribe = registry.onDidChange(() => {
      this.refresh();
    });
  }

  refresh(): void {
    this.ticker.poke();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (
      !vscode.workspace
        .getConfiguration('streamscope.codeLens', document.uri)
        .get<boolean>('enabled', true)
    ) {
      return [];
    }
    return this.cache.get(document).requests.flatMap((request, index) => {
      const range = toRange(request);
      const line = request.requestLine.range.start.line;
      const key = requestKey(document.uri.toString(), request, index);
      const run = this.registry.latest(key)?.snapshot();
      if (run && isActive(run)) {
        return [
          new vscode.CodeLens(range, {
            title: 'Stop',
            command: 'streamscope.stopRequest',
            arguments: [document.uri, line],
          }),
          new vscode.CodeLens(range, { title: describeOutcome(run), command: '' }),
        ];
      }
      const send = new vscode.CodeLens(range, {
        title: 'Send Request',
        command: 'streamscope.sendRequest',
        arguments: [document.uri, line],
      });
      return run ? [send, this.outcome(range, run, document.uri, line)] : [send];
    });
  }

  dispose(): void {
    this.ticker.dispose();
    this.unsubscribe();
    this.changed.dispose();
  }

  private outcome(
    range: vscode.Range,
    run: RunSnapshot,
    documentUri: vscode.Uri,
    line: number,
  ): vscode.CodeLens {
    const title = describeOutcome(run);
    const problem = run.problems[0];
    if (run.status === 'blocked' && problem) {
      const { start, end } = problem.range;
      return new vscode.CodeLens(range, {
        title,
        command: 'vscode.open',
        arguments: [
          documentUri,
          { selection: new vscode.Range(start.line, start.character, end.line, end.character) },
        ],
      });
    }
    return new vscode.CodeLens(range, {
      title,
      command: 'streamscope.showResponse',
      arguments: [documentUri, line],
    });
  }
}
