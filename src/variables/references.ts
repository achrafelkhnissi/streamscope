import type { DiagnosticCode, HttpFile } from '../http-file/model';
import type { VariableSources } from './sources';

export type ResponseSelector =
  | { ok: true; part: 'head'; header: string }
  | { ok: true; part: 'body'; query: string | undefined }
  | { ok: false; reason: string };

export type ReferenceTarget =
  | { kind: 'name' }
  | { kind: 'capture'; request: string; name: string }
  | {
      kind: 'response';
      request: string;
      reference: string;
      query: string | undefined;
      known: boolean;
    }
  | { kind: 'invalid'; code: DiagnosticCode; message: string };

export interface DeclaredNames {
  readonly requests: ReadonlyMap<string, ReadonlySet<string>>;
  readonly captures: ReadonlySet<string>;
  readonly variables: ReadonlySet<string>;
}

const referencePattern = /^([^.\s]+)\.((request|response)\..*|.+)$/s;
const bodyPrefix = 'response.body';
const headersPrefix = 'response.headers';
const declared = new WeakMap<HttpFile, DeclaredNames>();

export function quoted(expression: string): string {
  return `\`{{${expression}}}\``;
}

export function clause(sentence: string): string {
  return sentence.endsWith('.') ? sentence.slice(0, -1) : sentence;
}

function requestReferenceReason(name: string, reference: string): string {
  return `Request references such as \`{{${name}.${reference}}}\` are not supported; use \`{{${name}.response.…}}\`.`;
}

function xpathReason(name: string): string {
  return `XPath is not supported in \`{{${name}.response.body…}}\`; use a JSONPath starting with \`$\`.`;
}

function bodySelectorReason(name: string): string {
  return `A body reference needs \`*\` or a JSONPath, such as \`{{${name}.response.body.*}}\` or \`{{${name}.response.body.$.id}}\`.`;
}

function headerNameReason(name: string): string {
  return `A header reference needs a header name, such as \`{{${name}.response.headers.Content-Type}}\`.`;
}

function unsupportedResponseReason(name: string, reference: string): string {
  return `\`{{${name}.${reference}}}\` is not supported; use \`{{${name}.response.body.*}}\`, \`{{${name}.response.body.$…}}\` or \`{{${name}.response.headers.<name>}}\`.`;
}

function unknownCaptureMessage(request: string, name: string): string {
  return `${request} has no capture named ${name}.`;
}

export function unknownRequestMessage(expression: string, request: string): string {
  return `${quoted(expression)}: no request in this file is named ${request}.`;
}

export function notRunMessage(expression: string, label: string): string {
  return `${quoted(expression)} comes from ${label}, which has not run in this session.`;
}

export function pendingMessage(label: string, name: string): string {
  return `${label} › ${name} has not arrived yet.`;
}

export function jsonPathMessage(expression: string, problem: string): string {
  return `${quoted(expression)}: ${clause(problem)}.`;
}

function under(reference: string, prefix: string): string | undefined {
  if (reference === prefix) {
    return '';
  }
  return reference.startsWith(`${prefix}.`) ? reference.slice(prefix.length + 1) : undefined;
}

export function responseSelector(name: string, reference: string): ResponseSelector {
  if (reference.split('.', 1)[0] === 'request') {
    return { ok: false, reason: requestReferenceReason(name, reference) };
  }
  const selector = under(reference, bodyPrefix);
  if (selector !== undefined) {
    if (selector === '*') {
      return { ok: true, part: 'body', query: undefined };
    }
    if (selector === '') {
      return { ok: false, reason: bodySelectorReason(name) };
    }
    return selector.startsWith('$')
      ? { ok: true, part: 'body', query: selector }
      : { ok: false, reason: xpathReason(name) };
  }
  const header = under(reference, headersPrefix);
  if (header !== undefined) {
    return header === ''
      ? { ok: false, reason: headerNameReason(name) }
      : { ok: true, part: 'head', header };
  }
  return { ok: false, reason: unsupportedResponseReason(name, reference) };
}

export function declaredNames(file: HttpFile): DeclaredNames {
  const known = declared.get(file);
  if (known !== undefined) {
    return known;
  }
  const requests = new Map<string, Set<string>>();
  const captures = new Set<string>();
  for (const request of file.requests) {
    let named: Set<string> | undefined;
    if (request.name !== undefined) {
      named = requests.get(request.name) ?? new Set<string>();
      requests.set(request.name, named);
    }
    for (const capture of request.captures) {
      captures.add(capture.name);
      named?.add(capture.name);
    }
  }
  const variables = new Set(file.fileVariables.map((variable) => variable.name));
  const index: DeclaredNames = { requests, captures, variables };
  declared.set(file, index);
  return index;
}

export function referenceTarget(
  file: HttpFile,
  expression: string,
  sources: Pick<VariableSources, 'environment' | 'shared'>,
): ReferenceTarget {
  const match = referencePattern.exec(expression);
  if (match === null) {
    return { kind: 'name' };
  }
  const request = match[1] ?? '';
  const rest = match[2] ?? '';
  const names = declaredNames(file);
  const captures = names.requests.get(request);
  if (match[3] !== undefined) {
    const selector = responseSelector(request, rest);
    if (!selector.ok) {
      return { kind: 'invalid', code: 'invalid-variable', message: selector.reason };
    }
    return {
      kind: 'response',
      request,
      reference: rest,
      query: selector.part === 'body' ? selector.query : undefined,
      known: captures !== undefined,
    };
  }
  if (captures === undefined) {
    return { kind: 'name' };
  }
  if (captures.has(rest)) {
    return { kind: 'capture', request, name: rest };
  }
  const variable =
    names.variables.has(expression) ||
    sources.environment.has(expression) ||
    sources.shared.has(expression);
  return variable
    ? { kind: 'name' }
    : {
        kind: 'invalid',
        code: 'undefined-variable',
        message: unknownCaptureMessage(request, rest),
      };
}
