import * as vscode from 'vscode';
import type { SpillArea } from '../../src/events/spill';
import type { ResponseFileSystem } from '../../src/vscode/response/response-file-system';
import { CapturedValues } from './captured';
import {
  bodyText,
  checksText,
  eventLine,
  eventText,
  headersText,
  replyText,
  statusText,
  type ViewName,
  viewNames,
} from './format';
import type { Surface, SurfaceResponse } from './flows';
import { SpikeStream } from './stream';

export const fileScheme = 'streamscope-spike';
export const contentScheme = 'streamscope-spike-content';

const viewFiles: Record<ViewName, string> = {
  events: 'events.streamscope-events',
  reply: 'reply.md',
  raw: 'raw.jsonl',
  headers: 'headers.http',
  body: 'body.txt',
  checks: 'checks.txt',
};
const windowLines = 5000;
const trimAt = 6000;
const olderPage = 1000;
const lensIntervalMs = 1000;
const encoder = new TextEncoder();

export interface Backing {
  readonly scheme: string;
  write(uri: vscode.Uri, text: string): void;
  remove(uri: vscode.Uri): void;
}

export class FileBacking implements Backing {
  readonly scheme = fileScheme;

  constructor(private readonly files: ResponseFileSystem) {}

  write(uri: vscode.Uri, text: string): void {
    this.files.write(uri, encoder.encode(text));
  }

  remove(uri: vscode.Uri): void {
    this.files.remove(uri);
  }
}

export class ContentBacking
  implements Backing, vscode.TextDocumentContentProvider, vscode.Disposable
{
  readonly scheme = contentScheme;
  private readonly texts = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.toString()) ?? '';
  }

  write(uri: vscode.Uri, text: string): void {
    this.texts.set(uri.toString(), text);
    this.changed.fire(uri);
  }

  remove(uri: vscode.Uri): void {
    this.texts.delete(uri.toString());
  }

  dispose(): void {
    this.changed.dispose();
    this.texts.clear();
  }
}

function tabsFor(match: (uri: vscode.Uri) => boolean): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputText && match(tab.input.uri));
}

function sameUri(a: vscode.Uri, b: vscode.Uri): boolean {
  return a.toString() === b.toString();
}

export class NativeResponse implements SurfaceResponse {
  view: ViewName = 'events';
  readonly captured = new CapturedValues();
  column: vscode.ViewColumn = vscode.ViewColumn.Active;
  onClose: () => void = () => undefined;
  firstIndex = 1;
  private readonly lines: string[] = [];
  private lastIndex = 0;
  private shownLines = 0;
  private lastDetail: vscode.Uri | undefined;
  private readonly written = new Map<string, string>();
  private readonly visibleListeners = new Set<(newest: number) => void>();

  constructor(
    readonly number: number,
    readonly stream: SpikeStream,
    private readonly backing: Backing,
  ) {}

  uri(view: ViewName): vscode.Uri {
    return this.fileUri(viewFiles[view]);
  }

  owns(uri: vscode.Uri): boolean {
    return uri.scheme === this.backing.scheme && uri.path.startsWith(`/${String(this.number)}/`);
  }

  refresh(): void {
    const store = this.stream.session?.store;
    if (store !== undefined) {
      this.captured.update(store);
    }
    this.write(this.view);
  }

  onVisible(listener: (newest: number) => void): vscode.Disposable {
    this.visibleListeners.add(listener);
    return new vscode.Disposable(() => {
      this.visibleListeners.delete(listener);
    });
  }

  documentChanged(document: vscode.TextDocument): void {
    if (!sameUri(document.uri, this.uri('events'))) {
      return;
    }
    const match = /^\[(\d+)\]/.exec(document.lineAt(document.lineCount - 1).text);
    if (match !== null) {
      const newest = Number(match[1]);
      for (const listener of this.visibleListeners) {
        listener(newest);
      }
    }
    this.followTail(document);
  }

  isView(uri: vscode.Uri): boolean {
    return viewNames.some((view) => sameUri(uri, this.uri(view)));
  }

  private followTail(document: vscode.TextDocument): void {
    const last = document.lineCount - 1;
    for (const editor of vscode.window.visibleTextEditors) {
      if (sameUri(editor.document.uri, document.uri)) {
        const bottom = editor.visibleRanges.at(-1)?.end.line ?? 0;
        if (bottom >= this.shownLines - 2) {
          editor.revealRange(new vscode.Range(last, 0, last, 0));
        }
      }
    }
    this.shownLines = document.lineCount;
  }

  async show(column: vscode.ViewColumn): Promise<void> {
    this.column = column;
    this.write('events');
    await vscode.commands.executeCommand('vscode.open', this.uri('events'), {
      viewColumn: column,
      preview: false,
      preserveFocus: true,
    });
  }

  async showView(view: ViewName): Promise<void> {
    const previous = this.uri(this.view);
    const [tab] = tabsFor((uri) => sameUri(uri, previous));
    const column = tab?.group.viewColumn ?? this.column;
    this.view = view;
    this.write(view);
    await vscode.commands.executeCommand('vscode.open', this.uri(view), {
      viewColumn: column,
      preview: false,
    });
    if (tab !== undefined && !sameUri(previous, this.uri(view))) {
      await vscode.window.tabGroups.close(tab, true);
    }
  }

  async showDetail(index: number): Promise<void> {
    const event = await this.stream.session?.store.read(index);
    const detail = this.fileUri(`event-${String(index)}.json`);
    this.writeText(
      detail,
      event === undefined ? 'This event is no longer available.' : eventText(event, 2),
    );
    this.lastDetail = detail;
    if (this.view !== 'events') {
      await this.showView('events');
    }
    const editor = await vscode.window.showTextDocument(this.uri('events'), {
      viewColumn: this.column,
      preview: false,
    });
    const line = index - this.firstIndex + 1;
    if (line < 1 || line >= editor.document.lineCount) {
      await vscode.commands.executeCommand('vscode.open', detail, {
        viewColumn: vscode.ViewColumn.Beside,
      });
      return;
    }
    const position = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position));
    await vscode.commands.executeCommand(
      'editor.action.peekLocations',
      this.uri('events'),
      position,
      [new vscode.Location(detail, new vscode.Position(0, 0))],
      'peek',
    );
  }

  async showCaptureEntry(): Promise<void> {
    if (this.lastDetail === undefined) {
      return;
    }
    await vscode.commands.executeCommand('closeReferenceSearch');
    const editor = await vscode.window.showTextDocument(this.lastDetail, {
      viewColumn: this.column,
      preview: true,
    });
    const line = editor.document
      .getText()
      .split('\n')
      .findIndex((text) => text.includes('"threadId"'));
    if (line >= 0) {
      const character = editor.document.lineAt(line).text.indexOf(':') + 2;
      const position = new vscode.Position(line, character);
      editor.selection = new vscode.Selection(position, position);
    }
  }

  async showOlder(): Promise<void> {
    const store = this.stream.session?.store;
    const to = this.firstIndex - 1;
    if (store === undefined || to < 1) {
      return;
    }
    const from = Math.max(1, to - olderPage + 1);
    const lines = [`── events ${String(from)} to ${String(to)}`];
    for (let index = from; index <= to; index += 1) {
      lines.push(eventLine(store, index, await store.read(index)));
    }
    const older = this.fileUri(`older-${String(from)}.streamscope-events`);
    this.writeText(older, lines.join('\n'));
    await vscode.commands.executeCommand('vscode.open', older, { viewColumn: this.column });
  }

  async close(): Promise<void> {
    await vscode.window.tabGroups.close(
      tabsFor((uri) => this.owns(uri)),
      true,
    );
    await this.stream.dispose();
    for (const uri of this.written.keys()) {
      this.backing.remove(vscode.Uri.parse(uri));
    }
    this.written.clear();
    this.onClose();
  }

  private fileUri(name: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: this.backing.scheme,
      path: `/${String(this.number)}/${name}`,
    });
  }

  private write(view: ViewName): void {
    this.writeText(this.uri(view), this.text(view));
  }

  private writeText(uri: vscode.Uri, text: string): void {
    const key = uri.toString();
    if (this.written.get(key) === text) {
      return;
    }
    this.written.set(key, text);
    this.backing.write(uri, text);
  }

  private text(view: ViewName): string {
    switch (view) {
      case 'events':
        return this.eventsText();
      case 'reply':
        return replyText(this.stream);
      case 'raw':
        return this.stream.raw;
      case 'headers':
        return headersText(this.stream);
      case 'body':
        return bodyText;
      case 'checks':
        return checksText;
    }
  }

  private eventsText(): string {
    const store = this.stream.session?.store;
    if (store !== undefined && store.count > this.lastIndex) {
      const from = Math.max(this.lastIndex + 1, store.count - windowLines + 1);
      if (from > this.lastIndex + 1) {
        this.lines.length = 0;
        this.firstIndex = from;
      }
      for (let index = from; index <= store.count; index += 1) {
        this.lines.push(eventLine(store, index, store.inMemory(index)));
      }
      this.lastIndex = store.count;
      if (this.lines.length > trimAt) {
        const drop = this.lines.length - windowLines;
        this.lines.splice(0, drop);
        this.firstIndex += drop;
      }
    }
    const older = this.firstIndex - 1;
    const header =
      older > 0
        ? `── ${older.toLocaleString('en-US')} older events: run Streamscope Spike: Show Older Events`
        : '── start of stream';
    return [header, ...this.lines].join('\n');
  }
}

export class NativeSurface implements Surface, vscode.CodeLensProvider, vscode.Disposable {
  private readonly responses: NativeResponse[] = [];
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensesChanged.event;
  private lensTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly backing: Backing,
    private readonly area: SpillArea,
    private readonly nextNumber: () => number,
    private readonly runningChanged: () => void,
  ) {}

  get scheme(): string {
    return this.backing.scheme;
  }

  get running(): boolean {
    return this.responses.some((response) => response.stream.running);
  }

  async open(url: string, column: vscode.ViewColumn): Promise<NativeResponse> {
    const holder: { response?: NativeResponse } = {};
    const stream = await SpikeStream.open(url, this.area, () => {
      holder.response?.refresh();
      this.statusChanged();
    });
    const response = new NativeResponse(this.nextNumber(), stream, this.backing);
    holder.response = response;
    this.responses.push(response);
    response.onClose = () => {
      this.forget(response);
      this.statusChanged();
    };
    await response.show(column);
    void stream.done.then(() => {
      this.statusChanged();
    });
    return response;
  }

  responseFor(uri: vscode.Uri | undefined): NativeResponse | undefined {
    if (uri === undefined) {
      return this.responses.at(-1);
    }
    return this.responses.find((response) => response.owns(uri));
  }

  documentChanged(document: vscode.TextDocument): void {
    this.responseFor(document.uri)?.documentChanged(document);
  }

  forget(response: NativeResponse): void {
    const position = this.responses.indexOf(response);
    if (position >= 0) {
      this.responses.splice(position, 1);
    }
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.uri.scheme !== this.backing.scheme) {
      return [];
    }
    const response = this.responseFor(document.uri);
    if (response === undefined || !response.isView(document.uri)) {
      return [];
    }
    const range = new vscode.Range(0, 0, 0, 0);
    const lenses = [
      new vscode.CodeLens(range, { title: statusText(response.stream), command: '' }),
    ];
    if (response.stream.running) {
      lenses.push(
        new vscode.CodeLens(range, {
          title: '$(debug-stop) Stop',
          command: 'streamscope.spike.stop',
          arguments: [document.uri],
        }),
      );
    }
    lenses.push(new vscode.CodeLens(range, { title: response.captured.text(), command: '' }));
    if (response.view === 'events' && response.firstIndex > 1) {
      lenses.push(
        new vscode.CodeLens(range, {
          title: 'Show Older Events',
          command: 'streamscope.spike.showOlder',
          arguments: [document.uri],
        }),
      );
    }
    return lenses;
  }

  dispose(): void {
    clearTimeout(this.lensTimer);
    this.lensesChanged.dispose();
  }

  private statusChanged(): void {
    this.runningChanged();
    if (this.lensTimer !== undefined) {
      return;
    }
    this.lensTimer = setTimeout(() => {
      this.lensTimer = undefined;
      this.lensesChanged.fire();
    }, lensIntervalMs);
  }
}
