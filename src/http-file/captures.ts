import type { Expr } from '../expressions/ast';
import { checkJsonPath } from '../expressions/jsonpath';
import { parseExpression, sourcesOf, type ExpressionContext } from '../expressions/parse';
import type {
  CaptureDirective,
  DiagnosticCode,
  Directive,
  ParseDiagnostic,
  Position,
  Range,
} from './model';
import { span } from './ranges';

const maxCaptures = 64;

const capturePattern = /^(?:(secret)\s+)?([A-Za-z_]\w*)\s*=\s*(\S(?:.*\S)?)$/d;

export interface ExpressionCheck {
  expression: Expr | undefined;
  diagnostics: ParseDiagnostic[];
}

function problem(code: DiagnosticCode, message: string, range: Range): ParseDiagnostic {
  return { code, message, severity: 'error', range };
}

function expressionProblem(
  start: Position,
  from: number,
  to: number,
  message: string,
): ParseDiagnostic {
  return problem(
    'invalid-expression',
    message,
    span(start.line, start.character + from, start.character + to),
  );
}

function jsonPathProblems(text: string, start: Position, expression: Expr): ParseDiagnostic[] {
  const problems: ParseDiagnostic[] = [];
  for (const node of sourcesOf(expression)) {
    if (node.kind !== 'jsonpath') {
      continue;
    }
    const found = checkJsonPath(node.query);
    if (found === undefined) {
      continue;
    }
    const { start: open, end: close } = node.querySpan;
    if (text.slice(open + 1, close - 1).includes('\\')) {
      problems.push(expressionProblem(start, open, close, found.message));
    } else {
      const from = open + 1 + found.offset;
      const width = (node.query.codePointAt(found.offset) ?? 0) > 0xffff ? 2 : 1;
      problems.push(expressionProblem(start, from, from + width, found.message));
    }
  }
  return problems;
}

export function checkExpression(
  text: string,
  start: Position,
  context: ExpressionContext,
): ExpressionCheck {
  const result = parseExpression(text, context);
  if (!result.ok) {
    const { message, span: failed } = result.error;
    return {
      expression: undefined,
      diagnostics: [expressionProblem(start, failed.start, failed.end, message)],
    };
  }
  return { expression: result.expr, diagnostics: jsonPathProblems(text, start, result.expr) };
}

export class CaptureReader {
  readonly captures: CaptureDirective[] = [];
  private readonly names = new Set<string>();
  private lines = 0;

  read(directive: Directive): ParseDiagnostic[] {
    this.lines += 1;
    if (this.lines > maxCaptures) {
      return this.lines === maxCaptures + 1
        ? [
            problem(
              'too-many-captures',
              `A request can have at most ${String(maxCaptures)} captures.`,
              directive.range,
            ),
          ]
        : [];
    }
    const match = capturePattern.exec(directive.argument);
    const nameIndices = match?.indices?.[2];
    const expressionIndices = match?.indices?.[3];
    if (!match || !nameIndices || !expressionIndices) {
      return [
        problem(
          'invalid-capture',
          'Expected "# @capture [secret] name = expression".',
          directive.argument === '' ? directive.range : directive.argumentRange,
        ),
      ];
    }
    const { line, character } = directive.argumentRange.start;
    const name = match[2] ?? '';
    const nameRange = span(line, character + nameIndices[0], character + nameIndices[1]);
    const expressionStart = { line, character: character + expressionIndices[0] };
    const expressionText = match[3] ?? '';
    const diagnostics: ParseDiagnostic[] = [];
    if (this.names.has(name)) {
      diagnostics.push(
        problem('duplicate-capture', `${name} is captured twice on this request.`, nameRange),
      );
    }
    this.names.add(name);
    const checked = checkExpression(expressionText, expressionStart, 'capture');
    this.captures.push({
      secret: match[1] !== undefined,
      name,
      nameRange,
      expressionText,
      expressionRange: span(line, expressionStart.character, character + expressionIndices[1]),
      expression: checked.expression,
      range: directive.range,
    });
    return [...diagnostics, ...checked.diagnostics];
  }
}
