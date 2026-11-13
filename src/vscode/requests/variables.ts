import * as path from 'node:path';
import * as vscode from 'vscode';
import { dotenvCandidates, parseDotenv } from '../../environments/dotenv';
import type { EnvironmentCatalog } from '../../environments/model';
import type { HttpFile, HttpRequest } from '../../http-file/model';
import type { RunInput } from '../../runs/run';
import { referencedSecrets } from '../../variables/secrets';
import { emptyCaptureLookup, type DotenvState } from '../../variables/sources';
import type { SystemContext } from '../../variables/system';
import type { EnvironmentStore } from '../environments/environment-store';
import { askForSecret } from '../secrets/commands';
import type { SecretStore } from '../secrets/secret-store';

export type RunVariables = RunInput['variables'];

const maxDotenvBytes = 1_048_576;
const dotenvReference = '$dotenv';
const inertSystem: SystemContext = {
  now: () => new Date(0),
  uuid: () => '',
  randomInt: (minInclusive) => minInclusive,
};

export function usesDotenv(text: string, catalog: EnvironmentCatalog): boolean {
  return (
    text.includes(dotenvReference) ||
    [...catalog.variables.values(), ...catalog.shared.values()].some((entry) =>
      entry.value.includes(dotenvReference),
    )
  );
}

async function readCandidate(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (!(stat.type & vscode.FileType.File) || stat.size > maxDotenvBytes) {
      return undefined;
    }
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

export async function readDotenv(
  document: vscode.Uri,
  environment: string | undefined,
): Promise<DotenvState> {
  if (document.scheme !== 'file') {
    return { kind: 'missing' };
  }
  const documentDir = path.dirname(document.fsPath);
  const root = vscode.workspace.getWorkspaceFolder(document)?.uri.fsPath ?? documentDir;
  for (const candidate of dotenvCandidates(documentDir, root, environment)) {
    const text = await readCandidate(vscode.Uri.file(candidate));
    if (text !== undefined) {
      return { kind: 'loaded', values: parseDotenv(text), path: candidate };
    }
  }
  return { kind: 'missing' };
}

export async function variablesFor(
  document: vscode.TextDocument,
  file: HttpFile,
  request: HttpRequest,
  environments: EnvironmentStore,
  secrets: SecretStore,
): Promise<{ variables: RunVariables; insecureEnvironment: boolean } | undefined> {
  const restricted = !vscode.workspace.isTrusted;
  const catalog = await environments.catalogFor(document.uri);
  const variables: RunVariables = {
    environmentName: catalog.active,
    environment: catalog.variables,
    shared: catalog.shared,
    secrets: new Map(),
    dotenv: restricted
      ? { kind: 'restricted' }
      : usesDotenv(document.getText(), catalog)
        ? await readDotenv(document.uri, catalog.active)
        : { kind: 'missing' },
    processEnv: restricted ? {} : process.env,
  };
  if (restricted) {
    return { variables, insecureEnvironment: catalog.insecure };
  }
  const values = new Map<string, string>();
  for (const name of secrets.names()) {
    const value = await secrets.get(name);
    if (value !== undefined) {
      values.set(name, value);
    }
  }
  for (const name of referencedSecrets(file, request, {
    ...variables,
    captures: emptyCaptureLookup,
    system: inertSystem,
    restricted,
  })) {
    if (values.has(name)) {
      continue;
    }
    const value = await askForSecret(name);
    if (value === undefined || value === '') {
      return undefined;
    }
    await secrets.set(name, value);
    values.set(name, value);
  }
  return {
    variables: { ...variables, secrets: values },
    insecureEnvironment: catalog.insecure,
  };
}
