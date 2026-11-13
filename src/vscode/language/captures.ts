import * as vscode from 'vscode';
import { captureHint, type CaptureHint } from '../../capture/hints';
import type { CaptureRegistry } from '../../capture/registry';
import { requestKey } from '../../runs/run';
import type { ParseCache } from './parse-cache';

class CaptureInlayHint extends vscode.InlayHint {
  constructor(
    position: vscode.Position,
    readonly capture: CaptureHint,
  ) {
    super(position, capture.label);
    this.paddingLeft = true;
  }
}

export class CaptureInlayHints
  implements vscode.InlayHintsProvider<CaptureInlayHint>, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeInlayHints = this.changed.event;

  constructor(
    private readonly cache: ParseCache,
    private readonly registry: CaptureRegistry,
  ) {}

  refresh(): void {
    this.changed.fire();
  }

  provideInlayHints(document: vscode.TextDocument, range: vscode.Range): CaptureInlayHint[] {
    const uri = document.uri.toString();
    return this.cache.get(document).requests.flatMap((request, index) => {
      const shown = request.captures.filter(
        (capture) =>
          capture.range.start.line <= range.end.line && range.start.line <= capture.range.end.line,
      );
      if (shown.length === 0) {
        return [];
      }
      const key = requestKey(uri, request, index);
      return shown.flatMap(({ name, range: { end } }) => {
        const hint = captureHint(this.registry.get(key, name));
        return hint === undefined
          ? []
          : [new CaptureInlayHint(new vscode.Position(end.line, end.character), hint)];
      });
    });
  }

  resolveInlayHint(hint: CaptureInlayHint): CaptureInlayHint {
    hint.tooltip = hint.capture.tooltip;
    return hint;
  }

  dispose(): void {
    this.changed.dispose();
  }
}
