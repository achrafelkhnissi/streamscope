import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RequestSettings } from '../../runs/run';
import { parseDuration } from '../../runs/duration';
import { parseSize } from '../../runs/size';
import {
  defaultSpillLimits,
  defaultStreamLimits,
  type SpillLimits,
  type StreamLimits,
} from '../../streaming/limits';
import { trustedCertificates } from '../../transport/certificates';

export const maxBodyBytes = 268_435_456;

type SettingsResult = { ok: true; settings: RequestSettings } | { ok: false; message: string };
type LimitsResult<Limits> = { ok: true; limits: Limits } | { ok: false; message: string };

const views = ['events', 'reply', 'raw'] as const;
const minimumMemoryEvents = 100;

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

function size(
  configuration: vscode.WorkspaceConfiguration,
  name: string,
  fallback: string,
): number | string {
  const value = configuration.get<string>(name, fallback);
  return (
    parseSize(value) ??
    `streamscope.stream.${name} must be a size such as 512KiB, 16MiB or 2GiB, not "${value}".`
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
  restricted: boolean,
): Promise<{ ok: true; ca: string[] | undefined } | { ok: false; message: string }> {
  if (caFile.trim() === '') {
    return { ok: true, ca: undefined };
  }
  if (restricted && !path.isAbsolute(caFile)) {
    return {
      ok: false,
      message: `streamscope.request.caFile is the relative path "${caFile}", which a restricted workspace does not resolve. Use an absolute path, or trust the workspace.`,
    };
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

export async function readRequestSettings(
  uri: vscode.Uri,
  restricted: boolean,
): Promise<SettingsResult> {
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
  const ca = await customCertificates(uri, configuration.get<string>('caFile', ''), restricted);
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

export function readStreamSettings(uri: vscode.Uri): LimitsResult<StreamLimits> {
  const configuration = vscode.workspace.getConfiguration('streamscope.stream', uri);
  const maxEventSize = size(configuration, 'maxEventSize', '16MiB');
  if (typeof maxEventSize === 'string') {
    return { ok: false, message: maxEventSize };
  }
  const memoryEvents = configuration.get<number>('memoryEvents', defaultStreamLimits.memoryEvents);
  if (!Number.isInteger(memoryEvents) || memoryEvents < minimumMemoryEvents) {
    return {
      ok: false,
      message: `streamscope.stream.memoryEvents must be a whole number of at least ${String(minimumMemoryEvents)}, not ${String(memoryEvents)}.`,
    };
  }
  const typeFields = configuration.get<string[]>('typeFields', [...defaultStreamLimits.typeFields]);
  if (!Array.isArray(typeFields) || typeFields.some((field) => typeof field !== 'string')) {
    return {
      ok: false,
      message: `streamscope.stream.typeFields must be a list of field names, not ${JSON.stringify(typeFields)}.`,
    };
  }
  return { ok: true, limits: { ...defaultStreamLimits, maxEventSize, memoryEvents, typeFields } };
}

export function readSpillLimits(): LimitsResult<SpillLimits> {
  const configuration = vscode.workspace.getConfiguration('streamscope.stream');
  const maxFileSize = size(configuration, 'maxSpillSize', '512MiB');
  if (typeof maxFileSize === 'string') {
    return { ok: false, message: maxFileSize };
  }
  const maxTotalSize = size(configuration, 'maxTotalSpillSize', '2GiB');
  if (typeof maxTotalSize === 'string') {
    return { ok: false, message: maxTotalSize };
  }
  return { ok: true, limits: { ...defaultSpillLimits, maxFileSize, maxTotalSize } };
}

export function readDefaultView(): (typeof views)[number] {
  const view = vscode.workspace
    .getConfiguration('streamscope.view')
    .get<string>('default', 'events');
  return views.find((candidate) => candidate === view) ?? 'events';
}
