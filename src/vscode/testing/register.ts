import * as vscode from 'vscode';
import { parseHttpFile } from '../../http-file/parse';
import type { ParseCache } from '../language/parse-cache';
import { HttpTestItems, maxTestFiles } from './items';

const testedSchemes: ReadonlySet<string> = new Set(['file', 'untitled']);
const testedFiles = '**/*.{http,rest}';
const decoder = new TextDecoder();

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
  private readonly discovered = new Set<string>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private watching = false;

  constructor(private readonly cache: ParseCache) {
    this.controller = vscode.tests.createTestController('streamscope', 'Streamscope');
    this.items = new HttpTestItems(this.controller);
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

export function registerTesting(context: vscode.ExtensionContext, cache: ParseCache): void {
  let testing: HttpTesting | undefined;
  const create = (): void => {
    if (testing === undefined && vscode.workspace.isTrusted) {
      testing = new HttpTesting(cache);
      context.subscriptions.push(testing);
    }
  };
  create();
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(create));
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    context.subscriptions.push(
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
