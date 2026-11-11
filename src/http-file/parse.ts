import { directiveDiagnostics, requestNamePattern } from './directives';
import type {
  BodyPart,
  Directive,
  DirectiveKind,
  FileVariable,
  Header,
  HttpFile,
  HttpRequest,
  ParseDiagnostic,
  Range,
  RequestLine,
  VariableReference,
} from './model';
import { scanReferences } from './references';

const separatorPattern = /^#{3,}/;
const commentPattern = /^\s*(#|\/{2})/;
const metadataPattern = /^\s*(?:#|\/{2})\s*@([\w-]+)(?:\s+(.*?))?\s*$/d;
const fileVariablePattern = /^\s*@([^\s=]+)\s*=\s*(.*?)\s*$/d;
const methodPattern =
  /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|CONNECT|TRACE|LOCK|UNLOCK|PROPFIND|PROPPATCH|COPY|MOVE|MKCOL|MKCALENDAR|ACL|SEARCH)\s+/i;
const httpVersionPattern = /\s+(HTTP\/.*)$/i;
const queryContinuationPattern = /^\s*[&?]/;
const bodyFilePattern = /^<(?:(@)(\w+)?)?\s+(.+?)\s*$/d;

const directiveKinds: ReadonlySet<string> = new Set<DirectiveKind>([
  'name',
  'capture',
  'expect',
  'stream',
  'timeout',
  'until',
  'insecure',
  'no-redirect',
  'no-cookie-jar',
  'note',
  'prompt',
]);

interface Block {
  separatorLine: number | undefined;
  firstLine: number;
  lastLine: number;
}

function span(line: number, start: number, end: number): Range {
  return { start: { line, character: start }, end: { line, character: end } };
}

function lineSpan(lines: readonly string[], line: number): Range {
  const text = lines[line] ?? '';
  return span(line, text.length - text.trimStart().length, text.trimEnd().length);
}

function isBlank(text: string): boolean {
  return text.trim() === '';
}

function isComment(text: string): boolean {
  return commentPattern.test(text);
}

function isFileVariable(text: string): boolean {
  return fileVariablePattern.test(text);
}

function splitBlocks(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];
  let current: Block = { separatorLine: undefined, firstLine: 0, lastLine: -1 };
  lines.forEach((text, index) => {
    if (separatorPattern.test(text)) {
      blocks.push(current);
      current = { separatorLine: index, firstLine: index + 1, lastLine: index };
    } else {
      current.lastLine = index;
    }
  });
  blocks.push(current);
  return blocks;
}

function parseFileVariable(text: string, line: number, lines: readonly string[]): FileVariable[] {
  const match = fileVariablePattern.exec(text);
  const nameIndices = match?.indices?.[1];
  const valueIndices = match?.indices?.[2];
  if (!match || !nameIndices || !valueIndices) {
    return [];
  }
  return [
    {
      name: match[1] ?? '',
      value: match[2] ?? '',
      range: lineSpan(lines, line),
      nameRange: span(line, nameIndices[0], nameIndices[1]),
      valueRange: span(line, valueIndices[0], valueIndices[1]),
    },
  ];
}

function parseDirective(text: string, line: number, lines: readonly string[]): Directive[] {
  const match = metadataPattern.exec(text);
  const keyword = match?.[1]?.toLowerCase();
  if (!match || keyword === undefined || !directiveKinds.has(keyword)) {
    return [];
  }
  const argumentIndices = match.indices?.[2];
  const end = (lines[line] ?? '').trimEnd().length;
  return [
    {
      kind: keyword as DirectiveKind,
      argument: match[2] ?? '',
      range: lineSpan(lines, line),
      argumentRange: argumentIndices
        ? span(line, argumentIndices[0], argumentIndices[1])
        : span(line, end, end),
    },
  ];
}

interface RequestSections {
  urlLines: number[];
  headerLines: number[];
  bodyLines: number[];
}

interface UrlSegment {
  line: number;
  start: number;
  end: number;
}

function contentLines(lines: readonly string[], from: number, to: number): number[] {
  const content: number[] = [];
  for (let line = from; line <= to; line++) {
    if (!isComment(lines[line] ?? '')) {
      content.push(line);
    }
  }
  let end = content.length;
  while (end > 1 && isBlank(lines[content[end - 1] ?? from] ?? '')) {
    end--;
  }
  return content.slice(0, end);
}

function splitSections(lines: readonly string[], content: readonly number[]): RequestSections {
  const sections: RequestSections = { urlLines: [], headerLines: [], bodyLines: [] };
  let state: 'url' | 'header' | 'body' = 'url';
  let skipNext = false;
  for (const [index, line] of content.entries()) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const nextLine = content[index + 1];
    const nextText = nextLine === undefined ? undefined : (lines[nextLine] ?? '');
    switch (state) {
      case 'url':
        sections.urlLines.push(line);
        if (nextText !== undefined && !queryContinuationPattern.test(nextText)) {
          if (isBlank(nextText)) {
            skipNext = true;
            state = 'body';
          } else {
            state = 'header';
          }
        }
        break;
      case 'header':
        sections.headerLines.push(line);
        if (nextText !== undefined && isBlank(nextText)) {
          skipNext = true;
          state = 'body';
        }
        break;
      case 'body':
        sections.bodyLines.push(line);
        break;
    }
  }
  return sections;
}

function parseRequestLine(lines: readonly string[], urlLines: readonly number[]): RequestLine {
  const firstLine = urlLines[0] ?? 0;
  const firstText = lines[firstLine] ?? '';
  const indent = firstText.length - firstText.trimStart().length;
  const methodMatch = methodPattern.exec(firstText.trimStart());
  const method = methodMatch?.[1];
  const urlStart = indent + (methodMatch?.[0].length ?? 0);
  const segments: UrlSegment[] = urlLines.map((line, index) => {
    const text = lines[line] ?? '';
    const start = index === 0 ? urlStart : text.length - text.trimStart().length;
    return { line, start, end: Math.max(start, text.trimEnd().length) };
  });
  const joined = segments
    .map((segment) => (lines[segment.line] ?? '').slice(segment.start, segment.end))
    .join('');
  const versionMatch = httpVersionPattern.exec(joined);
  const lastSegment = segments.at(-1);
  if (versionMatch && lastSegment) {
    lastSegment.end = Math.max(
      lastSegment.start,
      lastSegment.end - (joined.length - versionMatch.index),
    );
  }
  const lastEnd = lastSegment ?? { line: firstLine, end: firstText.trimEnd().length };
  return {
    method: method ?? 'GET',
    methodRange: method === undefined ? undefined : span(firstLine, indent, indent + method.length),
    url: versionMatch ? joined.slice(0, versionMatch.index) : joined,
    urlRanges: segments.map((segment) => span(segment.line, segment.start, segment.end)),
    httpVersion: versionMatch?.[1],
    range: {
      start: { line: firstLine, character: indent },
      end: { line: lastEnd.line, character: (lines[lastEnd.line] ?? '').trimEnd().length },
    },
  };
}

function parseHeader(lines: readonly string[], line: number): Header {
  const text = lines[line] ?? '';
  const indent = text.length - text.trimStart().length;
  const end = text.trimEnd().length;
  const colon = text.indexOf(':', indent);
  if (colon === -1) {
    return {
      name: text.trim(),
      value: '',
      range: span(line, indent, end),
      nameRange: span(line, indent, end),
      valueRange: span(line, end, end),
    };
  }
  const name = text.slice(indent, colon).trim();
  const afterColon = text.slice(colon + 1);
  const valueStart = Math.min(end, colon + 1 + afterColon.length - afterColon.trimStart().length);
  return {
    name,
    value: text.slice(valueStart, end),
    range: span(line, indent, end),
    nameRange: span(line, indent, indent + name.length),
    valueRange: span(line, valueStart, end),
  };
}

function textPart(lines: readonly string[], partLines: readonly number[]): BodyPart {
  const first = partLines[0] ?? 0;
  const last = partLines.at(-1) ?? first;
  return {
    kind: 'text',
    lines: partLines.map((line) => lines[line] ?? ''),
    range: {
      start: { line: first, character: 0 },
      end: { line: last, character: (lines[last] ?? '').length },
    },
  };
}

function parseBody(lines: readonly string[], bodyLines: readonly number[]): BodyPart[] {
  const parts: BodyPart[] = [];
  let pending: number[] = [];
  for (const line of bodyLines) {
    const match = bodyFilePattern.exec(lines[line] ?? '');
    const pathIndices = match?.indices?.[3];
    if (!match || !pathIndices) {
      pending.push(line);
      continue;
    }
    if (pending.length > 0) {
      parts.push(textPart(lines, pending));
      pending = [];
    }
    parts.push({
      kind: 'file',
      path: match[3] ?? '',
      processVariables: match[1] === '@',
      encoding: match[2],
      range: lineSpan(lines, line),
      pathRange: span(line, pathIndices[0], pathIndices[1]),
    });
  }
  if (pending.length > 0) {
    parts.push(textPart(lines, pending));
  }
  return parts;
}

function separatorTitle(text: string): string | undefined {
  const title = text.replace(separatorPattern, '').trim();
  return title === '' ? undefined : title;
}

function referencesIn(
  lines: readonly string[],
  lineNumbers: readonly number[],
): VariableReference[] {
  return lineNumbers.flatMap((line) => scanReferences(lines[line] ?? '', line).references);
}

function requestReferences(
  lines: readonly string[],
  sections: RequestSections,
): VariableReference[] {
  const bodyTextLines = sections.bodyLines.filter(
    (line) => !bodyFilePattern.test(lines[line] ?? ''),
  );
  return referencesIn(lines, [...sections.urlLines, ...sections.headerLines, ...bodyTextLines]);
}

function layoutDiagnostics(
  lines: readonly string[],
  requestLineIndex: number,
  block: Block,
  headerLines: readonly number[],
): ParseDiagnostic[] {
  const diagnostics: ParseDiagnostic[] = [];
  for (let line = requestLineIndex + 1; line <= block.lastLine; line++) {
    const text = lines[line] ?? '';
    if (isComment(text) && parseDirective(text, line, lines).length > 0) {
      diagnostics.push({
        code: 'misplaced-directive',
        message: 'Directives must come before the request line; this line is treated as a comment.',
        severity: 'warning',
        range: lineSpan(lines, line),
      });
    }
  }
  for (const line of headerLines) {
    if (!(lines[line] ?? '').includes(':')) {
      diagnostics.push({
        code: 'header-without-colon',
        message: 'Expected "Name: value"; this header is sent with an empty value.',
        severity: 'warning',
        range: lineSpan(lines, line),
      });
    }
  }
  return diagnostics;
}

function parseBlock(
  lines: readonly string[],
  block: Block,
  diagnostics: ParseDiagnostic[],
): HttpRequest[] {
  const directives: Directive[] = [];
  let requestLineIndex: number | undefined;
  for (let line = block.firstLine; line <= block.lastLine; line++) {
    const text = lines[line] ?? '';
    if (isBlank(text) || isFileVariable(text)) {
      continue;
    }
    if (isComment(text)) {
      directives.push(...parseDirective(text, line, lines));
      continue;
    }
    requestLineIndex = line;
    break;
  }
  diagnostics.push(...directives.flatMap(directiveDiagnostics));
  const firstDirective = directives[0];
  if (requestLineIndex === undefined) {
    if (firstDirective) {
      diagnostics.push({
        code: 'directives-without-request',
        message: 'These directives have no request line below them.',
        severity: 'warning',
        range: firstDirective.range,
      });
    }
    return [];
  }
  const startLine = block.separatorLine ?? block.firstLine;
  const sections = splitSections(lines, contentLines(lines, requestLineIndex, block.lastLine));
  diagnostics.push(...layoutDiagnostics(lines, requestLineIndex, block, sections.headerLines));
  const name = directives.find((directive) => directive.kind === 'name')?.argument;
  const body = parseBody(lines, sections.bodyLines);
  return [
    {
      range: {
        start: { line: startLine, character: 0 },
        end: { line: block.lastLine, character: (lines[block.lastLine] ?? '').length },
      },
      title:
        block.separatorLine === undefined
          ? undefined
          : separatorTitle(lines[block.separatorLine] ?? ''),
      name: name !== undefined && requestNamePattern.test(name) ? name : undefined,
      directives,
      requestLine: parseRequestLine(lines, sections.urlLines),
      headers: sections.headerLines.map((line) => parseHeader(lines, line)),
      body,
      variableReferences: requestReferences(lines, sections),
    },
  ];
}

function duplicateNameDiagnostics(requests: readonly HttpRequest[]): ParseDiagnostic[] {
  const seen = new Set<string>();
  const diagnostics: ParseDiagnostic[] = [];
  for (const request of requests) {
    const nameDirective = request.directives.find((directive) => directive.kind === 'name');
    if (request.name === undefined || !nameDirective) {
      continue;
    }
    if (seen.has(request.name)) {
      diagnostics.push({
        code: 'duplicate-name',
        message: `Another request is already named "${request.name}".`,
        severity: 'error',
        range: nameDirective.argumentRange,
      });
    }
    seen.add(request.name);
  }
  return diagnostics;
}

function referenceDiagnostics(lines: readonly string[]): ParseDiagnostic[] {
  return lines.flatMap((text, line) =>
    isComment(text) ? [] : scanReferences(text, line).diagnostics,
  );
}

export function parseHttpFile(text: string): HttpFile {
  const lines = text.split(/\r?\n/);
  const diagnostics: ParseDiagnostic[] = [];
  const requests = splitBlocks(lines).flatMap((block) => parseBlock(lines, block, diagnostics));
  return {
    requests,
    fileVariables: lines.flatMap((line, index) => parseFileVariable(line, index, lines)),
    diagnostics: [
      ...referenceDiagnostics(lines),
      ...diagnostics,
      ...duplicateNameDiagnostics(requests),
    ],
  };
}
