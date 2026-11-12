import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RequestSettings } from '../../runs/run';
import { parseDuration } from '../../runs/duration';
import { trustedCertificates } from '../../transport/certificates';

export const maxBodyBytes = 268_435_456;

type SettingsResult = { ok: true; settings: RequestSettings } | { ok: false; message: string };

function duration(
  configuration: vscode.WorkspaceConfiguration,
  name: string,
  fallback: string,
): number | string {
  const value = configuration.get<string>(name, fallback);
  return (
    parseDuration(value) ??
    `streamscope.request.${name} must be a duration such as 500ms, 30s or 5m, not "${value}".`
  );
}

function caBase(uri: vscode.Uri): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (folder) {
    return folder.uri.fsPath;
  }
  return uri.scheme === 'file' ? path.dirname(uri.fsPath) : undefined;
}

async function customCertificates(
  uri: vscode.Uri,
  caFile: string,
): Promise<{ ok: true; ca: string[] | undefined } | { ok: false; message: string }> {
  if (caFile.trim() === '') {
    return { ok: true, ca: undefined };
  }
  const base = caBase(uri);
  if (!path.isAbsolute(caFile) && base === undefined) {
    return {
      ok: false,
      message: `streamscope.request.caFile is relative, so it needs a workspace folder or a saved .http file: "${caFile}".`,
    };
  }
  const file = path.isAbsolute(caFile) ? caFile : path.resolve(base ?? '', caFile);
  try {
    return { ok: true, ca: trustedCertificates([await readFile(file, 'utf8')]) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unreadable';
    return {
      ok: false,
      message: `streamscope.request.caFile could not be read: ${file} (${code}).`,
    };
  }
}

export async function readRequestSettings(uri: vscode.Uri): Promise<SettingsResult> {
  const configuration = vscode.workspace.getConfiguration('streamscope.request', uri);
  const connect = duration(configuration, 'connectTimeout', '30s');
  if (typeof connect === 'string') {
    return { ok: false, message: connect };
  }
  const headers = duration(configuration, 'headersTimeout', '300s');
  if (typeof headers === 'string') {
    return { ok: false, message: headers };
  }
  const maxRedirects = configuration.get<number>('maxRedirects', 10);
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 50) {
    return {
      ok: false,
      message: `streamscope.request.maxRedirects must be a whole number from 0 to 50, not ${String(maxRedirects)}.`,
    };
  }
  const ca = await customCertificates(uri, configuration.get<string>('caFile', ''));
  if (!ca.ok) {
    return ca;
  }
  return {
    ok: true,
    settings: {
      connectTimeoutMs: connect,
      headersTimeoutMs: headers,
      followRedirects: configuration.get<boolean>('followRedirects', true),
      maxRedirects,
      ca: ca.ca,
      maxBodyBytes,
      insecureEnvironment: false,
    },
  };
}
