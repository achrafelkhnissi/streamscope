import * as vscode from 'vscode';
import type { CheckEntry, CheckRegistry } from '../../checks/registry';
import type { ExpectDirective } from '../../http-file/model';
import { requestKey } from '../../runs/run';
import type { ParseCache } from './parse-cache';
import { checkMarkColors } from '../../response/labels';

type CheckState = CheckEntry['result']['state'];

export interface CheckDecoration {
  line: number;
  start: number;
  end: number;
  state: CheckState;
  text: string;
  hover: string;
}

const maxInlineDetail = 80;
const maxHover = 4_096;
const refreshMs = 50;

function cut(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}

function decorationOf(expect: ExpectDirective, entry: CheckEntry, end: number): CheckDecoration {
  const { result } = entry;
  const line = expect.range.start.line;
  const range = { line, start: 0, end };
  switch (result.state) {
    case 'passed':
      return { ...range, state: 'passed', text: '✓', hover: `Passed: ${entry.text}` };
    case 'failed':
      return {
        ...range,
        state: 'failed',
        text: `✗ ${cut(result.detail, maxInlineDetail)}`,
        hover: cut(`Failed: ${entry.text}\n\n${result.detail}`, maxHover),
      };
    case 'pending':
      return { ...range, state: 'pending', text: '…', hover: `Pending: ${entry.text}` };
  }
}

export function checkDecorations(
  document: vscode.TextDocument,
  cache: ParseCache,
  checks: Pick<CheckRegistry, 'forRequest'>,
): CheckDecoration[] {
  const uri = document.uri.toString();
  return cache.get(document).requests.flatMap((request, index) => {
    const entries = checks.forRequest(requestKey(uri, request, index));
    if (entries.length === 0) {
      return [];
    }
    const unused = [...entries];
    return request.expects.flatMap((expect) => {
      const at = unused.findIndex((entry) => entry.text === expect.text);
      const entry = unused[at];
      if (entry === undefined) {
        return [];
      }
      unused.splice(at, 1);
      return [
        decorationOf(expect, entry, document.lineAt(expect.range.start.line).range.end.character),
      ];
    });
  });
}

export class CheckDecorations implements vscode.Disposable {
  private readonly types: Record<CheckState, vscode.TextEditorDecorationType>;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly stop: () => void;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly cache: ParseCache,
    private readonly checks: Pick<CheckRegistry, 'forRequest' | 'onDidChange'>,
  ) {
    const type = (color: string): vscode.TextEditorDecorationType =>
      vscode.window.createTextEditorDecorationType({
        after: { color: new vscode.ThemeColor(color), margin: '0 0 0 1em' },
      });
    this.types = {
      passed: type(checkMarkColors.passed),
      failed: type(checkMarkColors.failed),
      pending: type(checkMarkColors.pending),
    };
    this.stop = checks.onDidChange(() => {
      this.schedule();
    });
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this.schedule();
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.languageId === 'http') {
          this.schedule();
        }
      }),
    );
    this.schedule();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.stop();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    for (const decoration of Object.values(this.types)) {
      decoration.dispose();
    }
  }

  private schedule(): void {
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.update();
    }, refreshMs);
  }

  private update(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const found =
        editor.document.languageId === 'http'
          ? checkDecorations(editor.document, this.cache, this.checks)
          : [];
      for (const state of ['passed', 'failed', 'pending'] as const) {
        editor.setDecorations(
          this.types[state],
          found
            .filter((decoration) => decoration.state === state)
            .map((decoration) => {
              return {
                range: new vscode.Range(
                  decoration.line,
                  decoration.start,
                  decoration.line,
                  decoration.end,
                ),
                hoverMessage: new vscode.MarkdownString().appendText(decoration.hover),
                renderOptions: { after: { contentText: decoration.text } },
              };
            }),
        );
      }
    }
  }
}
