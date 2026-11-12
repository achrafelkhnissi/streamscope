import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { panelBody } from '../../response/panel-content';
import { PanelFeed } from '../../response/panel-feed';
import { panelHtml } from '../../response/panel-html';
import { parsePanelMessage, type PanelBody, type PanelView } from '../../response/panel-protocol';
import type { RunHandle, RunStatus } from '../../runs/run';
import { formatLabel } from '../../streaming/detect';
import { readDefaultView } from '../requests/settings';
import type { ResponsePresenter } from './presenter';

export interface ResponseState {
  key: string;
  run: number;
  view: PanelView;
  status: RunStatus;
  events: number;
  rendered: number;
  format: string | undefined;
  body: PanelBody['kind'];
  visible: boolean;
  readOnly: boolean;
}

export interface ResponsePanelsOptions {
  extensionUri: vscode.Uri;
  state: vscode.Memento;
  presenter: ResponsePresenter;
  save(run: RunHandle, documentUri: vscode.Uri): Promise<void>;
}

interface Entry {
  key: string;
  run: RunHandle;
  feed: PanelFeed;
  documentUri: vscode.Uri;
  readOnly: boolean;
  panel: vscode.WebviewPanel | undefined;
  listeners: vscode.Disposable[];
  ready: boolean;
  unsubscribe: () => void;
  ticker: ReturnType<typeof setInterval> | undefined;
}

export const responseViewType = 'streamscope.response';

const lastViewKey = 'streamscope.view.last';
const rememberedViews: readonly PanelView[] = ['events', 'reply', 'raw'];
const tickMs = 1000;
const columns: readonly vscode.ViewColumn[] = [
  vscode.ViewColumn.One,
  vscode.ViewColumn.Two,
  vscode.ViewColumn.Three,
  vscode.ViewColumn.Four,
  vscode.ViewColumn.Five,
  vscode.ViewColumn.Six,
  vscode.ViewColumn.Seven,
  vscode.ViewColumn.Eight,
  vscode.ViewColumn.Nine,
];

function reportFailure(action: string): (error: unknown) => void {
  return (error) => {
    const reason = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Streamscope could not ${action}: ${reason}`);
  };
}

function isRunning(run: RunHandle): boolean {
  const { status } = run.snapshot();
  return status === 'sending' || status === 'receiving';
}

export class ResponsePanels implements vscode.Disposable {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly options: ResponsePanelsOptions) {}

  show(
    run: RunHandle,
    documentUri: vscode.Uri,
    options: { reveal: boolean; readOnly: boolean },
  ): void {
    const key = run.snapshot().key;
    const existing = this.entries.get(key);
    if (existing?.run === run) {
      if (options.reveal) {
        this.revealEntry(existing, true);
      }
      return;
    }
    this.options.presenter.attach(run, documentUri);
    const entry = existing ?? this.create(key, run, documentUri, options.readOnly);
    if (existing !== undefined) {
      this.detach(existing);
      existing.run = run;
      existing.documentUri = documentUri;
      existing.readOnly = options.readOnly;
      existing.feed = this.feed(key, run, options.readOnly);
    }
    entry.unsubscribe = run.onUpdate(() => {
      entry.feed.refresh();
    });
    run.done.then(() => this.ended(entry, run)).catch(reportFailure('show the response body'));
    if (entry.panel === undefined) {
      this.open(entry, false);
      return;
    }
    entry.panel.title = run.snapshot().label;
    if (entry.ready) {
      entry.feed.start();
      this.tick(entry);
    }
    if (options.reveal) {
      this.revealEntry(entry, true);
    }
  }

  reveal(key: string, preserveFocus = false): boolean {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return false;
    }
    this.revealEntry(entry, preserveFocus);
    return true;
  }

  selectView(key: string, view: PanelView): void {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return;
    }
    entry.feed.select(view);
    this.remember(entry, view);
    if (entry.panel?.visible !== true) {
      this.revealEntry(entry, true);
    }
  }

  expand(key: string, index: number): void {
    const entry = this.entries.get(key);
    if (entry !== undefined && index >= 1 && index <= entry.feed.count) {
      entry.feed.expand(index);
    }
  }

  state(key: string): ResponseState | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    const snapshot = entry.run.snapshot();
    const format = snapshot.stream?.format;
    return {
      key,
      run: entry.run.id,
      view: entry.feed.view,
      status: snapshot.status,
      events: snapshot.stream?.store.count ?? 0,
      rendered: entry.feed.rendered,
      format: format === undefined ? undefined : formatLabel(format),
      body: entry.feed.body.kind,
      visible: entry.panel?.visible ?? false,
      readOnly: entry.readOnly,
    };
  }

  active(): string | undefined {
    for (const entry of this.entries.values()) {
      if (entry.panel?.active === true) {
        return entry.key;
      }
    }
    return undefined;
  }

  columnBeside(key: string): vscode.ViewColumn {
    const column = this.entries.get(key)?.panel?.viewColumn;
    return column === undefined
      ? vscode.ViewColumn.Beside
      : (columns[Math.min(column, columns.length - 1)] ?? vscode.ViewColumn.Beside);
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      this.detach(entry);
      for (const listener of entry.listeners.splice(0)) {
        listener.dispose();
      }
      entry.panel?.dispose();
    }
    this.entries.clear();
  }

  private create(key: string, run: RunHandle, documentUri: vscode.Uri, readOnly: boolean): Entry {
    const entry: Entry = {
      key,
      run,
      feed: this.feed(key, run, readOnly),
      documentUri,
      readOnly,
      panel: undefined,
      listeners: [],
      ready: false,
      unsubscribe: () => undefined,
      ticker: undefined,
    };
    this.entries.set(key, entry);
    return entry;
  }

  private feed(key: string, run: RunHandle, readOnly: boolean): PanelFeed {
    return new PanelFeed(run, {
      readOnly,
      streamView: this.streamView(),
      post: (message) => {
        const entry = this.entries.get(key);
        if (entry?.run === run && entry.ready) {
          void entry.panel?.webview.postMessage(message);
        }
      },
    });
  }

  private streamView(): PanelView {
    const saved = this.options.state.get<string>(lastViewKey);
    return rememberedViews.find((view) => view === saved) ?? readDefaultView();
  }

  private remember(entry: Entry, view: PanelView): void {
    if (entry.feed.stream && rememberedViews.includes(view)) {
      void this.options.state.update(lastViewKey, view);
    }
  }

  private open(entry: Entry, focus: boolean): void {
    const dist = vscode.Uri.joinPath(this.options.extensionUri, 'dist');
    const title = entry.run.snapshot().label;
    const panel = vscode.window.createWebviewPanel(
      responseViewType,
      title,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: !focus },
      {
        enableScripts: true,
        enableForms: false,
        localResourceRoots: [dist],
        retainContextWhenHidden: false,
      },
    );
    panel.webview.html = panelHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview
        .asWebviewUri(vscode.Uri.joinPath(dist, 'response-view.js'))
        .toString(),
      nonce: randomBytes(16).toString('base64'),
      title,
    });
    entry.panel = panel;
    entry.ready = false;
    entry.listeners = [
      panel.webview.onDidReceiveMessage((value: unknown) => {
        if (entry.panel === panel) {
          this.receive(entry, value);
        }
      }),
      panel.onDidChangeViewState(() => {
        if (entry.panel === panel && !panel.visible) {
          this.hide(entry);
        }
      }),
      panel.onDidDispose(() => {
        if (entry.panel === panel) {
          this.closed(entry);
        }
      }),
    ];
  }

  private receive(entry: Entry, value: unknown): void {
    const message = parsePanelMessage(value, entry.feed.count);
    if (message === undefined || ('run' in message && message.run !== entry.run.id)) {
      return;
    }
    switch (message.type) {
      case 'ready':
        entry.ready = true;
        entry.feed.start();
        this.tick(entry);
        return;
      case 'window':
        void entry.feed.window(message.start, message.end, message.following);
        return;
      case 'rendered':
        entry.feed.acknowledge(message.newest);
        return;
      case 'detail':
        void entry.feed.detail(message.index);
        return;
      case 'stop':
        if (!entry.readOnly) {
          entry.run.cancel();
        }
        return;
      case 'save':
        this.options.save(entry.run, entry.documentUri).catch(reportFailure('save the response'));
        return;
      case 'tab':
        entry.feed.pick(message.view);
        this.remember(entry, message.view);
        return;
      case 'open':
        this.options.presenter
          .open(entry.key, message.target, this.besidePanel(entry))
          .catch(reportFailure(`open the response ${message.target} in the editor`));
        return;
      case 'openEvent':
        this.options.presenter
          .openEvent(entry.run, message.index, this.besidePanel(entry))
          .catch(reportFailure(`open event ${String(message.index)} in the editor`));
        return;
    }
  }

  private besidePanel(entry: Entry): vscode.TextDocumentShowOptions {
    return { viewColumn: this.columnBeside(entry.key), preserveFocus: false, preview: false };
  }

  private revealEntry(entry: Entry, preserveFocus: boolean): void {
    if (entry.panel === undefined) {
      this.open(entry, !preserveFocus);
      return;
    }
    entry.panel.reveal(entry.panel.viewColumn, preserveFocus);
  }

  private tick(entry: Entry): void {
    clearInterval(entry.ticker);
    entry.ticker = undefined;
    if (entry.ready && isRunning(entry.run)) {
      entry.ticker = setInterval(() => {
        if (isRunning(entry.run)) {
          entry.feed.refresh();
        } else {
          this.tick(entry);
        }
      }, tickMs);
    }
  }

  private hide(entry: Entry): void {
    entry.ready = false;
    entry.feed.pause();
    this.tick(entry);
  }

  private closed(entry: Entry): void {
    for (const listener of entry.listeners.splice(0)) {
      listener.dispose();
    }
    entry.panel = undefined;
    this.hide(entry);
    if (!isRunning(entry.run)) {
      this.drop(entry);
    }
  }

  private detach(entry: Entry): void {
    entry.unsubscribe();
    entry.feed.pause();
    clearInterval(entry.ticker);
    entry.ticker = undefined;
    const run = entry.run;
    void run.done.then(() => {
      if (![...this.entries.values()].some((shown) => shown.run === run)) {
        run.compact();
      }
    });
  }

  private drop(entry: Entry): void {
    if (this.entries.get(entry.key) === entry) {
      this.entries.delete(entry.key);
      this.detach(entry);
    }
  }

  private async ended(entry: Entry, run: RunHandle): Promise<void> {
    if (entry.run !== run) {
      return;
    }
    this.tick(entry);
    const encoded = await this.options.presenter.body(run);
    if (entry.run !== run) {
      return;
    }
    if (encoded !== undefined) {
      entry.feed.setBody(
        panelBody(encoded.content, encoded.languageId, run.snapshot().body.length),
      );
    }
    if (entry.panel === undefined) {
      this.drop(entry);
    }
  }
}
