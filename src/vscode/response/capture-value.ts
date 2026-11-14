import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  captureNameProblem,
  invalidNameMessage,
  parseCaptureNameInput,
} from '../../capture/capture-line';
import { planValueCapture, positionMessage, type ValueTarget } from '../../capture/value-capture';
import type { StreamEvent } from '../../events/model';
import { capturedNames, placeCapture } from '../../http-file/capture-placement';
import type { HttpRequest } from '../../http-file/model';
import {
  JsonPositionScanner,
  jsonPathAt,
  type PathSegment,
  type PositionResult,
} from '../../response/json-position';
import { detailText, isEventStream } from '../../response/panel-content';
import type { FromPanel, PanelBody } from '../../response/panel-protocol';
import { findRequest, requestKey, requestKeyDocument, type RunHandle } from '../../runs/run';
import type { ParseCache } from '../language/parse-cache';
import type { ResponsePresenter } from './presenter';

export type PanelCaptureMessage = Extract<FromPanel, { type: 'capture' }>;

export interface NameQuestion {
  value: string;
  prompt: string;
  validate: (input: string) => string | vscode.InputBoxValidationMessage | undefined;
}

export interface ValueCaptureOptions {
  cache: ParseCache;
  presenter: ResponsePresenter;
  askName(question: NameQuestion): Promise<string | undefined>;
  definedNames(document: vscode.TextDocument): Promise<ReadonlySet<string>>;
}

type Located = { ok: true; segments: PathSegment[] } | { ok: false; message: string };

export const captureWhereMessage = 'Capture This Value works in an event or Body document.';
const releasedMessage = 'This response is no longer available.';
const progressDelayMs = 500;
const scanChars = 1_048_576;
const promptExpressionLength = 200;
const statusMs = 5000;

function warn(message: string): void {
  void vscode.window.showWarningMessage(message);
}

function located(result: PositionResult): Located {
  return result.ok
    ? { ok: true, segments: result.segments }
    : { ok: false, message: positionMessage(result.problem) };
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function cut(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}

function documentLines(document: vscode.TextDocument): string[] {
  return Array.from({ length: document.lineCount }, (_, line) => document.lineAt(line).text);
}

async function withDelayedProgress<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const pending = work(controller.signal);
  let settled = false;
  const done = (): void => {
    settled = true;
  };
  pending.then(done, done);
  const timer = setTimeout(() => {
    if (settled) {
      return;
    }
    vscode.window
      .withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Finding which occurrence this event is…',
          cancellable: true,
        },
        (_progress, token) => {
          token.onCancellationRequested(() => {
            controller.abort();
          });
          return pending;
        },
      )
      .then(undefined, () => undefined);
  }, progressDelayMs);
  try {
    return await pending;
  } finally {
    clearTimeout(timer);
  }
}

export class ValueCapture {
  constructor(private readonly options: ValueCaptureOptions) {}

  async fromPanel(run: RunHandle, message: PanelCaptureMessage, body: PanelBody): Promise<void> {
    if (message.target === 'body') {
      const text =
        (body.kind === 'text' || body.kind === 'preview') && body.language === 'json'
          ? body.text
          : undefined;
      const found: Located =
        text === undefined
          ? { ok: false, message: positionMessage('not-json') }
          : located(jsonPathAt(text, message.offset));
      await this.captureLocated(run, { kind: 'body' }, found);
      return;
    }
    const event = await this.event(run, message.index);
    if (event === undefined) {
      warn(releasedMessage);
      return;
    }
    const found: Located =
      event.kind === 'json'
        ? located(jsonPathAt(detailText(event).text, message.offset))
        : { ok: true, segments: [] };
    await this.captureLocated(run, { kind: 'event', event }, found);
  }

  async fromEditor(editor: vscode.TextEditor): Promise<void> {
    const shown = this.options.presenter.documentFor(editor.document.uri);
    const run = shown === undefined ? undefined : this.options.presenter.run(shown.key);
    if (shown === undefined || run === undefined) {
      warn(releasedMessage);
      return;
    }
    if (shown.target === 'event') {
      const event = await this.event(run, shown.index);
      if (event === undefined) {
        warn(releasedMessage);
        return;
      }
      const found: Located =
        event.kind === 'json'
          ? await this.scan(editor, shown.jsonStart)
          : { ok: true, segments: [] };
      await this.captureLocated(run, { kind: 'event', event }, found);
      return;
    }
    if (shown.target === 'headers') {
      warn(captureWhereMessage);
      return;
    }
    await this.captureLocated(run, { kind: 'body' }, await this.scan(editor, 0));
  }

  private async event(run: RunHandle, index: number): Promise<StreamEvent | undefined> {
    const snapshot = run.snapshot();
    return snapshot.released ? undefined : snapshot.stream?.store.read(index);
  }

  private async scan(editor: vscode.TextEditor, jsonStart: number): Promise<Located> {
    const { document, selection } = editor;
    const offset = document.offsetAt(selection.start) - jsonStart;
    if (offset < 0) {
      return { ok: false, message: positionMessage('no-value') };
    }
    const end = document.lineAt(selection.start.line).range.end;
    const text = document.getText(new vscode.Range(document.positionAt(jsonStart), end));
    const scanner = new JsonPositionScanner(text, offset);
    for (;;) {
      const result = scanner.step(scanChars);
      if (result !== undefined) {
        return located(result);
      }
      await nextTask();
    }
  }

  private async captureLocated(run: RunHandle, target: ValueTarget, found: Located) {
    if (!found.ok) {
      warn(found.message);
      return;
    }
    const snapshot = run.snapshot();
    if (snapshot.released) {
      warn(releasedMessage);
      return;
    }
    const documentUri = vscode.Uri.parse(requestKeyDocument(snapshot.key));
    const fileName = path.basename(documentUri.path);
    const gone = `The request that produced this response is no longer in ${fileName}.`;
    const document = await vscode.workspace.openTextDocument(documentUri).then(
      (opened) => opened,
      () => undefined,
    );
    const request = document === undefined ? undefined : this.request(document, snapshot.key);
    if (document === undefined || request === undefined) {
      warn(gone);
      return;
    }
    const stream =
      snapshot.stream !== undefined && isEventStream(snapshot)
        ? { events: snapshot.stream.store, typeFields: snapshot.stream.typeFields }
        : undefined;
    const taken = capturedNames(request);
    const defined = await this.options.definedNames(document);
    const plan = await withDelayedProgress((signal) =>
      planValueCapture({
        target,
        segments: found.segments,
        stream,
        taken: new Set([...taken, ...defined]),
        sensitiveValues: snapshot.sensitiveValues,
        signal,
      }),
    );
    if (!plan.ok) {
      if ('message' in plan) {
        warn(plan.message);
      }
      return;
    }
    const early = placeCapture({
      request,
      lines: documentLines(document),
      name: plan.suggestedName,
      secret: false,
      expression: plan.expression,
    });
    if (!early.ok) {
      warn(early.message);
      return;
    }
    const answer = await this.options.askName({
      value: plan.suggestedName,
      prompt: `Name for ${cut(plan.expression, promptExpressionLength)}. Start with "secret " to mask the value.`,
      validate: (input) => {
        const problem = captureNameProblem(input, taken, defined);
        if (problem === undefined) {
          return undefined;
        }
        return problem.warning
          ? { message: problem.message, severity: vscode.InputBoxValidationSeverity.Warning }
          : problem.message;
      },
    });
    if (answer === undefined) {
      return;
    }
    const chosen = parseCaptureNameInput(answer);
    if (chosen === undefined) {
      warn(invalidNameMessage);
      return;
    }
    const current = this.request(document, snapshot.key);
    if (current === undefined) {
      warn(gone);
      return;
    }
    const placement = placeCapture({
      request: current,
      lines: documentLines(document),
      name: chosen.name,
      secret: chosen.secret || plan.sensitive,
      expression: plan.expression,
    });
    if (!placement.ok) {
      warn(placement.message);
      return;
    }
    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, new vscode.Position(placement.line, 0), `${placement.text}${eol}`);
    if (!(await vscode.workspace.applyEdit(edit))) {
      void vscode.window.showErrorMessage(`Streamscope could not add the capture to ${fileName}.`);
      return;
    }
    const column =
      vscode.window.visibleTextEditors.find((editor) => editor.document === document)?.viewColumn ??
      vscode.ViewColumn.One;
    await vscode.window.showTextDocument(document, {
      viewColumn: column,
      preview: false,
      selection: new vscode.Range(placement.line, 0, placement.line, placement.text.length),
    });
    const label = snapshot.label;
    vscode.window.setStatusBarMessage(
      `Added ${chosen.name} to ${label}; it takes its value the next time ${label} runs.`,
      statusMs,
    );
  }

  private request(document: vscode.TextDocument, key: string): HttpRequest | undefined {
    const uri = document.uri.toString();
    const file = this.options.cache.get(document);
    const matching = file.requests.filter(
      (request, index) => requestKey(uri, request, index) === key,
    );
    return matching.length > 1 ? undefined : findRequest(uri, file, key);
  }
}
