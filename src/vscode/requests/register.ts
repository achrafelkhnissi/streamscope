import * as path from 'node:path';
import * as vscode from 'vscode';
import { benchmarkEnabled } from '../../benchmark/contract';
import type { StreamSession } from '../../events/session';
import { SpillArea } from '../../events/spill';
import type { HttpFile, HttpRequest } from '../../http-file/model';
import { fileSafeName, formatBytes, requestLabel, saveExtension } from '../../response/labels';
import { historyItems, type HistoryItem } from '../../response/run-status';
import type { BodyFileContext } from '../../runs/body-files';
import { panelViews, type PanelView } from '../../response/panel-protocol';
import { RunHistory } from '../../runs/history';
import { isActive, RunRegistry } from '../../runs/registry';
import {
  requestKey,
  requestKeyDocument,
  type RunDependencies,
  type RunHandle,
  type RunSnapshot,
  type RunStatus,
} from '../../runs/run';
import { defaultSpillLimits } from '../../streaming/limits';
import { NodeTransport } from '../../transport/node-transport';
import { confirmOnce } from '../../runs/confirm-once';
import { PanelProbe, registerBenchmarkCommands } from '../benchmark/commands';
import type { EnvironmentStore } from '../environments/environment-store';
import type { ParseCache } from '../language/parse-cache';
import { httpSelector } from '../language/register';
import { logRunEnd, logRunStart } from '../log';
import { ResponsePanels } from '../response/panels';
import { closeResponseTabs, ResponsePresenter } from '../response/presenter';
import { ResponseFileSystem, responseScheme } from '../response/response-file-system';
import { RequestCodeLenses } from './code-lens';
import { RunStatusBar } from './status-bar';
import type { SecretStore } from '../secrets/secret-store';
import { liveSystemContext } from '../system-context';
import { readRequestSettings, readSpillLimits, readStreamSettings } from './settings';
import { variablesFor } from './variables';

interface Target {
  document: vscode.TextDocument;
  file: HttpFile;
  request: HttpRequest;
  key: string;
}

const sendableSchemes: ReadonlySet<string> = new Set(['file', 'untitled']);
const historyLimit = 50;
const noHistoryMessage = 'Send a request first: this session has no history yet.';
const noResponseMessage = 'Send the request first: there is no response yet.';
const webviewPanelScheme = 'webview-panel';
const localFolderMessage = 'Save the stream to a local folder.';
const bodyMissingMessage =
  'The body of this response was not kept, so it cannot be saved to a file.';
const rawMissingMessages: Record<'unsaved' | 'unavailable', string> = {
  unsaved: 'The raw data of this stream was not saved, so it cannot be saved to a file.',
  unavailable: 'The raw data of this stream was removed, so it cannot be saved to a file.',
};
const viewTitles: Record<PanelView, string> = {
  events: 'Events',
  reply: 'Reply',
  raw: 'Raw',
  headers: 'Headers',
  body: 'Body',
  checks: 'Checks',
};

function hasResponse(run: RunSnapshot): boolean {
  return run.head !== undefined || run.status === 'failed';
}

function editorUri(value: unknown): vscode.Uri | undefined {
  return value instanceof vscode.Uri && value.scheme !== webviewPanelScheme ? value : undefined;
}

function isPanelView(value: unknown): value is PanelView {
  return typeof value === 'string' && panelViews.some((view) => view === value);
}

function bodyFiles(uri: vscode.Uri): Omit<BodyFileContext, 'restricted'> {
  if (uri.scheme !== 'file') {
    return { documentDir: undefined, containmentRoot: undefined };
  }
  const documentDir = path.dirname(uri.fsPath);
  return {
    documentDir,
    containmentRoot: vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? documentDir,
  };
}

function defaultSaveUri(run: RunSnapshot, documentUri: vscode.Uri): vscode.Uri | undefined {
  const type = run.head?.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1];
  const name = fileSafeName(run.label) + saveExtension(type, run.stream?.format?.format);
  const folder =
    documentUri.scheme === 'file'
      ? vscode.Uri.file(path.dirname(documentUri.fsPath))
      : vscode.workspace.workspaceFolders?.[0]?.uri;
  return folder ? vscode.Uri.joinPath(folder, name) : undefined;
}

function streamToSave(run: RunSnapshot): StreamSession | undefined {
  return !run.bodyKept || run.status === 'receiving' ? run.stream : undefined;
}

function missingRaw(run: RunSnapshot): 'unsaved' | 'unavailable' | undefined {
  if (run.rawData === 'unsaved') {
    return 'unsaved';
  }
  return run.rawData === 'removed' ? 'unavailable' : undefined;
}

async function openSpillArea(context: vscode.ExtensionContext): Promise<SpillArea | undefined> {
  const limits = readSpillLimits();
  if (!limits.ok) {
    void vscode.window.showErrorMessage(limits.message);
  }
  try {
    return await SpillArea.open(
      path.join(context.globalStorageUri.fsPath, 'spill'),
      limits.ok ? limits.limits : defaultSpillLimits,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(
      `Streamscope cannot save raw stream data: ${reason}. Responses still stream, but saving a stream and reading older events are unavailable.`,
    );
    return undefined;
  }
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
  environments: EnvironmentStore,
  secrets: SecretStore,
): void {
  const confirmRestrictedSend = confirmOnce(async () => {
    const choice = await vscode.window.showWarningMessage(
      'Send requests from this restricted workspace?',
      {
        modal: true,
        detail:
          'Streamscope does not read secrets, .env files, http-client.private.env.json, environments from your user settings, process variables or body files here, and ignores # @insecure.',
      },
      'Send',
    );
    return choice === 'Send';
  });
  const spill = openSpillArea(context);
  const files = new ResponseFileSystem();
  const presenter = new ResponsePresenter(
    files,
    vscode.Uri.joinPath(context.extensionUri, 'dist', 'format-worker.js').fsPath,
  );
  const dependencies: RunDependencies = {
    transport: new NodeTransport(),
    system: liveSystemContext,
    clock: () => performance.now(),
  };
  const registry = new RunRegistry(dependencies);
  const lenses = new RequestCodeLenses(cache, registry);
  const statusBar = new RunStatusBar(registry);

  const saveStream = async (stream: StreamSession, chosen: vscode.Uri): Promise<void> => {
    if (chosen.scheme !== 'file') {
      void vscode.window.showErrorMessage(localFolderMessage);
      return;
    }
    const copy = await stream.copyRaw(chosen.fsPath);
    if (copy.result === 'complete') {
      vscode.window.setStatusBarMessage(`Saved ${path.basename(chosen.fsPath)}`, 3000);
    } else if (copy.result === 'capped') {
      void vscode.window.showWarningMessage(
        `Saved the first ${formatBytes(copy.bytes)} of the stream; the rest was not kept (streamscope.stream.maxSpillSize).`,
      );
    } else {
      void vscode.window.showErrorMessage(rawMissingMessages[copy.result]);
    }
  };

  const saveRun = async (
    handle: RunHandle,
    documentUri: vscode.Uri,
    destination: vscode.Uri | undefined,
  ): Promise<void> => {
    const run = handle.snapshot();
    if (!run.head) {
      void vscode.window.showInformationMessage(noResponseMessage);
      return;
    }
    const stream = streamToSave(run);
    const missing = stream === undefined ? undefined : missingRaw(run);
    if (missing !== undefined) {
      void vscode.window.showErrorMessage(rawMissingMessages[missing]);
      return;
    }
    if (stream === undefined && run.bodySource === 'gone') {
      void vscode.window.showErrorMessage(bodyMissingMessage);
      return;
    }
    const chosen =
      destination ??
      (await vscode.window.showSaveDialog({
        defaultUri: defaultSaveUri(run, documentUri),
        saveLabel: 'Save Response',
      }));
    if (!chosen) {
      return;
    }
    if (stream !== undefined) {
      await saveStream(stream, chosen);
      return;
    }
    const body = run.bodySource === 'memory' ? run.body : await handle.readBody(run.bodyLength);
    if (body === undefined) {
      void vscode.window.showErrorMessage(bodyMissingMessage);
      return;
    }
    await vscode.workspace.fs.writeFile(chosen, body);
    vscode.window.setStatusBarMessage(`Saved ${path.basename(chosen.fsPath)}`, 3000);
  };

  const benchmark = benchmarkEnabled(
    process.env,
    context.extensionMode === vscode.ExtensionMode.Production,
  )
    ? new PanelProbe()
    : undefined;
  const panels = new ResponsePanels({
    extensionUri: context.extensionUri,
    state: context.globalState,
    presenter,
    benchmark,
    save: (run, documentUri) => saveRun(run, documentUri, undefined),
  });

  const history = new RunHistory(historyLimit, (run) => !isActive(run) && !panels.isShown(run));

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

  const responseKey = async (argument?: unknown, line?: unknown): Promise<string | undefined> => {
    const uri = editorUri(argument);
    if (uri?.scheme === responseScheme) {
      return presenter.documentFor(uri)?.key;
    }
    if (uri !== undefined) {
      return (await target(uri, typeof line === 'number' ? line : undefined))?.key;
    }
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active?.scheme === responseScheme) {
      return presenter.documentFor(active)?.key;
    }
    return panels.active() ?? (await target())?.key;
  };

  const showPanel = (key: string): boolean => {
    const latest = registry.latest(key);
    const shownUri = presenter.documentUri(key);
    if (
      latest !== undefined &&
      shownUri !== undefined &&
      presenter.run(key) !== latest &&
      hasResponse(latest.snapshot())
    ) {
      panels.show(latest, shownUri, { reveal: true, readOnly: false });
      return panels.reveal(key);
    }
    if (panels.reveal(key)) {
      return true;
    }
    const run = presenter.run(key);
    const documentUri = presenter.documentUri(key);
    if (run === undefined || documentUri === undefined) {
      return false;
    }
    panels.show(run, documentUri, { reveal: true, readOnly: false });
    return panels.reveal(key);
  };

  const send = async (
    uri?: vscode.Uri,
    line?: number,
    started?: (handle: RunHandle) => void,
  ): Promise<void> => {
    const found = await target(uri, line);
    if (!found) {
      void vscode.window.showInformationMessage(
        'Put the cursor in a request in a .http file to send it.',
      );
      return;
    }
    const settings = await readRequestSettings(found.document.uri, !vscode.workspace.isTrusted);
    if (!settings.ok) {
      void vscode.window.showErrorMessage(settings.message);
      return;
    }
    const limits = readStreamSettings(found.document.uri);
    if (!limits.ok) {
      void vscode.window.showErrorMessage(limits.message);
      return;
    }
    const { document, file, request, key } = found;
    const prepared = await variablesFor(document, file, request, environments, secrets);
    if (!prepared) {
      return;
    }
    const restricted = !vscode.workspace.isTrusted;
    const area = await spill;
    logRunStart(log, request.requestLine.method, request.requestLine.url);
    const handle = registry.start({
      key,
      label: requestLabel(request),
      file,
      request,
      bodyFiles: bodyFiles(document.uri),
      settings: { ...settings.settings, insecureEnvironment: prepared.insecureEnvironment },
      variables: prepared.variables,
      restricted,
      confirmSend: restricted ? confirmRestrictedSend : undefined,
      spill: area,
      limits: limits.limits,
    });
    history.add(handle);
    started?.(handle);
    const shown = (): boolean => presenter.run(key) === handle;
    const showRun = (): void => {
      if (!shown() && registry.latest(key) === handle) {
        panels.show(handle, document.uri, { reveal: true, readOnly: false });
      }
    };
    const stopWatching = handle.onUpdate(() => {
      if (handle.snapshot().status === 'receiving') {
        showRun();
        stopWatching();
      }
    });
    const run = await handle.done;
    stopWatching();
    logRunEnd(log, run);
    if (registry.latest(key) !== handle) {
      return;
    }
    if (run.status === 'blocked') {
      void showBlocked(document, run);
      return;
    }
    if (hasResponse(run)) {
      showRun();
    }
    if (shown()) {
      await presenter.body(handle);
    }
    lenses.refresh();
  };

  const sendRequest = (uri?: vscode.Uri, line?: number): Promise<void> => send(uri, line);

  const stopRequest = async (uri?: unknown, line?: unknown): Promise<void> => {
    const key = await responseKey(uri, line);
    if (key === undefined) {
      void vscode.window.showInformationMessage('This request is not running.');
      return;
    }
    const shown = uri === undefined && key === panels.active() ? panels.state(key) : undefined;
    const showsEarlierRun = shown?.readOnly === true && shown.run !== registry.latest(key)?.id;
    if (showsEarlierRun || !registry.cancel(key)) {
      void vscode.window.showInformationMessage('This request is not running.');
    }
  };

  const saveResponse = async (first?: unknown, second?: unknown): Promise<void> => {
    const source = editorUri(first)?.scheme === responseScheme ? editorUri(first) : undefined;
    const destination = editorUri(source ? second : first);
    const key = source ? presenter.documentFor(source)?.key : await responseKey();
    const run = key === undefined ? undefined : presenter.run(key);
    const documentUri = key === undefined ? undefined : presenter.documentUri(key);
    if (run === undefined || documentUri === undefined) {
      void vscode.window.showInformationMessage(noResponseMessage);
      return;
    }
    await saveRun(run, documentUri, destination);
  };

  const openDocument =
    (documentTarget: 'body' | 'headers') =>
    async (argument?: unknown): Promise<void> => {
      const editor = vscode.window.activeTextEditor;
      const fromDocument =
        editorUri(argument)?.scheme === responseScheme ||
        editor?.document.uri.scheme === responseScheme;
      const key = await responseKey(argument);
      if (key === undefined) {
        void vscode.window.showInformationMessage(noResponseMessage);
        return;
      }
      await presenter.open(
        key,
        documentTarget,
        fromDocument
          ? { preview: false }
          : {
              viewColumn: panels.columnBeside(key),
              preserveFocus: editor !== undefined,
              preview: false,
            },
      );
    };

  const showResponse = async (argument?: unknown, line?: unknown): Promise<void> => {
    const uri = editorUri(argument) ?? vscode.window.activeTextEditor?.document.uri;
    const document = uri?.scheme === responseScheme ? presenter.documentFor(uri) : undefined;
    const key = document?.key ?? (await responseKey(argument, line));
    if (key === undefined || !showPanel(key)) {
      void vscode.window.showInformationMessage(noResponseMessage);
      return;
    }
    if (document?.target === 'event') {
      panels.expand(key, document.index);
    } else if (document !== undefined) {
      panels.selectView(key, document.target);
    }
  };

  const reopenRun = (run: RunHandle): void => {
    const { key } = run.snapshot();
    panels.show(run, vscode.Uri.parse(requestKeyDocument(key)), { reveal: true, readOnly: true });
    panels.reveal(key);
  };

  const showHistory = async (runId?: unknown): Promise<HistoryItem[]> => {
    const items = historyItems(history.list().map((run) => run.snapshot()));
    if (typeof runId === 'number') {
      const run = history.find(runId);
      if (run !== undefined) {
        reopenRun(run);
      }
      return items;
    }
    if (items.length === 0) {
      void vscode.window.showInformationMessage(noHistoryMessage);
      return items;
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Reopen a request from this session',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    const run = picked === undefined ? undefined : history.find(picked.id);
    if (run !== undefined) {
      reopenRun(run);
    }
    return items;
  };

  const showResponseView = async (view?: unknown): Promise<void> => {
    const key = await responseKey();
    const run = key === undefined ? undefined : presenter.run(key);
    if (key === undefined || run === undefined) {
      void vscode.window.showInformationMessage(noResponseMessage);
      return;
    }
    const hasReply = run.snapshot().stream?.reply.adapter !== undefined;
    const chosen = isPanelView(view)
      ? view
      : (
          await vscode.window.showQuickPick(
            panelViews
              .filter((name) => name !== 'reply' || hasReply)
              .map((name) => ({ label: viewTitles[name], view: name })),
            { placeHolder: 'Switch the response view' },
          )
        )?.view;
    if (chosen === undefined) {
      return;
    }
    showPanel(key);
    panels.selectView(key, chosen);
  };

  context.subscriptions.push(
    files,
    lenses,
    statusBar,
    panels,
    {
      dispose: () => {
        registry.dispose();
      },
    },
    {
      dispose: () => {
        void history.dispose();
      },
    },
    {
      dispose: () => {
        void spill.then((area) => area?.dispose());
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
    vscode.commands.registerCommand('streamscope.showResponse', showResponse),
    vscode.commands.registerCommand('streamscope.showResponseView', showResponseView),
    vscode.commands.registerCommand('streamscope.showHistory', showHistory),
    vscode.commands.registerCommand('streamscope.showResponseHeaders', openDocument('headers')),
    vscode.commands.registerCommand('streamscope.showResponseBody', openDocument('body')),
  );

  void closeResponseTabs();

  if (benchmark !== undefined) {
    registerBenchmarkCommands(context, { probe: benchmark, panels, send });
  }

  if (context.extensionMode === vscode.ExtensionMode.Test) {
    const statuses = new Map<number, RunStatus>();
    const stopTracking = registry.onDidChange((snapshot) => {
      statuses.set(snapshot.id, snapshot.status);
    });
    context.subscriptions.push(
      { dispose: stopTracking },
      vscode.commands.registerCommand('streamscope.test.responseState', async (key?: unknown) => {
        const chosen = typeof key === 'string' ? key : await responseKey();
        const state = chosen === undefined ? undefined : panels.state(chosen);
        return state === undefined ? undefined : { ...state, statusBar: statusBar.text() };
      }),
      vscode.commands.registerCommand('streamscope.test.runStatus', (id?: unknown) =>
        typeof id === 'number' ? statuses.get(id) : undefined,
      ),
      vscode.commands.registerCommand('streamscope.test.closeResponseTabs', closeResponseTabs),
      vscode.commands.registerCommand('streamscope.test.bodySource', (id?: unknown) =>
        typeof id === 'number' ? history.find(id)?.snapshot().bodySource : undefined,
      ),
      vscode.commands.registerCommand('streamscope.test.newestEventInMemory', (id?: unknown) => {
        const store =
          typeof id === 'number' ? history.find(id)?.snapshot().stream?.store : undefined;
        return store === undefined ? undefined : store.inMemory(store.count) !== undefined;
      }),
    );
  }
}
