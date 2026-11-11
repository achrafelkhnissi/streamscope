import type {
  Directive,
  DirectiveKind,
  FileVariable,
  HttpFile,
  HttpRequest,
  Range,
  RequestLine,
} from './model';

const separatorPattern = /^#{3,}/;
const commentPattern = /^\s*(#|\/{2})/;
const metadataPattern = /^\s*(?:#|\/{2})\s*@([\w-]+)(?:\s+(.*?))?\s*$/d;
const fileVariablePattern = /^\s*@([^\s=]+)\s*=\s*(.*?)\s*$/d;

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

function parseRequestLine(lines: readonly string[], line: number): RequestLine {
  const range = lineSpan(lines, line);
  return {
    method: 'GET',
    methodRange: undefined,
    url: (lines[line] ?? '').trim(),
    urlRanges: [range],
    httpVersion: undefined,
    range,
  };
}

function separatorTitle(text: string): string | undefined {
  const title = text.replace(separatorPattern, '').trim();
  return title === '' ? undefined : title;
}

function parseBlock(lines: readonly string[], block: Block): HttpRequest[] {
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
  if (requestLineIndex === undefined) {
    return [];
  }
  const startLine = block.separatorLine ?? block.firstLine;
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
      name: directives.find((directive) => directive.kind === 'name')?.argument,
      directives,
      requestLine: parseRequestLine(lines, requestLineIndex),
      headers: [],
      body: [],
      variableReferences: [],
    },
  ];
}

export function parseHttpFile(text: string): HttpFile {
  const lines = text.split(/\r?\n/);
  return {
    requests: splitBlocks(lines).flatMap((block) => parseBlock(lines, block)),
    fileVariables: lines.flatMap((line, index) => parseFileVariable(line, index, lines)),
    diagnostics: [],
  };
}
