import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { HttpFile, HttpRequest } from '../../http-file/model';
import { fileSafeName, requestLabel, saveExtension } from '../../response/labels';
import type { BodyFileContext } from '../../runs/body-files';
import { RunRegistry } from '../../runs/registry';
import { requestKey, type RunDependencies, type RunSnapshot } from '../../runs/run';
import { NodeTransport } from '../../transport/node-transport';
import type { ParseCache } from '../language/parse-cache';
import { httpSelector } from '../language/register';
import { logRunEnd, logRunStart } from '../log';
import { ResponsePresenter, type ResponseSlot } from '../response/presenter';
import { ResponseFileSystem, responseScheme } from '../response/response-file-system';
import { RequestCodeLenses } from './code-lens';
import { readRequestSettings } from './settings';

interface Target {
  document: vscode.TextDocument;
  file: HttpFile;
  request: HttpRequest;
  key: string;
}

const sendableSchemes: ReadonlySet<string> = new Set(['file', 'untitled']);
const noResponseMessage = 'Send the request first: there is no response yet.';

function bodyFiles(uri: vscode.Uri): BodyFileContext {
  if (uri.scheme !== 'file') {
    return { documentDir: undefined, containmentRoot: undefined };
  }
  const documentDir = path.dirname(uri.fsPath);
  return {
    documentDir,
    containmentRoot: vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? documentDir,
  };
}

function defaultSaveUri(slot: ResponseSlot): vscode.Uri | undefined {
  const name = fileSafeName(slot.run.label) + saveExtension(slot.contentType);
  const folder =
    slot.documentUri.scheme === 'file'
      ? vscode.Uri.file(path.dirname(slot.documentUri.fsPath))
      : vscode.workspace.workspaceFolders?.[0]?.uri;
  return folder ? vscode.Uri.joinPath(folder, name) : undefined;
}

async function showBlocked(document: vscode.TextDocument, run: RunSnapshot): Promise<void> {
  const problem = run.problems[0];
  if (!problem) {
    return;
  }
  const { start, end } = problem.range;
  const choice = await vscode.window.showErrorMessage(
    `Not sent: ${problem.message} (line ${String(start.line + 1)}).`,
    'Go to Line',
  );
  if (choice === 'Go to Line') {
    await vscode.window.showTextDocument(document, {
      selection: new vscode.Range(start.line, start.character, end.line, end.character),
    });
  }
}

export function registerRequestFeatures(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
  cache: ParseCache,
): void {
  const files = new ResponseFileSystem();
  const presenter = new ResponsePresenter(
    files,
    vscode.Uri.joinPath(context.extensionUri, 'dist', 'format-worker.js').fsPath,
  );
  const dependencies: RunDependencies = {
    transport: new NodeTransport(),
    system: {
      now: () => new Date(),
      uuid: () => randomUUID(),
      randomInt: (minInclusive, maxExclusive) =>
        minInclusive + Math.floor(Math.random() * (maxExclusive - minInclusive)),
    },
    clock: () => performance.now(),
  };
  const registry = new RunRegistry(dependencies);
  const lenses = new RequestCodeLenses(cache, registry, presenter);

  const target = async (uri?: vscode.Uri, line?: number): Promise<Target | undefined> => {
    const editor = vscode.window.activeTextEditor;
    const document = uri ? await vscode.workspace.openTextDocument(uri) : editor?.document;
    if (!document || document.languageId !== 'http' || !sendableSchemes.has(document.uri.scheme)) {
      return undefined;
    }
    const cursor = uri ? (line ?? 0) : (editor?.selection.active.line ?? 0);
    const file = cache.get(document);
    const index = file.requests.findIndex(
      (request) => request.range.start.line <= cursor && cursor <= request.range.end.line,
    );
    const request = file.requests[index];
    return request
      ? { document, file, request, key: requestKey(document.uri.toString(), request, index) }
      : undefined;
  };

  const activeSlot = async (): Promise<ResponseSlot | undefined> => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme === responseScheme) {
      return presenter.slotForUri(uri);
    }
    const found = await target();
    return found ? presenter.slotForKey(found.key) : undefined;
  };

  const sendRequest = async (uri?: vscode.Uri, line?: number): Promise<void> => {
    const found = await target(uri, line);
    if (!found) {
      void vscode.window.showInformationMessage(
        'Put the cursor in a request in a .http file to send it.',
      );
      return;
    }
    const settings = await readRequestSettings(found.document.uri);
    if (!settings.ok) {
      void vscode.window.showErrorMessage(settings.message);
      return;
    }
    const { document, file, request, key } = found;
    logRunStart(log, request.requestLine.method, request.requestLine.url);
    const run = await registry.start({
      key,
      label: requestLabel(request),
      file,
      request,
      bodyFiles: bodyFiles(document.uri),
      settings: settings.settings,
    }).done;
    logRunEnd(log, run);
    if (registry.latest(key)?.id !== run.id) {
      return;
    }
    if (run.status === 'blocked') {
      void showBlocked(document, run);
      return;
    }
    await presenter.show(run, document.uri);
    lenses.refresh();
  };

  const stopRequest = async (uri?: vscode.Uri, line?: number): Promise<void> => {
    const active = vscode.window.activeTextEditor?.document.uri;
    const key =
      !uri && active?.scheme === responseScheme
        ? presenter.slotForUri(active)?.key
        : (await target(uri, line))?.key;
    if (key === undefined || !registry.cancel(key)) {
      void vscode.window.showInformationMessage('This request is not running.');
    }
  };

  const saveResponse = async (destination?: vscode.Uri): Promise<void> => {
    const slot = await activeSlot();
    if (!slot?.run.head) {
      void vscode.window.showInformationMessage(noResponseMessage);
      return;
    }
    const chosen =
      destination ??
      (await vscode.window.showSaveDialog({
        defaultUri: defaultSaveUri(slot),
        saveLabel: 'Save Response',
      }));
    if (!chosen) {
      return;
    }
    await vscode.workspace.fs.writeFile(chosen, slot.run.body);
    vscode.window.setStatusBarMessage(`Saved ${path.basename(chosen.fsPath)}`, 3000);
  };

  const showView = (pick: (slot: ResponseSlot) => vscode.Uri) => async (): Promise<void> => {
    const slot = await activeSlot();
    if (!slot) {
      void vscode.window.showInformationMessage(noResponseMessage);
      return;
    }
    const fromResponse = vscode.window.activeTextEditor?.document.uri.scheme === responseScheme;
    await vscode.commands.executeCommand(
      'vscode.open',
      pick(slot),
      fromResponse
        ? { preview: false }
        : { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true, preview: false },
    );
  };

  context.subscriptions.push(
    files,
    lenses,
    {
      dispose: () => {
        registry.dispose();
      },
    },
    vscode.workspace.registerFileSystemProvider(responseScheme, files, {
      isCaseSensitive: true,
      isReadonly: true,
    }),
    vscode.languages.registerCodeLensProvider(httpSelector, lenses),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('streamscope.codeLens')) {
        lenses.refresh();
      }
    }),
    vscode.commands.registerCommand('streamscope.sendRequest', sendRequest),
    vscode.commands.registerCommand('streamscope.stopRequest', stopRequest),
    vscode.commands.registerCommand('streamscope.saveResponse', saveResponse),
    vscode.commands.registerCommand(
      'streamscope.showResponseHeaders',
      showView((slot) => slot.headersUri),
    ),
    vscode.commands.registerCommand(
      'streamscope.showResponseBody',
      showView((slot) => slot.bodyUri),
    ),
  );
}
