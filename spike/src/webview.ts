import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { StreamEvent } from '../../src/events/model';
import type { SpillArea } from '../../src/events/spill';
import type { EventStore } from '../../src/events/store';
import type {
  FromWebview,
  Row,
  TextDelta,
  ToWebview,
  UpdateMessage,
  ViewName,
} from '../webview/messages';
import { CapturedValues } from './captured';
import { bodyText, checksText, clock, eventText, preview, replyText, statusText } from './format';
import type { Surface, SurfaceResponse } from './flows';
import { SpikeStream } from './stream';

const maxRows = 500;
const defaultWindow = 100;

const css = `
:root { color-scheme: light dark; }
body { margin: 0; padding: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
.bar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
.pill { padding: 1px 8px; border-radius: 10px; font-size: 11px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.pill.streaming { background: var(--vscode-charts-green); color: var(--vscode-editor-background); }
.pill.failed { background: var(--vscode-charts-red); color: var(--vscode-editor-background); }
.pill.cancelled { background: var(--vscode-charts-orange); color: var(--vscode-editor-background); }
#status { flex: 1; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
button { font-family: inherit; font-size: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 3px 10px; border-radius: 2px; cursor: pointer; }
button:hover { background: var(--vscode-button-hoverBackground); }
button:disabled { opacity: 0.5; cursor: default; }
button:focus-visible, .list:focus-visible, .tab:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.tabs { display: flex; gap: 2px; padding: 0 12px; border-bottom: 1px solid var(--vscode-panel-border); }
.tab { background: none; color: var(--vscode-panelTitle-inactiveForeground); border-bottom: 1px solid transparent; border-radius: 0; padding: 6px 10px; }
.tab:hover { background: none; color: var(--vscode-panelTitle-activeForeground); }
.tab[aria-selected="true"] { color: var(--vscode-panelTitle-activeForeground); border-bottom-color: var(--vscode-panelTitle-activeBorder); }
.captured { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 6px 12px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); }
.chip { font-family: var(--vscode-editor-font-family); padding: 1px 6px; border-radius: 3px; background: var(--vscode-textBlockQuote-background); color: var(--vscode-foreground); }
.chip.wait { color: var(--vscode-descriptionForeground); font-style: italic; }
.panel { display: none; flex: 1; min-height: 0; overflow: auto; }
.panel.on { display: block; }
#panel-events.on { display: flex; }
.list { position: relative; flex: 1; overflow-y: auto; overflow-x: hidden; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
.row { position: absolute; left: 0; right: 0; height: 22px; line-height: 22px; padding: 0 12px; display: flex; gap: 12px; white-space: nowrap; cursor: pointer; }
.row:hover { background: var(--vscode-list-hoverBackground); }
.row[aria-selected="true"] { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.index { color: var(--vscode-editorLineNumber-foreground); min-width: 64px; }
.time { color: var(--vscode-descriptionForeground); min-width: 84px; }
.label { color: var(--vscode-symbolIcon-classForeground); min-width: 200px; }
.preview { overflow: hidden; text-overflow: ellipsis; color: var(--vscode-descriptionForeground); }
.detail { position: absolute; left: 24px; right: 12px; padding: 8px 12px; border-left: 2px solid var(--vscode-focusBorder); background: var(--vscode-textBlockQuote-background); }
.detail pre { margin: 0 0 8px; white-space: pre-wrap; word-break: break-all; max-height: 300px; overflow: auto; }
pre { margin: 0; padding: 8px 12px; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); white-space: pre-wrap; word-break: break-word; }
.raw-line { white-space: pre; }
.key { color: var(--vscode-symbolIcon-propertyForeground); }
.string { color: var(--vscode-debugTokenExpression-string); }
.number { color: var(--vscode-debugTokenExpression-number); }
.literal { color: var(--vscode-debugTokenExpression-boolean); }
table { border-collapse: collapse; margin: 8px 12px; font-family: var(--vscode-editor-font-family); }
td { padding: 2px 16px 2px 0; vertical-align: top; }
td:first-child { color: var(--vscode-symbolIcon-propertyForeground); }
p { padding: 8px 12px; margin: 0; color: var(--vscode-descriptionForeground); }
`;

const tabs: readonly [ViewName, string][] = [
  ['events', 'Events'],
  ['reply', 'Reply'],
  ['raw', 'Raw'],
  ['headers', 'Headers'],
  ['body', 'Body'],
  ['checks', 'Checks'],
];

function html(webview: vscode.Webview, script: vscode.Uri, nonce: string): string {
  const tabButtons = tabs
    .map(
      ([view, title]) =>
        `<button class="tab" role="tab" id="tab-${view}" data-view="${view}" aria-controls="panel-${view}" aria-selected="${String(view === 'events')}" tabindex="${view === 'events' ? '0' : '-1'}">${title}</button>`,
    )
    .join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src ${webview.cspSource}; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">${css}</style>
</head>
<body>
<div class="bar"><span class="pill" id="pill">Connecting</span><span id="status"></span><button id="stop">Stop</button></div>
<div class="tabs" role="tablist" aria-label="Response views">${tabButtons}</div>
<div class="captured" id="captured" aria-live="polite"></div>
<section class="panel on" id="panel-events" role="tabpanel" aria-labelledby="tab-events"><div class="list" id="list" role="listbox" tabindex="0" aria-label="Events"><div id="spacer"></div></div></section>
<section class="panel" id="panel-reply" role="tabpanel" aria-labelledby="tab-reply"><pre id="reply"></pre></section>
<section class="panel" id="panel-raw" role="tabpanel" aria-labelledby="tab-raw"><pre id="raw"></pre></section>
<section class="panel" id="panel-headers" role="tabpanel" aria-labelledby="tab-headers"><pre id="status-line"></pre><table id="headers"></table></section>
<section class="panel" id="panel-body" role="tabpanel" aria-labelledby="tab-body"><p>${bodyText}</p></section>
<section class="panel" id="panel-checks" role="tabpanel" aria-labelledby="tab-checks"><p>${checksText}</p></section>
<script nonce="${nonce}" src="${webview.asWebviewUri(script).toString()}"></script>
</body>
</html>`;
}

function row(store: EventStore, index: number, event: StreamEvent | undefined): Row {
  const summary = store.summary(index);
  return {
    index,
    time: clock(summary?.time ?? 0),
    label: summary?.label ?? summary?.kind ?? '',
    preview: preview(event),
  };
}

export class WebviewResponse implements SurfaceResponse {
  view: ViewName = 'events';
  onClose: () => void = () => undefined;
  private readonly captured = new CapturedValues();
  private readonly visibleListeners = new Set<(newest: number) => void>();
  private ready = false;
  private windowStart = 1;
  private windowEnd = defaultWindow;
  private following = true;
  private sentTo = 0;
  private replySent = 0;
  private rawSent = 0;
  private rawGeneration = -1;
  private headersSent = false;
  private disposed = false;

  constructor(
    readonly stream: SpikeStream,
    readonly panel: vscode.WebviewPanel,
    script: vscode.Uri,
  ) {
    panel.webview.html = html(panel.webview, script, randomBytes(32).toString('base64'));
    panel.webview.onDidReceiveMessage((message: FromWebview) => {
      void this.receive(message);
    });
    panel.onDidDispose(() => {
      this.disposed = true;
      this.stream.stop();
    });
  }

  onVisible(listener: (newest: number) => void): vscode.Disposable {
    this.visibleListeners.add(listener);
    return new vscode.Disposable(() => {
      this.visibleListeners.delete(listener);
    });
  }

  update(reset = false): void {
    if (!this.ready || this.disposed) {
      return;
    }
    const store = this.stream.session?.store;
    if (store !== undefined) {
      this.captured.update(store);
    }
    if (reset) {
      this.sentTo = this.following ? 0 : this.sentTo;
      this.replySent = 0;
      this.rawSent = 0;
      this.rawGeneration = -1;
      this.headersSent = false;
    }
    const head = this.stream.head;
    const message: UpdateMessage = {
      type: 'update',
      reset,
      count: store?.count ?? 0,
      state: this.stream.status,
      status: statusText(this.stream),
      running: this.stream.running,
      captured: this.captured.list(),
      rows: store === undefined ? [] : this.tailRows(store),
      reply: this.view === 'reply' ? this.replyDelta() : undefined,
      raw: this.view === 'raw' ? this.rawDelta() : undefined,
      headers:
        this.headersSent || head === undefined
          ? undefined
          : {
              status: `HTTP/${head.httpVersion} ${String(head.status)} ${head.statusText}`,
              fields: head.headers.map(([name, value]) => [name, value]),
            },
    };
    this.headersSent ||= head !== undefined;
    this.post(message);
  }

  async showView(view: ViewName): Promise<void> {
    this.view = view;
    this.post({ type: 'select', view });
    this.update();
    await Promise.resolve();
  }

  async showDetail(index: number): Promise<void> {
    if (this.view !== 'events') {
      await this.showView('events');
    }
    this.post({ type: 'expand', index });
  }

  showCaptureEntry(): Promise<void> {
    this.post({ type: 'focusCapture' });
    return Promise.resolve();
  }

  showOlder(): Promise<void> {
    return Promise.resolve();
  }

  async close(): Promise<void> {
    if (!this.disposed) {
      this.panel.dispose();
    }
    await this.stream.dispose();
    this.onClose();
  }

  private post(message: ToWebview): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage(message);
    }
  }

  private tailRows(store: EventStore): Row[] {
    if (!this.following) {
      return [];
    }
    const size = Math.max(1, this.windowEnd - this.windowStart + 1);
    const from = Math.max(this.sentTo + 1, store.count - Math.min(size, maxRows) + 1, 1);
    const rows: Row[] = [];
    for (let index = from; index <= store.count; index += 1) {
      rows.push(row(store, index, store.inMemory(index)));
    }
    this.sentTo = store.count;
    return rows;
  }

  private async windowRows(store: EventStore): Promise<Row[]> {
    const to = Math.min(this.windowEnd, store.count, this.windowStart + maxRows - 1);
    const rows: Row[] = [];
    for (let index = Math.max(1, this.windowStart); index <= to; index += 1) {
      rows.push(row(store, index, await store.read(index)));
    }
    return rows;
  }

  private replyDelta(): TextDelta | undefined {
    const text = replyText(this.stream);
    const reset = this.replySent === 0 || text.length < this.replySent;
    const start = reset ? 0 : this.replySent;
    if (!reset && text.length === start) {
      return undefined;
    }
    this.replySent = text.length;
    return { reset, text: text.slice(start) };
  }

  private rawDelta(): TextDelta | undefined {
    const raw = this.stream.raw;
    const reset = this.rawGeneration !== this.stream.rawGeneration || this.rawSent === 0;
    const start = reset ? 0 : this.rawSent;
    if (!reset && raw.length === start) {
      return undefined;
    }
    this.rawGeneration = this.stream.rawGeneration;
    this.rawSent = raw.length;
    return { reset, text: raw.slice(start) };
  }

  private async receive(message: FromWebview): Promise<void> {
    const store = this.stream.session?.store;
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.update(true);
        return;
      case 'window':
        this.windowStart = message.start;
        this.windowEnd = message.end;
        this.following = message.following;
        if (this.following) {
          this.sentTo = Math.max(0, message.start - 1);
          this.update();
        } else if (store !== undefined) {
          this.post({ type: 'rows', rows: await this.windowRows(store) });
        }
        return;
      case 'rendered':
        for (const listener of this.visibleListeners) {
          listener(message.newest);
        }
        return;
      case 'detail': {
        const event = await store?.read(message.index);
        this.post({
          type: 'detail',
          index: message.index,
          json: event === undefined ? 'This event is no longer available.' : eventText(event, 2),
        });
        return;
      }
      case 'stop':
        this.stream.stop();
        return;
      case 'tab':
        this.view = message.view;
        this.update();
        return;
      case 'capture':
        await vscode.window.showInformationMessage(
          `Prototype: would capture a value from event ${String(message.index)}.`,
        );
        return;
    }
  }
}

export class WebviewSurface implements Surface {
  private readonly responses: WebviewResponse[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly area: SpillArea,
    private readonly nextNumber: () => number,
    private readonly runningChanged: () => void,
  ) {}

  get running(): boolean {
    return this.responses.some((response) => response.stream.running);
  }

  async open(url: string, column: vscode.ViewColumn): Promise<WebviewResponse> {
    const holder: { response?: WebviewResponse } = {};
    const stream = await SpikeStream.open(url, this.area, () => {
      holder.response?.update();
      this.runningChanged();
    });
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const panel = vscode.window.createWebviewPanel(
      'streamscope.spike.response',
      `Response ${String(this.nextNumber())}`,
      { viewColumn: column, preserveFocus: true },
      { enableScripts: true, localResourceRoots: [dist], retainContextWhenHidden: false },
    );
    const response = new WebviewResponse(stream, panel, vscode.Uri.joinPath(dist, 'webview.js'));
    holder.response = response;
    this.responses.push(response);
    response.onClose = () => {
      this.responses.splice(this.responses.indexOf(response), 1);
      this.runningChanged();
    };
    return response;
  }

  responseFor(uri: vscode.Uri | undefined): WebviewResponse | undefined {
    return uri === undefined ? this.responses.at(-1) : undefined;
  }
}
