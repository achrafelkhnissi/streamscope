import type { SourcedValue } from '../environments/model';
import { checkJsonPath } from '../expressions/jsonpath';
import type { FileVariable, HttpFile, HttpRequest, Range } from '../http-file/model';
import { scanReferences } from '../http-file/references';
import { looksLikeCredential } from '../masking/masking';
import {
  jsonPathMessage,
  notRunMessage,
  pendingMessage,
  quoted,
  referenceTarget,
  unknownRequestMessage,
  type ReferenceTarget,
} from './references';
import type { CaptureLookupResult, VariableSources } from './sources';
import { resolveSystemVariable } from './system';

export interface ResolutionProblem {
  message: string;
  range: Range;
  producer?: string;
}

export type CaptureWait = (
  | { kind: 'capture'; request: string; name: string; label: string }
  | { kind: 'response'; requestName: string; reference: string }
) & { range?: Range };

export interface CapturedValue {
  label: string;
  name: string;
  secret: boolean;
  sensitive: readonly string[];
  provenance: Extract<CaptureLookupResult, { kind: 'value' }>['provenance'];
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

export type TextResolution =
  | { ok: true; text: string }
  | {
      ok: false;
      problems: Omit<ResolutionProblem, 'range'>[];
      waits: readonly CaptureWait[];
    };

export interface VariableScope {
  resolveText(text: string): TextResolution;
}

export type Resolution =
  | { ok: true; request: ResolvedRequest; scope: VariableScope; sensitiveValues: string[] }
  | { ok: false; problems: ResolutionProblem[]; waits: readonly CaptureWait[] };

interface Failure {
  expression: string;
  message: string;
  range: Range | undefined;
  inEnvironment: boolean;
  producer?: string;
  wait?: CaptureWait;
}

type Evaluated =
  { ok: true; value: string; capture?: CapturedValue } | { ok: false; failures: Failure[] };

interface Substituted {
  text: string;
  failures: Failure[];
}

const escapePattern = /\\(.)/g;
const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t' };
const sharedPattern = /^\$shared(?:\s+(\S+))?$/;
const secretPattern = /^\$secret\s+([\w.-]+)$/;
const dotenvPattern = /^\$dotenv\s+(%)?([\w.-]+)$/;
const processEnvPattern = /^\$processEnv\s+(%)?(\w+)$/;
const sharedName = '$shared';

export function unescapeFileVariable(value: string): string {
  return value.replace(escapePattern, (_, character: string) => escapes[character] ?? character);
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

function failure(
  expression: string,
  message: string,
  cause: Pick<Failure, 'producer' | 'wait'> = {},
): Evaluated {
  return {
    ok: false,
    failures: [{ expression, message, range: undefined, inEnvironment: false, ...cause }],
  };
}

export function waitKey(wait: CaptureWait): string {
  return JSON.stringify(
    wait.kind === 'capture'
      ? [wait.kind, wait.request, wait.name]
      : [wait.kind, wait.requestName, wait.reference],
  );
}

function lookedUp(written: string, indirect: boolean, name: string, kind: string): string {
  return indirect ? `the ${kind} named by ${quoted(written)}` : name;
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
    private readonly file: HttpFile,
    private readonly sources: VariableSources,
  ) {
    for (const variable of file.fileVariables) {
      this.variables.set(variable.name, variable);
    }
  }

  evaluate(expression: string, target?: ReferenceTarget): Evaluated {
    return this.evaluateWithin(expression, [], target);
  }

  resolveText(text: string): TextResolution {
    const substituted = substitute(text, (expression) => this.evaluate(expression));
    if (substituted.failures.length === 0) {
      return { ok: true, text: substituted.text };
    }
    const problems = new Map<string, Omit<ResolutionProblem, 'range'>>();
    const waits = new Map<string, CaptureWait>();
    for (const { message, producer, wait } of substituted.failures) {
      if (wait !== undefined) {
        waits.set(waitKey(wait), wait);
      } else if (!problems.has(message)) {
        problems.set(message, producer === undefined ? { message } : { message, producer });
      }
    }
    return { ok: false, problems: [...problems.values()], waits: [...waits.values()] };
  }

  private evaluateWithin(
    expression: string,
    stack: readonly string[],
    parsed?: ReferenceTarget,
  ): Evaluated {
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
    const target = parsed ?? referenceTarget(this.file, expression, this.sources);
    if (target.kind !== 'name') {
      return this.requestReference(expression, target);
    }
    const captured = this.sources.captures.bare(expression);
    if (captured !== undefined) {
      return this.captured(expression, expression, captured);
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
    return failure(expression, this.undefinedMessage(expression));
  }

  private captured(expression: string, name: string, result: CaptureLookupResult): Evaluated {
    switch (result.kind) {
      case 'value':
        if (result.secret && result.text !== '') {
          this.sensitive.add(result.text);
        }
        for (const value of result.sensitive) {
          this.sensitive.add(value);
        }
        return {
          ok: true,
          value: result.text,
          capture: {
            label: result.label,
            name,
            secret: result.secret,
            sensitive: result.sensitive,
            provenance: result.provenance,
          },
        };
      case 'pending':
        return failure(expression, pendingMessage(result.label, result.name), {
          wait: {
            kind: 'capture',
            request: result.request,
            name: result.name,
            label: result.label,
          },
        });
      case 'failed':
        return failure(expression, result.message);
      case 'not-run':
        return failure(
          expression,
          notRunMessage(expression, result.label),
          result.producerName === undefined ? {} : { producer: result.producerName },
        );
    }
  }

  private requestReference(
    expression: string,
    target: Exclude<ReferenceTarget, { kind: 'name' }>,
  ): Evaluated {
    switch (target.kind) {
      case 'invalid':
        return failure(expression, target.message);
      case 'capture':
        return this.captured(
          expression,
          target.name,
          this.sources.captures.request(target.request, target.name) ?? {
            kind: 'not-run',
            label: target.request,
            producerName: target.request,
          },
        );
      case 'response':
        return this.response(expression, target);
    }
  }

  private response(
    expression: string,
    target: Extract<ReferenceTarget, { kind: 'response' }>,
  ): Evaluated {
    const problem = target.query === undefined ? undefined : checkJsonPath(target.query);
    if (problem !== undefined) {
      return failure(expression, jsonPathMessage(expression, problem.message));
    }
    if (!target.known) {
      return failure(expression, unknownRequestMessage(expression, target.request));
    }
    const result = this.sources.captures.response(target.request, target.reference);
    return result === undefined
      ? failure(expression, pendingMessage(target.request, target.reference), {
          wait: { kind: 'response', requestName: target.request, reference: target.reference },
        })
      : this.captured(expression, target.reference, result);
  }

  private undefinedMessage(name: string): string {
    const environment = this.sources.environmentName;
    const where =
      environment === undefined
        ? `in this file or \`${sharedName}\` (no environment selected)`
        : `in this file, the \`${environment}\` environment or \`${sharedName}\``;
    const hint = this.sources.restricted
      ? ' A restricted workspace does not read http-client.private.env.json or environments from your user settings.'
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
      return failure(
        expression,
        `${quoted(expression)}: ${lookedUp(match[2], match[1] !== undefined, name.value, 'key')} is not in ${dotenv.path}.`,
      );
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
        `${quoted(expression)}: ${lookedUp(match[2], match[1] !== undefined, name.value, 'variable')} is not set in VS Code's environment.`,
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
    const substituted = substitute(unescapeFileVariable(variable.value), (expression) =>
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
        problems.push(
          failure.producer === undefined
            ? { message: failure.message, range }
            : { message: failure.message, range, producer: failure.producer },
        );
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
  if (failures.length === 0) {
    return {
      scope,
      resolution: { ok: true, request: resolved, scope, sensitiveValues: [...scope.sensitive] },
    };
  }
  const waits = new Map<string, CaptureWait>();
  for (const { wait } of failures) {
    if (wait !== undefined) {
      waits.set(waitKey(wait), wait);
    }
  }
  return {
    scope,
    resolution: {
      ok: false,
      problems: locate(
        failures.filter((entry) => entry.wait === undefined),
        request,
      ),
      waits: [...waits.values()],
    },
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

export function evaluateExpression(
  file: HttpFile,
  expression: string,
  sources: VariableSources,
  target?: ReferenceTarget,
):
  | { ok: true; value: string; sensitiveValues: string[]; capture: CapturedValue | undefined }
  | { ok: false; message: string } {
  const scope = new Scope(file, sources);
  const evaluated = scope.evaluate(expression, target);
  return evaluated.ok
    ? {
        ok: true,
        value: evaluated.value,
        sensitiveValues: [...scope.sensitive],
        capture: evaluated.capture,
      }
    : { ok: false, message: evaluated.failures[0]?.message ?? '' };
}
