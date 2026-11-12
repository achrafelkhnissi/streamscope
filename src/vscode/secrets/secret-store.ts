import * as vscode from 'vscode';
import { secretKey, workspaceHash } from '../../secrets/keys';

const namesKey = 'streamscope.secretNames';

export function workspaceIdentity(): string {
  return (
    vscode.workspace.workspaceFile?.toString() ??
    vscode.workspace.workspaceFolders?.[0]?.uri.toString() ??
    'no-workspace'
  );
}

export class SecretStore {
  private readonly hash: string;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly state: vscode.Memento,
    identity: string,
  ) {
    this.hash = workspaceHash(identity);
  }

  async get(name: string): Promise<string | undefined> {
    return this.secrets.get(secretKey(this.hash, name));
  }

  async set(name: string, value: string): Promise<void> {
    await this.secrets.store(secretKey(this.hash, name), value);
    const names = this.names();
    if (!names.includes(name)) {
      await this.state.update(namesKey, [...names, name].sort());
    }
  }

  async clear(name: string): Promise<void> {
    await this.secrets.delete(secretKey(this.hash, name));
    await this.state.update(
      namesKey,
      this.names().filter((entry) => entry !== name),
    );
  }

  names(): string[] {
    return this.state.get<string[]>(namesKey, []);
  }
}
