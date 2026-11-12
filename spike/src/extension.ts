import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  benchmarkCommands,
  type StreamBenchmarkRequest,
  type StreamBenchmarkResult,
  type WalkthroughRequest,
} from '../../src/benchmark/contract';
import { SpillArea } from '../../src/events/spill';
import { ResponseFileSystem } from '../../src/vscode/response/response-file-system';
import { benchmark, walkthrough, type Surface, type SurfaceResponse } from './flows';
import { statusText, type ViewName } from './format';
import { contentScheme, ContentBacking, FileBacking, fileScheme, NativeSurface } from './native';

const eventsSelector: vscode.DocumentSelector = { language: 'streamscope-events' };
const detailSelector: vscode.DocumentSelector = [
  { scheme: fileScheme, pattern: '**/event-*.json' },
  { scheme: contentScheme, pattern: '**/event-*.json' },
];

function activeUri(): vscode.Uri | undefined {
  return vscode.window.activeTextEditor?.document.uri;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const area = await SpillArea.open(path.join(context.globalStorageUri.fsPath, 'spill'));
  let number = 1;
  let running = false;
  let latest: SurfaceResponse | undefined;
  const nextNumber = (): number => number++;
  const files = new ResponseFileSystem();
  const content = new ContentBacking();
  const native: NativeSurface[] = [];
  const runningChanged = (): void => {
    const now = native.some((surface) => surface.running);
    if (now !== running) {
      running = now;
      void vscode.commands.executeCommand('setContext', 'streamscope.spikeRunning', now);
    }
  };
  const fileSurface = new NativeSurface(new FileBacking(files), area, nextNumber, runningChanged);
  const contentSurface = new NativeSurface(content, area, nextNumber, runningChanged);
  native.push(fileSurface, contentSurface);
  const surfaces = new Map<string, Surface>([
    ['native-fs', fileSurface],
    ['native-content', contentSurface],
  ]);

  const surfaceFor = (name: string): Surface => {
    const surface = surfaces.get(name);
    if (surface === undefined) {
      throw new Error(`Unknown surface ${name}.`);
    }
    return surface;
  };
  const responseFor = (uri: vscode.Uri | undefined): SurfaceResponse | undefined => {
    if (uri === undefined) {
      return latest;
    }
    for (const surface of surfaces.values()) {
      const found = surface.responseFor(uri);
      if (found !== undefined) {
        return found;
      }
    }
    return latest;
  };
  const open = async (
    name: string,
    url: string,
    column: vscode.ViewColumn,
  ): Promise<SurfaceResponse> => {
    latest = await surfaceFor(name).open(url, column);
    return latest;
  };
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  const statusTimer = setInterval(() => {
    const uri = activeUri();
    const response =
      uri === undefined
        ? undefined
        : (fileSurface.responseFor(uri) ?? contentSurface.responseFor(uri));
    if (response === undefined) {
      status.hide();
      return;
    }
    status.text = `${response.stream.running ? '$(pulse)' : '$(check)'} ${statusText(response.stream)}   ${response.captured.text()}`;
    status.command = response.stream.running
      ? { title: 'Stop', command: 'streamscope.spike.stop', arguments: [uri] }
      : undefined;
    status.show();
  }, 1000);
  const showView =
    (view: ViewName) =>
    async (uri?: vscode.Uri): Promise<void> => {
      await responseFor(uri ?? activeUri())?.showView(view);
    };

  context.subscriptions.push(
    files,
    content,
    fileSurface,
    contentSurface,
    { dispose: () => void area.dispose() },
    vscode.workspace.registerFileSystemProvider(fileScheme, files, {
      isCaseSensitive: true,
      isReadonly: true,
    }),
    vscode.workspace.registerTextDocumentContentProvider(contentScheme, content),
    vscode.languages.registerCodeLensProvider({ scheme: fileScheme }, fileSurface),
    vscode.languages.registerCodeLensProvider({ scheme: contentScheme }, contentSurface),
    vscode.languages.registerDocumentLinkProvider(eventsSelector, {
      provideDocumentLinks: (document) => {
        const links: vscode.DocumentLink[] = [];
        for (let line = 0; line < document.lineCount; line += 1) {
          const match = /^\[(\d+)\]/.exec(document.lineAt(line).text);
          if (match?.[0] !== undefined) {
            const argument = encodeURIComponent(JSON.stringify([Number(match[1])]));
            const link = new vscode.DocumentLink(
              new vscode.Range(line, 0, line, match[0].length),
              vscode.Uri.parse(`command:streamscope.spike.showDetail?${argument}`),
            );
            link.tooltip = 'Show this event';
            links.push(link);
          }
        }
        return links;
      },
    }),
    vscode.languages.registerCodeActionsProvider(
      detailSelector,
      {
        provideCodeActions: (document, range) => {
          const action = new vscode.CodeAction(
            'Capture This Value…',
            vscode.CodeActionKind.QuickFix,
          );
          action.command = {
            title: 'Capture This Value…',
            command: 'streamscope.spike.capture',
            arguments: [document.uri, range.start.line],
          };
          return [action];
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
    vscode.languages.registerCodeLensProvider(detailSelector, {
      provideCodeLenses: (document) => {
        const lenses: vscode.CodeLens[] = [];
        for (let line = 0; line < document.lineCount; line += 1) {
          const key = /^\s*"([^"]+)"\s*:/.exec(document.lineAt(line).text)?.[1];
          if (key !== undefined) {
            lenses.push(
              new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
                title: `$(target) Capture ${key}…`,
                command: 'streamscope.spike.capture',
                arguments: [document.uri, line],
              }),
            );
          }
        }
        return lenses;
      },
    }),
    status,
    {
      dispose: () => {
        clearInterval(statusTimer);
      },
    },
    vscode.workspace.onDidChangeTextDocument((event) => {
      for (const surface of native) {
        surface.documentChanged(event.document);
      }
    }),
    vscode.commands.registerCommand('streamscope.spike.showEvents', showView('events')),
    vscode.commands.registerCommand('streamscope.spike.showReply', showView('reply')),
    vscode.commands.registerCommand('streamscope.spike.showRaw', showView('raw')),
    vscode.commands.registerCommand('streamscope.spike.showHeaders', showView('headers')),
    vscode.commands.registerCommand('streamscope.spike.showBody', showView('body')),
    vscode.commands.registerCommand('streamscope.spike.showChecks', showView('checks')),
    vscode.commands.registerCommand('streamscope.spike.showDetail', async (argument?: unknown) => {
      if (typeof argument === 'number') {
        await responseFor(activeUri())?.showDetail(argument);
        return;
      }
      const editor = vscode.window.activeTextEditor;
      if (editor === undefined) {
        return;
      }
      const match = /^\[(\d+)\]/.exec(editor.document.lineAt(editor.selection.active.line).text);
      if (match !== null) {
        await responseFor(editor.document.uri)?.showDetail(Number(match[1]));
      }
    }),
    vscode.commands.registerCommand('streamscope.spike.showOlder', async (uri?: vscode.Uri) => {
      await responseFor(uri ?? activeUri())?.showOlder();
    }),
    vscode.commands.registerCommand('streamscope.spike.stop', (uri?: vscode.Uri) => {
      responseFor(uri ?? activeUri())?.stream.stop();
    }),
    vscode.commands.registerCommand(
      'streamscope.spike.capture',
      async (uri: vscode.Uri, line: number) => {
        const document = await vscode.workspace.openTextDocument(uri);
        const key = /"([^"]+)"\s*:/.exec(document.lineAt(line).text)?.[1];
        const event = /event-(\d+)\.json$/.exec(uri.path)?.[1] ?? '?';
        await vscode.window.showInformationMessage(
          `Prototype: would capture $.${key ?? '…'} from event ${event}.`,
        );
      },
    ),
    vscode.commands.registerCommand('streamscope.spike.open', async () => {
      const name = await vscode.window.showQuickPick([...surfaces.keys()], {
        placeHolder: 'Response surface',
      });
      const url = await vscode.window.showInputBox({
        prompt: 'Stream URL (npm run bench -- serve prints one)',
      });
      if (name !== undefined && url !== undefined && url !== '') {
        await open(name, url, vscode.ViewColumn.Active);
      }
    }),
    vscode.commands.registerCommand(
      benchmarkCommands.stream,
      async (request: StreamBenchmarkRequest): Promise<StreamBenchmarkResult> =>
        benchmark(await open(request.surface, request.url, vscode.ViewColumn.Two), request.surface),
    ),
    vscode.commands.registerCommand(
      benchmarkCommands.walkthrough,
      async (request: WalkthroughRequest): Promise<void> => {
        await walkthrough(
          await open(request.surface, request.url, vscode.ViewColumn.One),
          request.surface,
          request.controlUrl,
        );
      },
    ),
  );
}
