import type { SourcedValue } from '../environments/model';
import type { FileVariable, HttpFile, HttpRequest, Range } from '../http-file/model';
import { scanReferences } from '../http-file/references';
import { looksLikeCredential } from '../masking/masking';
import type { VariableSources } from './sources';
import { resolveSystemVariable } from './system';

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
  writtenUrl: string;
  urlRange: Range;
  headers: { name: string; value: string }[];
  body: ResolvedBodyPart[];
}

export interface VariableScope {
  resolveText(text: string): { ok: true; text: string } | { ok: false; messages: string[] };
}

export type Resolution =
  | { ok: true; request: ResolvedRequest; scope: VariableScope; sensitiveValues: string[] }
  | { ok: false; problems: ResolutionProblem[] };

interface Failure {
  expression: string;
  message: string;
  range: Range | undefined;
  inEnvironment: boolean;
}

type Evaluated = { ok: true; value: string } | { ok: false; failures: Failure[] };

interface Substituted {
  text: string;
  failures: Failure[];
}

const escapePattern = /\\(.)/g;
const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t' };
const requestReferencePattern = /^[^.\s]+\.(?:request|response)\./;
const sharedPattern = /^\$shared(?:\s+(\S+))?$/;
const secretPattern = /^\$secret\s+([\w.-]+)$/;
const dotenvPattern = /^\$dotenv\s+(%)?([\w.-]+)$/;
const processEnvPattern = /^\$processEnv\s+(%)?(\w+)$/;
const sharedName = '$shared';

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

function failure(expression: string, message: string): Evaluated {
  return { ok: false, failures: [{ expression, message, range: undefined, inEnvironment: false }] };
}

function formatProblem(expression: string, format: string): Evaluated {
  return failure(
    expression,
    `${quoted(expression)} does not match the expected format \`${format}\`.`,
  );
}

class Scope implements VariableScope {
  readonly sensitive = new Set<string>();
  readonly missingSecrets: string[] = [];
  private readonly variables = new Map<string, FileVariable>();
  private readonly cache = new Map<string, Evaluated>();

  constructor(
    file: HttpFile,
    private readonly sources: VariableSources,
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
          messages: [...new Set(substituted.failures.map((entry) => entry.message))],
        };
  }

  private evaluateWithin(expression: string, stack: readonly string[]): Evaluated {
    switch (expression.split(/\s/, 1)[0]) {
      case sharedName:
        return this.sharedReference(expression, stack);
      case '$secret':
        return this.secret(expression);
      case '$dotenv':
        return this.dotenv(expression, stack);
      case '$processEnv':
        return this.processVariable(expression, stack);
      default:
        break;
    }
    if (expression.startsWith('$')) {
      const value = resolveSystemVariable(expression, this.sources.system);
      return value.ok ? value : failure(expression, value.message);
    }
    const variable = this.variables.get(expression);
    if (variable) {
      return this.fileVariable(variable, stack);
    }
    const environment = this.sources.environment.get(expression);
    if (environment) {
      return this.sourcedVariable(expression, environment, 'environment', stack);
    }
    const shared = this.sources.shared.get(expression);
    if (shared) {
      return this.sourcedVariable(expression, shared, 'shared', stack);
    }
    return failure(
      expression,
      requestReferencePattern.test(expression)
        ? `Request references such as ${quoted(expression)} are not supported yet.`
        : this.undefinedMessage(expression),
    );
  }

  private undefinedMessage(name: string): string {
    const environment = this.sources.environmentName;
    const where =
      environment === undefined
        ? `in this file or \`${sharedName}\` (no environment selected)`
        : `in this file, the \`${environment}\` environment or \`${sharedName}\``;
    const hint = this.sources.privateFileIgnored
      ? ' A restricted workspace does not read http-client.private.env.json.'
      : '';
    return `${quoted(name)} is not defined ${where}.${hint}`;
  }

  private sharedReference(expression: string, stack: readonly string[]): Evaluated {
    const name = sharedPattern.exec(expression)?.[1];
    if (name === undefined) {
      return failure(
        expression,
        `${quoted(expression)} does not match the expected format \`${sharedName} <name>\`.`,
      );
    }
    const shared = this.sources.shared.get(name);
    return shared
      ? this.sourcedVariable(name, shared, 'shared', stack)
      : failure(expression, `${quoted(expression)} is not defined in \`${sharedName}\`.`);
  }

  private unavailable(expression: string): Evaluated {
    return failure(
      expression,
      `${quoted(expression)} is not available in a restricted workspace. Trust the workspace to use it.`,
    );
  }

  private sensitiveValue(value: string): Evaluated {
    if (value !== '') {
      this.sensitive.add(value);
    }
    return { ok: true, value };
  }

  private indirect(
    name: string,
    indirection: boolean,
    stack: readonly string[],
  ): { ok: true; value: string } | Evaluated {
    if (!indirection) {
      return { ok: true, value: name };
    }
    const environment = this.sources.environment.get(name);
    if (environment) {
      return this.sourcedVariable(name, environment, 'environment', stack);
    }
    const shared = this.sources.shared.get(name);
    return shared ? this.sourcedVariable(name, shared, 'shared', stack) : { ok: true, value: name };
  }

  private secret(expression: string): Evaluated {
    const name = secretPattern.exec(expression)?.[1];
    if (name === undefined) {
      return formatProblem(expression, '$secret <name>');
    }
    if (this.sources.restricted) {
      return this.unavailable(expression);
    }
    const value = this.sources.secrets.get(name);
    if (value === undefined) {
      if (!this.missingSecrets.includes(name)) {
        this.missingSecrets.push(name);
      }
      return failure(expression, `${quoted(expression)} has no stored value.`);
    }
    return this.sensitiveValue(value);
  }

  private dotenv(expression: string, stack: readonly string[]): Evaluated {
    const match = dotenvPattern.exec(expression);
    if (!match?.[2]) {
      return formatProblem(expression, '$dotenv [%]<name>');
    }
    const dotenv = this.sources.dotenv;
    if (this.sources.restricted || dotenv.kind === 'restricted') {
      return this.unavailable(expression);
    }
    const name = this.indirect(match[2], match[1] !== undefined, stack);
    if (!name.ok) {
      return name;
    }
    if (dotenv.kind === 'missing') {
      return failure(
        expression,
        `${quoted(expression)}: no .env file was found next to the .http file or above it in the workspace.`,
      );
    }
    const value = dotenv.values.get(name.value);
    if (value === undefined) {
      return failure(expression, `${quoted(expression)}: ${name.value} is not in ${dotenv.path}.`);
    }
    return looksLikeCredential(name.value) ? this.sensitiveValue(value) : { ok: true, value };
  }

  private processVariable(expression: string, stack: readonly string[]): Evaluated {
    const match = processEnvPattern.exec(expression);
    if (!match?.[2]) {
      return formatProblem(expression, '$processEnv [%]<name>');
    }
    if (this.sources.restricted) {
      return this.unavailable(expression);
    }
    const name = this.indirect(match[2], match[1] !== undefined, stack);
    if (!name.ok) {
      return name;
    }
    const value = this.sources.processEnv[name.value];
    if (value === undefined) {
      return failure(
        expression,
        `${quoted(expression)}: ${name.value} is not set in VS Code's environment.`,
      );
    }
    return looksLikeCredential(name.value) ? this.sensitiveValue(value) : { ok: true, value };
  }

  private remember(name: string, evaluated: Evaluated): Evaluated {
    if (evaluated.ok && looksLikeCredential(name) && evaluated.value !== '') {
      this.sensitive.add(evaluated.value);
    }
    return evaluated;
  }

  private cycle(identity: string, stack: readonly string[]): string[] | undefined {
    const start = stack.indexOf(identity);
    return start === -1
      ? undefined
      : stack.slice(start).map((entry) => entry.slice(entry.indexOf(':') + 1));
  }

  private fileVariable(variable: FileVariable, stack: readonly string[]): Evaluated {
    const identity = `file:${variable.name}`;
    const cached = this.cache.get(identity);
    if (cached) {
      return cached;
    }
    const names = this.cycle(identity, stack);
    if (names) {
      const first = this.variables.get(names[0] ?? variable.name) ?? variable;
      return {
        ok: false,
        failures: [
          {
            expression: variable.name,
            message: cycleMessage(names),
            range: first.valueRange,
            inEnvironment: false,
          },
        ],
      };
    }
    const inner = [...stack, identity];
    const substituted = substitute(unescape(variable.value), (expression) =>
      this.evaluateWithin(expression, inner),
    );
    const evaluated = this.remember(
      variable.name,
      substituted.failures.length === 0
        ? { ok: true, value: substituted.text }
        : {
            ok: false,
            failures: substituted.failures.map((entry) => ({
              ...entry,
              range: entry.range ?? variable.valueRange,
            })),
          },
    );
    this.cache.set(identity, evaluated);
    return evaluated;
  }

  private sourcedVariable(
    name: string,
    sourced: SourcedValue,
    kind: 'environment' | 'shared',
    stack: readonly string[],
  ): Evaluated {
    const identity = `${kind}:${name}`;
    const cached = this.cache.get(identity);
    if (cached) {
      return cached;
    }
    const names = this.cycle(identity, stack);
    if (names) {
      return failure(names[0] ?? name, cycleMessage(names));
    }
    const inner = [...stack, identity];
    const substituted = substitute(sourced.value, (expression) =>
      this.evaluateWithin(expression, inner),
    );
    const evaluated = this.remember(
      name,
      substituted.failures.length === 0
        ? { ok: true, value: substituted.text }
        : {
            ok: false,
            failures: substituted.failures.map((entry) =>
              entry.range !== undefined || entry.inEnvironment
                ? { ...entry, expression: entry.range === undefined ? name : entry.expression }
                : {
                    ...entry,
                    expression: name,
                    message: `In ${quoted(name)} from ${sourced.origin}: ${entry.message}`,
                    inEnvironment: true,
                  },
            ),
          },
    );
    this.cache.set(identity, evaluated);
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

function resolveInScope(
  file: HttpFile,
  request: HttpRequest,
  sources: VariableSources,
): { resolution: Resolution; scope: Scope } {
  const scope = new Scope(file, sources);
  const failures: Failure[] = [];
  const text = (value: string): string => {
    const substituted = substitute(value, (expression) => scope.evaluate(expression));
    failures.push(...substituted.failures);
    return substituted.text;
  };
  const resolved: ResolvedRequest = {
    method: request.requestLine.method,
    url: text(request.requestLine.url),
    writtenUrl: request.requestLine.url,
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
  return {
    scope,
    resolution:
      failures.length === 0
        ? { ok: true, request: resolved, scope, sensitiveValues: [...scope.sensitive] }
        : { ok: false, problems: locate(failures, request) },
  };
}

export function resolveRequest(
  file: HttpFile,
  request: HttpRequest,
  sources: VariableSources,
): Resolution {
  return resolveInScope(file, request, sources).resolution;
}

export function missingSecrets(
  file: HttpFile,
  request: HttpRequest,
  sources: VariableSources,
): string[] {
  return resolveInScope(file, request, sources).scope.missingSecrets;
}
