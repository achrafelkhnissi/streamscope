import { JsonPathBudget, type Clock } from '../http-file/captures';
import type { FileVariable, HttpFile, ParseDiagnostic } from '../http-file/model';
import { captureDisplayText } from '../masking/capture-display';
import { looksLikeCredential } from '../masking/masking';
import { formatDate } from './dates';
import {
  declaredNames,
  jsonPathMessage,
  referenceTarget,
  type ReferenceTarget,
} from './references';
import { evaluateExpression, type CapturedValue } from './resolve';
import type { VariableSources } from './sources';
import { resolveSystemVariable, type SystemContext } from './system';

export type ReferenceDescription =
  | { kind: 'value'; value: string; origin: string; sensitive: boolean }
  | { kind: 'secret'; name: string; stored: boolean }
  | { kind: 'generated'; description: string }
  | { kind: 'problem'; message: string };

export interface VariableCompletion {
  label: string;
  detail: string;
}

const generated: Readonly<Record<string, string>> = {
  $guid: 'A new UUID is generated when the request is sent.',
  $timestamp: 'The current Unix time in seconds, taken when the request is sent.',
  $datetime: 'The current UTC date and time, formatted when the request is sent.',
  $localDatetime: 'The current local date and time, formatted when the request is sent.',
  $randomInt: 'A random integer, drawn when the request is sent.',
};
const sendTimeFormats: Readonly<Record<string, RegExp>> = {
  $secret: /^\$secret\s+[\w.-]+$/,
  $dotenv: /^\$dotenv\s+%?[\w.-]+$/,
  $processEnv: /^\$processEnv\s+%?\w+$/,
};
const systemCompletions: readonly VariableCompletion[] = [
  { label: '$guid', detail: '$guid' },
  { label: '$timestamp', detail: '$timestamp [<offset> <unit>]' },
  { label: '$datetime', detail: '$datetime rfc1123|iso8601|"<format>" [<offset> <unit>]' },
  {
    label: '$localDatetime',
    detail: '$localDatetime rfc1123|iso8601|"<format>" [<offset> <unit>]',
  },
  { label: '$randomInt', detail: '$randomInt <min> <max>' },
  { label: '$processEnv', detail: '$processEnv [%]<name>' },
  { label: '$dotenv', detail: '$dotenv [%]<name>' },
  { label: '$secret', detail: '$secret <name>' },
  { label: '$shared', detail: '$shared <name>' },
];
const inertSystem: SystemContext = {
  now: () => new Date(0),
  uuid: () => '',
  randomInt: (minInclusive) => minInclusive,
};

type Problem = Pick<ParseDiagnostic, 'code' | 'message' | 'severity'>;

function wallClock(): number {
  return performance.now();
}

function head(expression: string): string {
  return expression.split(/\s/, 1)[0] ?? '';
}

function systemProblem(expression: string): string | undefined {
  const result = resolveSystemVariable(expression, inertSystem);
  return result.ok ? undefined : result.message;
}

function origin(file: HttpFile, expression: string, sources: VariableSources): string {
  const name = head(expression) === '$shared' ? (expression.split(/\s+/)[1] ?? '') : expression;
  if (head(expression) === '$shared') {
    return sources.shared.get(name)?.origin ?? '$shared';
  }
  if (head(expression) === '$dotenv') {
    return sources.dotenv.kind === 'loaded' ? sources.dotenv.path : '.env';
  }
  if (head(expression) === '$processEnv') {
    return "VS Code's environment";
  }
  if (file.fileVariables.some((variable) => variable.name === name)) {
    return 'file variable';
  }
  return sources.environment.get(name)?.origin ?? sources.shared.get(name)?.origin ?? '';
}

export function describeReference(
  file: HttpFile,
  expression: string,
  sources: VariableSources,
): ReferenceDescription {
  const description = generated[head(expression)];
  if (description !== undefined) {
    const problem = systemProblem(expression);
    return problem === undefined
      ? { kind: 'generated', description }
      : { kind: 'problem', message: problem };
  }
  if (head(expression) === '$secret' && !sources.restricted) {
    const name = /^\$secret\s+([\w.-]+)$/.exec(expression)?.[1];
    if (name !== undefined) {
      return { kind: 'secret', name, stored: sources.secrets.has(name) };
    }
  }
  const evaluated = evaluateExpression(file, expression, sources);
  if (!evaluated.ok) {
    return { kind: 'problem', message: evaluated.message };
  }
  const { capture } = evaluated;
  if (capture !== undefined) {
    return {
      kind: 'value',
      value: captureDisplayText({
        name: expression,
        secret: capture.secret,
        text: evaluated.value,
        sensitive: capture.sensitive,
      }),
      origin: captureProvenance(capture),
      sensitive: capture.secret || looksLikeCredential(expression),
    };
  }
  const sensitive = evaluated.sensitiveValues.length > 0 || looksLikeCredential(expression);
  return {
    kind: 'value',
    value: evaluated.value,
    origin: origin(file, expression, sources),
    sensitive,
  };
}

export function captureProvenance({
  label,
  name,
  provenance: from,
}: Pick<CapturedValue, 'label' | 'name' | 'provenance'>): string {
  const where = [
    from.event === undefined ? '' : `event ${String(from.event)}`,
    from.path === '' ? '' : `at ${from.path}`,
  ]
    .filter((part) => part !== '')
    .join(' ');
  return [
    `${label} › ${name}`,
    `run ${String(from.runId)}`,
    where,
    formatDate(new Date(from.time), 'HH:mm:ss', 'local'),
  ]
    .filter((part) => part !== '')
    .join(' · ');
}

function definedName(file: HttpFile, name: string, sources: VariableSources): boolean {
  return (
    file.fileVariables.some((variable) => variable.name === name) ||
    sources.environment.has(name) ||
    sources.shared.has(name) ||
    declaredNames(file).captures.has(name) ||
    sources.captures.bare(name) !== undefined ||
    sources.captures.elsewhere(name) !== undefined
  );
}

function requestReferenceProblem(
  target: Exclude<ReferenceTarget, { kind: 'name' }>,
  expression: string,
  budget: JsonPathBudget,
): Problem | undefined {
  switch (target.kind) {
    case 'invalid':
      return { code: target.code, severity: 'error', message: target.message };
    case 'response': {
      const problem = target.query === undefined ? undefined : budget.check(target.query)?.problem;
      return problem === undefined
        ? undefined
        : {
            code: 'invalid-variable',
            severity: 'error',
            message: jsonPathMessage(expression, problem.message),
          };
    }
    case 'capture':
      return undefined;
  }
}

function referenceProblem(
  file: HttpFile,
  expression: string,
  sources: VariableSources,
  budget: JsonPathBudget,
): Problem | undefined {
  const target = expression.startsWith('$')
    ? undefined
    : referenceTarget(file, expression, sources);
  if (target !== undefined && target.kind !== 'name') {
    return requestReferenceProblem(target, expression, budget);
  }
  const format = sendTimeFormats[head(expression)];
  if (format) {
    return format.test(expression)
      ? undefined
      : {
          code: 'invalid-variable',
          severity: 'error',
          message: `\`{{${expression}}}\` does not match the expected format \`${systemCompletions.find((entry) => entry.label === head(expression))?.detail ?? ''}\`.`,
        };
  }
  if (head(expression) === '$shared' || !expression.startsWith('$')) {
    if (!expression.startsWith('$') && definedName(file, expression, sources)) {
      return undefined;
    }
    const evaluated = evaluateExpression(file, expression, sources, target);
    if (evaluated.ok) {
      return undefined;
    }
    const malformed = evaluated.message.includes('expected format');
    return {
      code: malformed ? 'invalid-variable' : 'undefined-variable',
      severity: malformed ? 'error' : 'warning',
      message: evaluated.message,
    };
  }
  const problem = systemProblem(expression);
  return problem === undefined
    ? undefined
    : { code: 'invalid-variable', severity: 'error', message: problem };
}

export function variableDiagnostics(
  file: HttpFile,
  sources: VariableSources,
  clock: Clock = wallClock,
): ParseDiagnostic[] {
  const budget = new JsonPathBudget(clock);
  return file.requests.flatMap((request) =>
    request.variableReferences.flatMap((reference) => {
      const problem = referenceProblem(file, reference.expression, sources, budget);
      return problem ? [{ ...problem, range: reference.range }] : [];
    }),
  );
}

export function variableCompletions(
  file: HttpFile,
  sources: VariableSources,
): VariableCompletion[] {
  const completions = new Map<string, VariableCompletion>();
  const add = (label: string, detail: string): void => {
    if (!completions.has(label)) {
      completions.set(label, { label, detail });
    }
  };
  for (const variable of file.fileVariables) {
    add(variable.name, 'file variable');
  }
  for (const [name, value] of sources.environment) {
    add(name, value.origin);
  }
  for (const [name, value] of sources.shared) {
    add(name, value.origin);
  }
  return [...completions.values(), ...systemCompletions];
}

export function secretCandidates(file: HttpFile): FileVariable[] {
  return file.fileVariables.filter(
    (variable) =>
      looksLikeCredential(variable.name) &&
      variable.value.trim() !== '' &&
      !variable.value.includes('{{'),
  );
}
