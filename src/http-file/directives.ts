import { parseDuration } from '../runs/duration';
import type { DiagnosticCode, Directive, ParseDiagnostic } from './model';

export const requestNamePattern = /^\w+$/;
const capturePattern = /^(secret\s+)?[A-Za-z_]\w*\s*=\s*\S/;
const streamFormats: ReadonlySet<string> = new Set([
  'sse',
  'ndjson',
  'json',
  'text',
  'raw',
  'auto',
]);
const flagKinds: ReadonlySet<string> = new Set(['insecure', 'no-redirect', 'no-cookie-jar']);

function problem(
  directive: Directive,
  code: DiagnosticCode,
  message: string,
  severity: 'error' | 'warning' = 'error',
): ParseDiagnostic[] {
  const range = directive.argument === '' ? directive.range : directive.argumentRange;
  return [{ code, message, severity, range }];
}

export function directiveDiagnostics(directive: Directive): ParseDiagnostic[] {
  const { kind, argument } = directive;
  if (kind === 'name' && !requestNamePattern.test(argument)) {
    return problem(
      directive,
      'invalid-name',
      'Request names may only contain letters, digits and underscores.',
    );
  }
  if (kind === 'capture' && !capturePattern.test(argument)) {
    return problem(
      directive,
      'invalid-capture',
      'Expected "# @capture [secret] name = expression".',
    );
  }
  if (kind === 'expect' && argument === '') {
    return problem(directive, 'empty-expect', 'Expected an expression after "# @expect".');
  }
  if (kind === 'until' && argument === '') {
    return problem(directive, 'empty-until', 'Expected an event condition after "# @until".');
  }
  if (kind === 'stream' && !streamFormats.has(argument)) {
    return problem(
      directive,
      'invalid-stream',
      'Expected one of sse, ndjson, json, text, raw or auto.',
    );
  }
  if (kind === 'timeout' && parseDuration(argument) === undefined) {
    return problem(directive, 'invalid-timeout', 'Expected a duration such as 500ms, 30s or 5m.');
  }
  if (flagKinds.has(kind) && argument !== '') {
    return problem(directive, 'unexpected-argument', `"# @${kind}" takes no argument.`, 'warning');
  }
  return [];
}
