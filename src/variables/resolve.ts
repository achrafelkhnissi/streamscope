import type { FileVariable, HttpFile, HttpRequest, Range } from '../http-file/model';
import { scanReferences } from '../http-file/references';
import { resolveSystemVariable, type SystemContext } from './system';

export interface ResolutionProblem {
  message: string;
  range: Range;
}

export type ResolvedBodyPart =
  | { kind: 'text'; lines: string[] }
  | {
      kind: 'file';
      path: string;
      processVariables: boolean;
      encoding: string | undefined;
      pathRange: Range;
    };

export interface ResolvedRequest {
  method: string;
  url: string;
  urlRange: Range;
  headers: { name: string; value: string }[];
  body: ResolvedBodyPart[];
}

export interface VariableScope {
  resolveText(text: string): { ok: true; text: string } | { ok: false; messages: string[] };
}

export type Resolution =
  | { ok: true; request: ResolvedRequest; scope: VariableScope }
  | { ok: false; problems: ResolutionProblem[] };

interface Failure {
  expression: string;
  message: string;
  range: Range | undefined;
}

type Evaluated = { ok: true; value: string } | { ok: false; failures: Failure[] };

interface Substituted {
  text: string;
  failures: Failure[];
}

const escapePattern = /\\(.)/g;
const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t' };
const requestReferencePattern = /^[^.\s]+\.(?:request|response)\./;

function unescape(value: string): string {
  return value.replace(escapePattern, (_, character: string) => escapes[character] ?? character);
}

function quoted(name: string): string {
  return `\`{{${name}}}\``;
}

function cycleMessage(names: readonly string[]): string {
  if (names.length === 1) {
    return `${quoted(names[0] ?? '')} refers to itself.`;
  }
  const listed = names.map(quoted);
  const last = listed.pop() ?? '';
  return `${listed.join(', ')} and ${last} refer to each other.`;
}

function substitute(text: string, evaluate: (expression: string) => Evaluated): Substituted {
  const failures: Failure[] = [];
  let result = '';
  let from = 0;
  for (const reference of scanReferences(text, 0).references) {
    const start = reference.range.start.character;
    const end = reference.range.end.character;
    const evaluated = evaluate(reference.expression);
    result += text.slice(from, start);
    if (evaluated.ok) {
      result += evaluated.value;
    } else {
      failures.push(...evaluated.failures);
      result += text.slice(start, end);
    }
    from = end;
  }
  return { text: result + text.slice(from), failures };
}

class Scope implements VariableScope {
  private readonly variables = new Map<string, FileVariable>();
  private readonly cache = new Map<string, Evaluated>();

  constructor(
    file: HttpFile,
    private readonly context: SystemContext,
  ) {
    for (const variable of file.fileVariables) {
      this.variables.set(variable.name, variable);
    }
  }

  evaluate(expression: string): Evaluated {
    return this.evaluateWithin(expression, []);
  }

  resolveText(text: string): { ok: true; text: string } | { ok: false; messages: string[] } {
    const substituted = substitute(text, (expression) => this.evaluate(expression));
    return substituted.failures.length === 0
      ? { ok: true, text: substituted.text }
      : {
          ok: false,
          messages: [...new Set(substituted.failures.map((failure) => failure.message))],
        };
  }

  private evaluateWithin(expression: string, stack: readonly string[]): Evaluated {
    if (expression.startsWith('$')) {
      const value = resolveSystemVariable(expression, this.context);
      return value.ok
        ? value
        : { ok: false, failures: [{ expression, message: value.message, range: undefined }] };
    }
    const variable = this.variables.get(expression);
    if (variable) {
      return this.fileVariable(variable, stack);
    }
    const message = requestReferencePattern.test(expression)
      ? `Request references such as ${quoted(expression)} are not supported yet.`
      : `${quoted(expression)} is not defined.`;
    return { ok: false, failures: [{ expression, message, range: undefined }] };
  }

  private fileVariable(variable: FileVariable, stack: readonly string[]): Evaluated {
    const cached = this.cache.get(variable.name);
    if (cached) {
      return cached;
    }
    const cycleStart = stack.indexOf(variable.name);
    if (cycleStart !== -1) {
      const names = stack.slice(cycleStart);
      const first = this.variables.get(names[0] ?? variable.name) ?? variable;
      return {
        ok: false,
        failures: [
          { expression: variable.name, message: cycleMessage(names), range: first.valueRange },
        ],
      };
    }
    const inner = [...stack, variable.name];
    const substituted = substitute(unescape(variable.value), (expression) =>
      this.evaluateWithin(expression, inner),
    );
    const evaluated: Evaluated =
      substituted.failures.length === 0
        ? { ok: true, value: substituted.text }
        : {
            ok: false,
            failures: substituted.failures.map((failure) => ({
              ...failure,
              range: failure.range ?? variable.valueRange,
            })),
          };
    this.cache.set(variable.name, evaluated);
    return evaluated;
  }
}

function locate(failures: readonly Failure[], request: HttpRequest): ResolutionProblem[] {
  const seen = new Set<string>();
  const problems: ResolutionProblem[] = [];
  for (const failure of failures) {
    const ranges = failure.range
      ? [failure.range]
      : request.variableReferences
          .filter((reference) => reference.expression === failure.expression)
          .map((reference) => reference.range);
    for (const range of ranges.length > 0 ? ranges : [request.requestLine.range]) {
      const key = `${failure.message}@${String(range.start.line)}:${String(range.start.character)}`;
      if (!seen.has(key)) {
        seen.add(key);
        problems.push({ message: failure.message, range });
      }
    }
  }
  return problems.sort(
    (a, b) =>
      a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character,
  );
}

function urlRange(request: HttpRequest): Range {
  const ranges = request.requestLine.urlRanges;
  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  return first && last ? { start: first.start, end: last.end } : request.requestLine.range;
}

export function resolveRequest(
  file: HttpFile,
  request: HttpRequest,
  context: SystemContext,
): Resolution {
  const scope = new Scope(file, context);
  const failures: Failure[] = [];
  const text = (value: string): string => {
    const substituted = substitute(value, (expression) => scope.evaluate(expression));
    failures.push(...substituted.failures);
    return substituted.text;
  };
  const resolved: ResolvedRequest = {
    method: request.requestLine.method,
    url: text(request.requestLine.url),
    urlRange: urlRange(request),
    headers: request.headers.map((header) => ({
      name: text(header.name),
      value: text(header.value),
    })),
    body: request.body.map((part): ResolvedBodyPart =>
      part.kind === 'text'
        ? { kind: 'text', lines: part.lines.map(text) }
        : {
            kind: 'file',
            path: text(part.path),
            processVariables: part.processVariables,
            encoding: part.encoding,
            pathRange: part.pathRange,
          },
    ),
  };
  return failures.length === 0
    ? { ok: true, request: resolved, scope }
    : { ok: false, problems: locate(failures, request) };
}
