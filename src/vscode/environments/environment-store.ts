import * as vscode from 'vscode';
import { environmentCatalog } from '../../environments/catalog';
import type {
  EnvironmentCatalog,
  EnvironmentLayer,
  EnvironmentOrigin,
} from '../../environments/model';
import { parseEnvironmentFile, parseSettingsEnvironments } from '../../environments/parse';

const activeKey = 'streamscope.activeEnvironment';
const publicFileName = 'http-client.env.json';
const privateFileName = 'http-client.private.env.json';

interface CachedLayer {
  version: string;
  layer: EnvironmentLayer | undefined;
}

export interface CatalogResult {
  catalog: EnvironmentCatalog;
  privateFileIgnored: boolean;
}

export class EnvironmentStore implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly cache = new Map<string, CachedLayer>();
  private readonly warned = new Set<string>();
  private readonly disposables: vscode.Disposable[];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
  ) {
    const fire = (): void => {
      this.changed.fire();
    };
    const watcher = vscode.workspace.createFileSystemWatcher(
      `**/{${publicFileName},${privateFileName}}`,
    );
    this.disposables = [
      watcher,
      watcher.onDidChange(fire),
      watcher.onDidCreate(fire),
      watcher.onDidDelete(fire),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('rest-client.environmentVariables')) {
          fire();
        }
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(fire),
    ];
  }

  active(): string | undefined {
    return this.context.workspaceState.get<string>(activeKey);
  }

  async setActive(name: string | undefined): Promise<void> {
    await this.context.workspaceState.update(activeKey, name);
    this.changed.fire();
  }

  async catalogFor(document: vscode.Uri | undefined): Promise<CatalogResult> {
    const layers: EnvironmentLayer[] = [
      parseSettingsEnvironments(
        vscode.workspace.getConfiguration('rest-client', document).get('environmentVariables'),
      ),
    ];
    const publicFile = await this.find(document, publicFileName);
    if (publicFile) {
      const layer = await this.read(publicFile, { kind: 'file', path: publicFile.fsPath });
      if (layer) {
        layers.push(layer);
      }
    }
    const privateFile = await this.find(document, privateFileName);
    const trusted = vscode.workspace.isTrusted;
    if (privateFile && trusted) {
      const layer = await this.read(privateFile, {
        kind: 'private-file',
        path: privateFile.fsPath,
      });
      if (layer) {
        layers.push(layer);
      }
    }
    return {
      catalog: environmentCatalog(layers, this.active()),
      privateFileIgnored: privateFile !== undefined && !trusted,
    };
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.changed.dispose();
  }

  private folders(document: vscode.Uri | undefined): vscode.Uri[] {
    const folders: vscode.Uri[] = [];
    if (document?.scheme === 'file') {
      folders.push(vscode.Uri.joinPath(document, '..'));
    }
    const workspaceFolder =
      document?.scheme === 'file'
        ? vscode.workspace.getWorkspaceFolder(document)
        : vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      folders.push(workspaceFolder.uri);
    }
    return folders;
  }

  private async find(
    document: vscode.Uri | undefined,
    name: string,
  ): Promise<vscode.Uri | undefined> {
    for (const folder of this.folders(document)) {
      const candidate = vscode.Uri.joinPath(folder, name);
      try {
        await vscode.workspace.fs.stat(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private async read(
    uri: vscode.Uri,
    origin: EnvironmentOrigin,
  ): Promise<EnvironmentLayer | undefined> {
    const stat = await vscode.workspace.fs.stat(uri);
    const version = `${String(stat.mtime)}:${String(stat.size)}`;
    const cached = this.cache.get(uri.toString());
    if (cached?.version === version) {
      return cached.layer;
    }
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    const parsed = parseEnvironmentFile(text, origin);
    if (!parsed.ok) {
      const warning = `${uri.toString()}@${version}`;
      if (!this.warned.has(warning)) {
        this.warned.add(warning);
        this.log.warn(parsed.message);
        void vscode.window.showWarningMessage(parsed.message);
      }
    }
    const layer = parsed.ok ? parsed.layer : undefined;
    this.cache.set(uri.toString(), { version, layer });
    return layer;
  }
}
