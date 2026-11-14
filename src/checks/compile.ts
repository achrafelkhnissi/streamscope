import type { CompareOperator, Expr, Span, Value } from '../expressions/ast';
import { evaluate } from '../expressions/evaluate';
import { sourcesOf } from '../expressions/parse';

export type Term =
  | { kind: 'value'; id: number; expr: Expr; text: string; problem: string | undefined }
  | { kind: 'count'; id: number; condition: Expr | undefined; text: string }
  | {
      kind: 'before';
      id: number;
      first: Expr;
      second: Expr;
      firstText: string;
      secondText: string;
      text: string;
    };

export type Operand =
  | { kind: 'term'; term: number }
  | { kind: 'literal'; value: Value; text: string }
  | { kind: 'regex'; node: Expr; text: string };

export type Skeleton =
  | { kind: 'and' | 'or'; left: Skeleton; right: Skeleton }
  | { kind: 'not'; operand: Skeleton }
  | { kind: 'compare'; operator: CompareOperator; left: Operand; right: Operand; span: Span }
  | { kind: 'exists' | 'unique' | 'truthy' | 'before'; term: number }
  | { kind: 'matched'; term: number; at: number; text: string };

export interface CheckProgram {
  skeleton: Skeleton;
  terms: readonly Term[];
  text: string;
}

const noSources = { value: () => ({ present: false as const, reason: 'no sources' }) };
const comboMessage =
  'exists(…), before(…) and unique(…) can only be combined with &&, || and !, or compared with true or false';

function booleanLiteral(node: Expr): boolean | undefined {
  return node.kind === 'literal' && typeof node.value === 'boolean' ? node.value : undefined;
}

function literalValue(node: Expr): Value {
  const outcome = evaluate(node, noSources);
  return outcome.present ? outcome.value : null;
}

function isNumberLiteral(node: Expr): boolean {
  return (
    node.kind === 'literal' && (typeof node.value === 'number' || typeof node.value === 'bigint')
  );
}

function booleanCheck(
  operator: CompareOperator,
  check: Expr,
  literal: Expr,
): { check: Expr; flag: boolean } | undefined {
  const flag = booleanLiteral(literal);
  return check.kind === 'check' && flag !== undefined && (operator === '==' || operator === '!=')
    ? { check, flag }
    : undefined;
}

export function compileCheck(expression: Expr, text: string): CheckProgram {
  const terms: Term[] = [];
  const known = new Map<string, number>();
  const textOf = (node: Expr): string => text.slice(node.span.start, node.span.end);
  const add = (key: string, make: (id: number) => Term): number => {
    const found = known.get(key);
    if (found !== undefined) {
      return found;
    }
    const id = terms.length;
    terms.push(make(id));
    known.set(key, id);
    return id;
  };
  const valueTerm = (node: Expr): number =>
    add(`value\u0000${textOf(node)}`, (id) => ({
      kind: 'value',
      id,
      expr: node,
      text: textOf(node),
      problem: sourcesOf(node).some((source) => source.kind === 'check') ? comboMessage : undefined,
    }));
  const countTerm = (condition: Expr | undefined): number => {
    const countText = `count(${condition === undefined ? '' : textOf(condition)})`;
    return add(`count\u0000${countText}`, (id) => ({
      kind: 'count',
      id,
      condition,
      text: countText,
    }));
  };
  const operand = (node: Expr, other: Expr): Operand => {
    if (node.kind === 'literal' || node.kind === 'list') {
      return { kind: 'literal', value: literalValue(node), text: textOf(node) };
    }
    if (node.kind === 'regex') {
      return { kind: 'regex', node, text: textOf(node) };
    }
    if (node.kind === 'events' && node.name === 'count' && isNumberLiteral(other)) {
      return { kind: 'term', term: countTerm(node.condition) };
    }
    return { kind: 'term', term: valueTerm(node) };
  };
  const skeleton = (node: Expr): Skeleton => {
    switch (node.kind) {
      case 'logical':
        return {
          kind: node.operator === '&&' ? 'and' : 'or',
          left: skeleton(node.left),
          right: skeleton(node.right),
        };
      case 'not':
        return { kind: 'not', operand: skeleton(node.operand) };
      case 'compare': {
        const folded =
          booleanCheck(node.operator, node.left, node.right) ??
          booleanCheck(node.operator, node.right, node.left);
        if (folded !== undefined) {
          return (node.operator === '==') === folded.flag
            ? skeleton(folded.check)
            : { kind: 'not', operand: skeleton(folded.check) };
        }
        return {
          kind: 'compare',
          operator: node.operator,
          left: operand(node.left, node.right),
          right: operand(node.right, node.left),
          span: node.span,
        };
      }
      case 'check': {
        const [first, second] = node.args;
        if (node.name === 'before' && first !== undefined && second !== undefined) {
          return {
            kind: 'before',
            term: add(`before\u0000${textOf(node)}`, (id) => ({
              kind: 'before',
              id,
              first,
              second,
              firstText: textOf(first),
              secondText: textOf(second),
              text: textOf(node),
            })),
          };
        }
        if (node.name === 'exists' && first !== undefined) {
          if (first.kind === 'events' && (first.name === 'first' || first.name === 'last')) {
            return {
              kind: 'matched',
              term: countTerm(first.condition),
              at: 1,
              text: textOf(first),
            };
          }
          if (first.kind === 'nth') {
            return {
              kind: 'matched',
              term: countTerm(first.condition),
              at: first.position,
              text: textOf(first),
            };
          }
        }
        return {
          kind: node.name === 'unique' ? 'unique' : 'exists',
          term: valueTerm(first ?? node),
        };
      }
      default:
        return { kind: 'truthy', term: valueTerm(node) };
    }
  };
  return { skeleton: skeleton(expression), terms, text };
}
