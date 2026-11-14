import * as vscode from 'vscode';
import {
  formatBodyOffThread,
  workerThresholdBytes,
  type EncodedBody,
} from '../../response/format-off-thread';
import { CachedPromise } from '../../response/cached-promise';
import { renderHeadersDocument } from '../../response/headers-document';
import { bodyExtension, fileSafeName, noBodyMessage } from '../../response/labels';
import {
  compactEventJson,
  eventNote,
  eventText,
  panelBody,
  previewBody,
} from '../../response/panel-content';
import { panelLimits, type PanelBody } from '../../response/panel-protocol';
import type { StreamEvent } from '../../events/model';
import type { RunHandle, RunSnapshot } from '../../runs/run';
import { responseScheme, type ResponseFileSystem } from './response-file-system';

export type ResponseDocument =
  { key: string; target: 'body' | 'headers' } | { key: string; target: 'event'; index: number };

interface Documents {
  number: number;
  run: RunHandle | undefined;
  documentUri: vscode.Uri | undefined;
  base: string;
  headers: vscode.Uri | undefined;
  body: vscode.Uri | undefined;
  staleBody: vscode.Uri | undefined;
  events: Map<string, number>;
  formatting: AbortController | undefined;
  formatted: CachedPromise<EncodedBody | undefined>;
}

const maxEventDocuments = 20;
const eventDocumentGrowth = 8;
const eventDocumentAllowance = 1_048_576;

function contentType(run: RunSnapshot): string | undefined {
  return run.head?.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1];
}

function sameUri(a: vscode.Uri, b: vscode.Uri): boolean {
  return a.toString() === b.toString();
}

function responseUri(path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: responseScheme, path });
}

async function closeTabsWhere(matches: (uri: vscode.Uri) => boolean): Promise<void> {
  const tabs = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputText && matches(tab.input.uri));
  if (tabs.length > 0) {
    await vscode.window.tabGroups.close(tabs, true);
  }
}

function closeTabs(uris: readonly vscode.Uri[]): Promise<void> {
  const wanted = new Set(uris.map((uri) => uri.toString()));
  return closeTabsWhere((uri) => wanted.has(uri.toString()));
}

export function closeResponseTabs(): Promise<void> {
  return closeTabsWhere((uri) => uri.scheme === responseScheme);
}

export class ResponsePresenter {
  private readonly documents = new Map<string, Documents>();
  private nextNumber = 1;

  constructor(
    private readonly files: ResponseFileSystem,
    private readonly workerFile: string,
  ) {}

  run(key: string): RunHandle | undefined {
    return this.documents.get(key)?.run;
  }

  documentUri(key: string): vscode.Uri | undefined {
    return this.documents.get(key)?.documentUri;
  }

  documentFor(uri: vscode.Uri): ResponseDocument | undefined {
    for (const [key, documents] of this.documents) {
      const body = documents.body ?? documents.staleBody;
      if (body !== undefined && sameUri(body, uri)) {
        return { key, target: 'body' };
      }
      if (documents.headers !== undefined && sameUri(documents.headers, uri)) {
        return { key, target: 'headers' };
      }
      const index = documents.events.get(uri.path);
      if (index !== undefined) {
        return { key, target: 'event', index };
      }
    }
    return undefined;
  }

  attach(run: RunHandle, documentUri: vscode.Uri): void {
    const snapshot = run.snapshot();
    const documents = this.documents.get(snapshot.key) ?? this.create(snapshot.key);
    if (documents.run === run) {
      return;
    }
    documents.formatting?.abort();
    documents.formatting = undefined;
    documents.formatted.clear();
    documents.run = run;
    documents.documentUri = documentUri;
    documents.base = `/${String(documents.number)}/${fileSafeName(snapshot.label)}`;
    const headers = responseUri(`${documents.base}.headers.http`);
    const stale = [...documents.events.keys()].map(responseUri);
    if (documents.headers !== undefined && !sameUri(documents.headers, headers)) {
      stale.push(documents.headers);
    }
    documents.events.clear();
    documents.headers = headers;
    documents.staleBody = documents.body ?? documents.staleBody;
    documents.body = undefined;
    this.files.write(headers, new TextEncoder().encode(renderHeadersDocument(snapshot)));
    void this.discard(documents, stale);
  }

  body(run: RunHandle): Promise<EncodedBody | undefined> {
    const documents = this.documents.get(run.snapshot().key);
    if (documents?.run !== run) {
      return Promise.resolve(undefined);
    }
    return documents.formatted.get(() => this.format(documents, run));
  }

  async panelBody(run: RunHandle): Promise<PanelBody | undefined> {
    const snapshot = run.snapshot();
    if (snapshot.bodySource === 'memory' || snapshot.head === undefined || !snapshot.bodyKept) {
      const encoded = await this.body(run);
      return encoded === undefined
        ? undefined
        : panelBody(encoded.content, encoded.languageId, snapshot.bodyLength);
    }
    const documents = this.documents.get(snapshot.key);
    if (documents?.run !== run) {
      return undefined;
    }
    const bytes = await run.readBody(panelLimits.inlineBodyBytes);
    await this.dropStaleBody(documents, undefined);
    if (documents.run !== run) {
      return undefined;
    }
    return bytes === undefined
      ? { kind: 'unavailable' }
      : previewBody(bytes, contentType(snapshot), snapshot.bodyLength);
  }

  async open(
    key: string,
    target: 'body' | 'headers',
    options: vscode.TextDocumentShowOptions,
  ): Promise<void> {
    const documents = this.documents.get(key);
    const run = documents?.run;
    if (documents === undefined || run === undefined) {
      void vscode.window.showInformationMessage(
        'Send the request first: there is no response yet.',
      );
      return;
    }
    if (target === 'headers') {
      await this.show(documents.headers, options);
      return;
    }
    const snapshot = run.snapshot();
    const finished =
      snapshot.status !== 'waiting' &&
      snapshot.status !== 'sending' &&
      snapshot.status !== 'receiving';
    if (documents.body === undefined && finished) {
      await this.body(run);
    }
    if (documents.body !== undefined) {
      await this.show(documents.body, options);
      return;
    }
    void vscode.window.showInformationMessage(noBodyMessage(snapshot));
  }

  async openEvent(
    run: RunHandle,
    index: number,
    options: vscode.TextDocumentShowOptions,
  ): Promise<void> {
    const snapshot = run.snapshot();
    const documents = this.documents.get(snapshot.key);
    const store = snapshot.stream?.store;
    const event = await store?.read(index);
    if (documents?.run !== run) {
      return;
    }
    if (event === undefined) {
      void vscode.window.showInformationMessage(`Event ${String(index)} is no longer available.`);
      return;
    }
    const extension = event.kind === 'json' ? '.json' : '.txt';
    const uri = responseUri(`${documents.base}/event-${String(index)}${extension}`);
    const content = await this.eventContent(event, index);
    if (documents.run !== run) {
      return;
    }
    this.files.write(uri, content);
    documents.events.delete(uri.path);
    documents.events.set(uri.path, index);
    const dropped: vscode.Uri[] = [];
    for (const path of documents.events.keys()) {
      if (documents.events.size - dropped.length <= maxEventDocuments) {
        break;
      }
      dropped.push(responseUri(path));
    }
    for (const uri of dropped) {
      documents.events.delete(uri.path);
    }
    await this.show(uri, options);
    await this.discard(documents, dropped);
  }

  private async eventContent(event: StreamEvent, index: number): Promise<Uint8Array> {
    const encoder = new TextEncoder();
    let content: Uint8Array;
    let truncated = false;
    if (event.kind === 'json' && event.length > workerThresholdBytes) {
      const compact = encoder.encode(compactEventJson(event.value));
      content = await formatBodyOffThread(compact, 'application/json', this.workerFile).then(
        (encoded) => encoded.content,
        () => compact,
      );
    } else {
      const limit = event.length * eventDocumentGrowth + eventDocumentAllowance;
      const shown = eventText(event, limit);
      content = encoder.encode(shown.text);
      truncated = shown.truncated;
    }
    const note = eventNote(event, index, truncated);
    return note === undefined ? content : Buffer.concat([encoder.encode(`${note}\n\n`), content]);
  }

  private create(key: string): Documents {
    const documents: Documents = {
      number: this.nextNumber++,
      run: undefined,
      documentUri: undefined,
      base: '',
      headers: undefined,
      body: undefined,
      staleBody: undefined,
      events: new Map(),
      formatting: undefined,
      formatted: new CachedPromise(),
    };
    this.documents.set(key, documents);
    return documents;
  }

  private async show(uri: vscode.Uri | undefined, options: vscode.TextDocumentShowOptions) {
    if (uri !== undefined) {
      await vscode.commands.executeCommand('vscode.open', uri, options);
    }
  }

  private async discard(documents: Documents, uris: readonly vscode.Uri[]): Promise<void> {
    if (uris.length === 0) {
      return;
    }
    await closeTabs(uris);
    for (const uri of uris) {
      const owned =
        documents.events.has(uri.path) ||
        (documents.headers !== undefined && sameUri(documents.headers, uri)) ||
        (documents.body !== undefined && sameUri(documents.body, uri));
      if (!owned) {
        this.files.remove(uri);
      }
    }
  }

  private async format(documents: Documents, run: RunHandle): Promise<EncodedBody | undefined> {
    await run.done;
    const formatting = new AbortController();
    const current = (): boolean => documents.run === run && !formatting.signal.aborted;
    if (!current()) {
      return undefined;
    }
    documents.formatting = formatting;
    const snapshot = run.snapshot();
    if (documents.headers !== undefined) {
      this.files.write(
        documents.headers,
        new TextEncoder().encode(renderHeadersDocument(snapshot)),
      );
    }
    if (snapshot.head === undefined || !snapshot.bodyKept) {
      await this.dropStaleBody(documents, undefined);
      return undefined;
    }
    const bytes =
      snapshot.bodySource === 'memory' ? snapshot.body : await run.readBody(snapshot.bodyLength);
    if (!current()) {
      return undefined;
    }
    if (bytes === undefined) {
      await this.dropStaleBody(documents, undefined);
      return undefined;
    }
    let encoded: EncodedBody;
    try {
      encoded = await formatBodyOffThread(
        bytes,
        contentType(snapshot),
        this.workerFile,
        formatting.signal,
      );
    } catch {
      if (!current()) {
        return undefined;
      }
      encoded = { languageId: 'plaintext', binary: false, content: bytes };
    }
    if (!current()) {
      return undefined;
    }
    const body = responseUri(documents.base + bodyExtension(encoded.languageId));
    await this.dropStaleBody(documents, body);
    if (!current()) {
      return undefined;
    }
    this.files.write(body, encoded.content);
    documents.body = body;
    return encoded;
  }

  private async dropStaleBody(documents: Documents, replacement: vscode.Uri | undefined) {
    const stale = documents.staleBody;
    documents.staleBody = undefined;
    if (stale !== undefined && (replacement === undefined || !sameUri(stale, replacement))) {
      await this.discard(documents, [stale]);
    }
  }
}
