import { readFile } from 'node:fs/promises';
import type { BodyPart, OutgoingRequest } from '../transport/model';
import type {
  ResolutionProblem,
  ResolvedBodyPart,
  ResolvedRequest,
  VariableScope,
} from '../variables/resolve';
import { locateBodyFile, type BodyFileContext } from './body-files';

export type BuildResult =
  { ok: true; request: OutgoingRequest } | { ok: false; problems: ResolutionProblem[] };

type FilePart = Extract<ResolvedBodyPart, { kind: 'file' }>;

const securePorts: ReadonlySet<string> = new Set(['443', '8443']);
const hostPortPattern = /:(\d+)$/;

function header(resolved: ResolvedRequest, name: string): string | undefined {
  return resolved.headers.find((candidate) => candidate.name.toLowerCase() === name)?.value;
}

function mediaType(resolved: ResolvedRequest): string {
  return (header(resolved, 'content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

function targetUrl(resolved: ResolvedRequest): URL | undefined {
  let text = resolved.url;
  const host = header(resolved, 'host')?.trim();
  if (text.startsWith('/') && host) {
    const port = hostPortPattern.exec(host)?.[1] ?? '';
    text = `${securePorts.has(port) ? 'https' : 'http'}://${host}${text}`;
  }
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

function joinLines(lines: readonly string[], lineEnding: string, form: boolean): string {
  return lines.reduce(
    (joined, line, index) =>
      index === 0 ? line : joined + (form && line.startsWith('&') ? '' : lineEnding) + line,
    '',
  );
}

async function filePart(
  part: FilePart,
  scope: VariableScope,
  context: BodyFileContext,
): Promise<{ ok: true; part: BodyPart } | { ok: false; messages: string[] }> {
  const encoding = part.encoding ?? 'utf8';
  if (part.processVariables && !Buffer.isEncoding(encoding)) {
    return { ok: false, messages: [`Unsupported encoding \`${encoding}\`.`] };
  }
  const located = await locateBodyFile(part.path, context);
  if (!located.ok) {
    return { ok: false, messages: [located.message] };
  }
  if (!part.processVariables) {
    return { ok: true, part: { kind: 'file', path: located.path, size: located.size } };
  }
  const contents = (await readFile(located.path)).toString(encoding as BufferEncoding);
  const resolved = scope.resolveText(contents);
  return resolved.ok
    ? { ok: true, part: { kind: 'bytes', bytes: Buffer.from(resolved.text, 'utf8') } }
    : { ok: false, messages: resolved.messages };
}

async function bodyParts(
  resolved: ResolvedRequest,
  scope: VariableScope,
  context: BodyFileContext,
): Promise<{ parts: BodyPart[]; problems: ResolutionProblem[] }> {
  const type = mediaType(resolved);
  const lineEnding = type === 'multipart/form-data' ? '\r\n' : '\n';
  const form = type === 'application/x-www-form-urlencoded';
  const withFiles = resolved.body.some((part) => part.kind === 'file');
  const parts: BodyPart[] = [];
  const problems: ResolutionProblem[] = [];
  for (const part of resolved.body) {
    if (part.kind === 'text') {
      const text = withFiles
        ? part.lines.map((line) => line + lineEnding).join('')
        : joinLines(part.lines, lineEnding, form) + (type === 'application/x-ndjson' ? '\n' : '');
      parts.push({ kind: 'bytes', bytes: Buffer.from(text, 'utf8') });
      continue;
    }
    const built = await filePart(part, scope, context);
    if (built.ok) {
      parts.push(built.part, { kind: 'bytes', bytes: Buffer.from(lineEnding) });
    } else {
      problems.push(...built.messages.map((message) => ({ message, range: part.pathRange })));
    }
  }
  return { parts, problems };
}

export async function buildOutgoingRequest(
  resolved: ResolvedRequest,
  scope: VariableScope,
  context: BodyFileContext,
): Promise<BuildResult> {
  const problems: ResolutionProblem[] = [];
  const url = targetUrl(resolved);
  if (!url) {
    problems.push({
      message: `\`${resolved.url}\` is not a valid http or https URL.`,
      range: resolved.urlRange,
    });
  }
  const body = await bodyParts(resolved, scope, context);
  problems.push(...body.problems);
  if (!url || problems.length > 0) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    request: {
      method: resolved.method,
      url,
      headers: resolved.headers.map(({ name, value }): [string, string] => [name, value]),
      body: body.parts,
    },
  };
}
