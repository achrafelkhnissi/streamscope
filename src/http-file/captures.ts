import type { Expr } from '../expressions/ast';
import { checkJsonPath, knownJsonPathCheck, type KnownCheck } from '../expressions/jsonpath';
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
const jsonPathBudgetMs = 10;
const uncheckedMessage =
  'Some jsonpath() queries in this request were not checked yet; they are checked as you edit.';

const capturePattern = /^(?:(secret)\s+)?([A-Za-z_]\w*)\s*=\s*(\S(?:.*\S)?)$/d;

export interface ExpressionCheck {
  expression: Expr | undefined;
  diagnostics: ParseDiagnostic[];
}

export type Clock = () => number;

function problem(
  code: DiagnosticCode,
  message: string,
  range: Range,
  severity: 'error' | 'warning' = 'error',
): ParseDiagnostic {
  return { code, message, severity, range };
}

function inExpression(start: Position, from: number, to: number): Range {
  return span(start.line, start.character + from, start.character + to);
}

export class JsonPathBudget {
  private spent = 0;

  constructor(private readonly now: Clock) {}

  check(query: string): KnownCheck | undefined {
    const known = knownJsonPathCheck(query);
    if (known !== undefined || this.spent >= jsonPathBudgetMs) {
      return known;
    }
    const started = this.now();
    const found = checkJsonPath(query);
    this.spent += this.now() - started;
    return { problem: found };
  }
}

export class RequestChecks {
  private warned = false;

  constructor(private readonly budget: JsonPathBudget) {}

  expression(text: string, start: Position, context: ExpressionContext): ExpressionCheck {
    const result = parseExpression(text, context);
    if (!result.ok) {
      const { message, span: failed } = result.error;
      return {
        expression: undefined,
        diagnostics: [
          problem('invalid-expression', message, inExpression(start, failed.start, failed.end)),
        ],
      };
    }
    return {
      expression: result.expr,
      diagnostics: this.jsonPathProblems(text, start, result.expr),
    };
  }

  private jsonPathProblems(text: string, start: Position, expression: Expr): ParseDiagnostic[] {
    const problems: ParseDiagnostic[] = [];
    for (const node of sourcesOf(expression)) {
      if (node.kind !== 'jsonpath') {
        continue;
      }
      const { start: open, end: close } = node.querySpan;
      const checked = this.budget.check(node.query);
      if (checked === undefined) {
        if (!this.warned) {
          this.warned = true;
          problems.push(
            problem(
              'unchecked-expression',
              uncheckedMessage,
              inExpression(start, open, close),
              'warning',
            ),
          );
        }
        continue;
      }
      const found = checked.problem;
      if (found === undefined) {
        continue;
      }
      if (text.slice(open + 1, close - 1).includes('\\')) {
        problems.push(
          problem('invalid-expression', found.message, inExpression(start, open, close)),
        );
      } else {
        const from = open + 1 + found.offset;
        const width = (node.query.codePointAt(found.offset) ?? 0) > 0xffff ? 2 : 1;
        problems.push(
          problem('invalid-expression', found.message, inExpression(start, from, from + width)),
        );
      }
    }
    return problems;
  }
}

export class CaptureReader {
  readonly captures: CaptureDirective[] = [];
  private readonly names = new Set<string>();
  private lines = 0;

  constructor(private readonly checks: RequestChecks) {}

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
    const checked = this.checks.expression(expressionText, expressionStart, 'capture');
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
