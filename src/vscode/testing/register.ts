import * as vscode from 'vscode';
import type { CheckRegistry } from '../../checks/registry';
import { parseHttpFile } from '../../http-file/parse';
import type { ParseCache } from '../language/parse-cache';
import type { RequestFeatures } from '../requests/register';
import { HttpTestItems, maxTestFiles } from './items';
import { runTests, type TestReport } from './run';

const testedSchemes: ReadonlySet<string> = new Set(['file', 'untitled']);
const testedFiles = '**/*.{http,rest}';
const decoder = new TextDecoder();
const untrustedMessage =
  'File runs need a trusted workspace. Trust it to run requests from the Testing view.';
const noFileMessage = 'Open a .http file to run it.';

function isTested(document: vscode.TextDocument): boolean {
  return document.languageId === 'http' && testedSchemes.has(document.uri.scheme);
}

function openDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  const id = uri.toString();
  return vscode.workspace.textDocuments.find(
    (document) => document.uri.toString() === id && isTested(document),
  );
}

export class HttpTesting implements vscode.Disposable {
  readonly controller: vscode.TestController;
  readonly items: HttpTestItems;
  readonly reports: TestReport[] = [];
  private readonly profile: vscode.TestRunProfile;
  private readonly discovered = new Set<string>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private watching = false;

  constructor(
    private readonly cache: ParseCache,
    private readonly requests: RequestFeatures,
    private readonly checks: CheckRegistry,
    private readonly recording: boolean,
  ) {
    this.controller = vscode.tests.createTestController('streamscope', 'Streamscope');
    this.items = new HttpTestItems(this.controller);
    this.profile = this.controller.createRunProfile(
      'Run',
      vscode.TestRunProfileKind.Run,
      (request, token) => this.run(request, token),
      true,
    );
    this.controller.resolveHandler = (item) =>
      item?.uri === undefined ? this.discover() : this.load(item.uri);
    this.controller.refreshHandler = () => this.discover();
    for (const document of vscode.workspace.textDocuments) {
      this.syncDocument(document);
    }
    this.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((document) => {
        this.syncDocument(document);
      }),
      vscode.workspace.onDidChangeTextDocument(({ document }) => {
        this.syncDocument(document);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.closed(document.uri);
      }),
    );
  }

  async discover(): Promise<void> {
    this.watch();
    const uris = await vscode.workspace.findFiles(testedFiles, undefined, maxTestFiles);
    for (const uri of uris) {
      this.discovered.add(uri.toString());
      this.items.fileItem(uri);
    }
  }

  async load(uri: vscode.Uri): Promise<void> {
    const document = openDocument(uri);
    if (document !== undefined) {
      this.items.sync(uri, this.cache.get(document));
      return;
    }
    let text: string;
    try {
      text = decoder.decode(await vscode.workspace.fs.readFile(uri));
    } catch (error) {
      const item = this.items.get(uri);
      if (item !== undefined) {
        const reason = error instanceof Error ? error.message : String(error);
        item.error = `Streamscope could not read this file: ${reason}`;
      }
      return;
    }
    this.items.sync(uri, parseHttpFile(text));
  }

  run(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
    return runTests(
      {
        controller: this.controller,
        items: this.items,
        cache: this.cache,
        requests: this.requests,
        checks: this.checks,
        record: this.recording
          ? (report) => {
              this.reports.push(report);
            }
          : undefined,
      },
      request,
      token,
    );
  }

  async runFile(uri: vscode.Uri): Promise<void> {
    await this.load(uri);
    const item = this.items.get(uri);
    if (item === undefined) {
      return;
    }
    const source = new vscode.CancellationTokenSource();
    try {
      await this.run(new vscode.TestRunRequest([item], undefined, this.profile), source.token);
    } finally {
      source.dispose();
    }
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.controller.dispose();
  }

  private syncDocument(document: vscode.TextDocument): void {
    if (isTested(document)) {
      this.items.sync(document.uri, this.cache.get(document));
    } else {
      this.closed(document.uri);
    }
  }

  private closed(uri: vscode.Uri): void {
    if (this.items.get(uri) === undefined || openDocument(uri) !== undefined) {
      return;
    }
    if (!this.discovered.has(uri.toString())) {
      this.items.remove(uri);
    } else if (this.items.isResolved(uri)) {
      void this.load(uri);
    }
  }

  private watch(): void {
    if (this.watching) {
      return;
    }
    this.watching = true;
    const watcher = vscode.workspace.createFileSystemWatcher(testedFiles);
    this.subscriptions.push(
      watcher,
      watcher.onDidCreate((uri) => {
        if (this.discovered.size < maxTestFiles) {
          this.discovered.add(uri.toString());
          this.items.fileItem(uri);
        }
      }),
      watcher.onDidChange((uri) => {
        if (this.items.isResolved(uri) && openDocument(uri) === undefined) {
          void this.load(uri);
        }
      }),
      watcher.onDidDelete((uri) => {
        this.discovered.delete(uri.toString());
        if (openDocument(uri) === undefined) {
          this.items.remove(uri);
        }
      }),
    );
  }
}

export function registerTesting(
  context: vscode.ExtensionContext,
  cache: ParseCache,
  requests: RequestFeatures,
  checks: CheckRegistry,
): void {
  const testMode = context.extensionMode === vscode.ExtensionMode.Test;
  let testing: HttpTesting | undefined;
  const create = (): void => {
    if (testing === undefined && vscode.workspace.isTrusted) {
      testing = new HttpTesting(cache, requests, checks, testMode);
      context.subscriptions.push(testing);
    }
  };
  create();
  const runFileCommand = async (argument?: unknown): Promise<void> => {
    if (testing === undefined) {
      void vscode.window.showInformationMessage(untrustedMessage);
      return;
    }
    const uri =
      argument instanceof vscode.Uri ? argument : vscode.window.activeTextEditor?.document.uri;
    const document = uri === undefined ? undefined : await vscode.workspace.openTextDocument(uri);
    if (document === undefined || !isTested(document)) {
      void vscode.window.showInformationMessage(noFileMessage);
      return;
    }
    await testing.runFile(document.uri);
  };
  context.subscriptions.push(
    vscode.workspace.onDidGrantWorkspaceTrust(create),
    vscode.commands.registerCommand('streamscope.runFile', runFileCommand),
  );
  if (testMode) {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        'streamscope.test.testReports',
        () => testing?.reports.splice(0) ?? [],
      ),
      vscode.commands.registerCommand(
        'streamscope.test.testItems',
        (uri?: unknown) =>
          testing?.items.describe(uri instanceof vscode.Uri ? uri : undefined) ?? [],
      ),
      vscode.commands.registerCommand('streamscope.test.resolveTests', async (uri?: unknown) => {
        if (testing === undefined) {
          return;
        }
        await (uri instanceof vscode.Uri ? testing.load(uri) : testing.discover());
      }),
    );
  }
}
