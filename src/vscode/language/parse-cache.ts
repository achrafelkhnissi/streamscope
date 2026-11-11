import type * as vscode from 'vscode';
import type { HttpFile } from '../../http-file/model';
import { parseHttpFile } from '../../http-file/parse';

interface CacheEntry {
  version: number;
  file: HttpFile;
}

export class ParseCache {
  private readonly entries = new Map<string, CacheEntry>();

  get(document: vscode.TextDocument): HttpFile {
    const key = document.uri.toString();
    const cached = this.entries.get(key);
    if (cached?.version === document.version) {
      return cached.file;
    }
    const file = parseHttpFile(document.getText());
    this.entries.set(key, { version: document.version, file });
    return file;
  }

  delete(uri: vscode.Uri): void {
    this.entries.delete(uri.toString());
  }
}
