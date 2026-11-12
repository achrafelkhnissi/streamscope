import * as vscode from 'vscode';
import { formatBodyOffThread, type EncodedBody } from '../../response/format-off-thread';
import { renderHeadersDocument } from '../../response/headers-document';
import { bodyExtension, fileSafeName } from '../../response/labels';
import type { RunSnapshot } from '../../runs/run';
import { responseScheme, type ResponseFileSystem } from './response-file-system';

export interface ResponseSlot {
  key: string;
  documentUri: vscode.Uri;
  run: RunSnapshot;
  bodyUri: vscode.Uri;
  headersUri: vscode.Uri;
  contentType: string | undefined;
}

function contentType(run: RunSnapshot): string | undefined {
  return run.head?.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1];
}

function sameUri(a: vscode.Uri, b: vscode.Uri): boolean {
  return a.toString() === b.toString();
}

async function closeTabs(uri: vscode.Uri): Promise<void> {
  const tabs = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputText && sameUri(tab.input.uri, uri));
  if (tabs.length > 0) {
    await vscode.window.tabGroups.close(tabs, true);
  }
}

export function preferredView(slot: ResponseSlot): vscode.Uri {
  return slot.run.status !== 'failed' && slot.run.head && slot.run.body.length > 0
    ? slot.bodyUri
    : slot.headersUri;
}

export class ResponsePresenter {
  private readonly slots = new Map<string, ResponseSlot>();
  private readonly numbers = new Map<string, number>();
  private readonly formatting = new Map<string, AbortController>();
  private nextNumber = 1;

  constructor(
    private readonly files: ResponseFileSystem,
    private readonly workerFile: string,
  ) {}

  slotForKey(key: string): ResponseSlot | undefined {
    return this.slots.get(key);
  }

  slotForUri(uri: vscode.Uri): ResponseSlot | undefined {
    return [...this.slots.values()].find(
      (slot) => sameUri(slot.bodyUri, uri) || sameUri(slot.headersUri, uri),
    );
  }

  async show(run: RunSnapshot, documentUri: vscode.Uri, isCurrent: () => boolean): Promise<void> {
    const number = this.numbers.get(run.key) ?? this.nextNumber++;
    this.numbers.set(run.key, number);
    const base = `/${String(number)}/${fileSafeName(run.label)}`;
    const type = contentType(run);
    this.formatting.get(run.key)?.abort();
    const formatting = new AbortController();
    this.formatting.set(run.key, formatting);
    const stale = (): boolean => formatting.signal.aborted || !isCurrent();
    const encoded = await this.encode(run, type, formatting.signal);
    if (stale()) {
      return;
    }
    const slot: ResponseSlot = {
      key: run.key,
      documentUri,
      run,
      contentType: type,
      bodyUri: vscode.Uri.from({
        scheme: responseScheme,
        path: base + bodyExtension(encoded.languageId),
      }),
      headersUri: vscode.Uri.from({ scheme: responseScheme, path: `${base}.headers.http` }),
    };
    const previous = this.slots.get(run.key);
    for (const uri of [previous?.bodyUri, previous?.headersUri]) {
      if (uri && !sameUri(uri, slot.bodyUri) && !sameUri(uri, slot.headersUri)) {
        await closeTabs(uri);
        if (stale()) {
          return;
        }
        this.files.remove(uri);
      }
    }
    this.formatting.delete(run.key);
    this.files.write(slot.headersUri, new TextEncoder().encode(renderHeadersDocument(run)));
    this.files.write(slot.bodyUri, encoded.content);
    this.slots.set(run.key, slot);
    await vscode.commands.executeCommand('vscode.open', preferredView(slot), {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: true,
      preview: false,
    });
  }

  private async encode(
    run: RunSnapshot,
    type: string | undefined,
    signal: AbortSignal,
  ): Promise<EncodedBody> {
    if (!run.head) {
      return { languageId: 'plaintext', binary: false, content: new Uint8Array() };
    }
    try {
      return await formatBodyOffThread(run.body, type, this.workerFile, signal);
    } catch {
      return { languageId: 'plaintext', binary: false, content: run.body };
    }
  }
}
