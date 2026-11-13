import * as vscode from 'vscode';

interface Entry {
  data: Uint8Array;
  ctime: number;
  mtime: number;
}

export const responseScheme = 'streamscope-response';

export class ResponseFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly files = new Map<string, Entry>();
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;

  write(uri: vscode.Uri, data: Uint8Array): void {
    const existing = this.files.get(uri.path);
    const now = Date.now();
    this.files.set(uri.path, {
      data,
      ctime: existing?.ctime ?? now,
      mtime: Math.max(now, (existing?.mtime ?? 0) + 1),
    });
    this.changed.fire([
      { type: existing ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri },
    ]);
  }

  remove(uri: vscode.Uri): void {
    if (this.files.delete(uri.path)) {
      this.changed.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    }
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const entry = this.files.get(uri.path);
    if (entry) {
      return {
        type: vscode.FileType.File,
        ctime: entry.ctime,
        mtime: entry.mtime,
        size: entry.data.byteLength,
        permissions: vscode.FilePermission.Readonly,
      };
    }
    if (this.children(uri).length > 0 || uri.path === '/') {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }
    throw vscode.FileSystemError.FileNotFound(uri);
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    return this.children(uri);
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const entry = this.files.get(uri.path);
    if (!entry) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return entry.data;
  }

  createDirectory(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  writeFile(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  dispose(): void {
    this.changed.dispose();
    this.files.clear();
  }

  private children(uri: vscode.Uri): [string, vscode.FileType][] {
    const prefix = uri.path.endsWith('/') ? uri.path : `${uri.path}/`;
    const names = new Map<string, vscode.FileType>();
    for (const file of this.files.keys()) {
      if (file.startsWith(prefix)) {
        const [name = '', ...rest] = file.slice(prefix.length).split('/');
        names.set(name, rest.length > 0 ? vscode.FileType.Directory : vscode.FileType.File);
      }
    }
    return [...names];
  }
}
