import * as path from 'node:path';
import * as vscode from 'vscode';
import { dotenvCandidates, parseDotenv } from '../../environments/dotenv';
import type { HttpFile, HttpRequest } from '../../http-file/model';
import type { RunInput } from '../../runs/run';
import { referencedSecrets } from '../../variables/secrets';
import type { DotenvState } from '../../variables/sources';
import type { SystemContext } from '../../variables/system';
import type { EnvironmentStore } from '../environments/environment-store';
import { askForSecret } from '../secrets/commands';
import type { SecretStore } from '../secrets/secret-store';

export type RunVariables = RunInput['variables'];

const maxDotenvBytes = 1_048_576;
const inertSystem: SystemContext = {
  now: () => new Date(0),
  uuid: () => '',
  randomInt: (minInclusive) => minInclusive,
};

async function readDotenv(
  document: vscode.Uri,
  environment: string | undefined,
): Promise<DotenvState> {
  if (document.scheme !== 'file') {
    return { kind: 'missing' };
  }
  const documentDir = path.dirname(document.fsPath);
  const root = vscode.workspace.getWorkspaceFolder(document)?.uri.fsPath ?? documentDir;
  for (const candidate of dotenvCandidates(documentDir, root, environment)) {
    const uri = vscode.Uri.file(candidate);
    let size: number;
    try {
      size = (await vscode.workspace.fs.stat(uri)).size;
    } catch {
      continue;
    }
    if (size > maxDotenvBytes) {
      return { kind: 'missing' };
    }
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    return { kind: 'loaded', values: parseDotenv(text), path: candidate };
  }
  return { kind: 'missing' };
}

export async function variablesFor(
  document: vscode.Uri,
  file: HttpFile,
  request: HttpRequest,
  environments: EnvironmentStore,
  secrets: SecretStore,
): Promise<{ variables: RunVariables; insecureEnvironment: boolean } | undefined> {
  const restricted = !vscode.workspace.isTrusted;
  const { catalog, privateFileIgnored } = await environments.catalogFor(document);
  const variables: RunVariables = {
    environmentName: catalog.active,
    environment: catalog.variables,
    shared: catalog.shared,
    secrets: new Map(),
    dotenv: restricted ? { kind: 'restricted' } : await readDotenv(document, catalog.active),
    processEnv: restricted ? {} : process.env,
    privateFileIgnored,
  };
  const values = new Map<string, string>();
  for (const name of referencedSecrets(file, request, {
    ...variables,
    system: inertSystem,
    restricted,
  })) {
    let value = await secrets.get(name);
    if (value === undefined) {
      value = await askForSecret(name);
      if (value === undefined || value === '') {
        return undefined;
      }
      await secrets.set(name, value);
    }
    values.set(name, value);
  }
  return {
    variables: { ...variables, secrets: values },
    insecureEnvironment: catalog.insecure,
  };
}
