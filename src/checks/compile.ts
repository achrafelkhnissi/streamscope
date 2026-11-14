import type { CompareOperator, Expr, Span, Value } from '../expressions/ast';
import { evaluate } from '../expressions/evaluate';

export type Term =
  | { kind: 'value'; id: number; expr: Expr; text: string }
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
  | { kind: 'exists' | 'unique' | 'truthy' | 'before'; term: number };

export interface CheckProgram {
  skeleton: Skeleton;
  terms: readonly Term[];
  text: string;
}

const noSources = { value: () => ({ present: false as const, reason: 'no sources' }) };

function literalValue(node: Expr): Value {
  const outcome = evaluate(node, noSources);
  return outcome.present ? outcome.value : null;
}

function isNumberLiteral(node: Expr): boolean {
  return (
    node.kind === 'literal' && (typeof node.value === 'number' || typeof node.value === 'bigint')
  );
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
    }));
  const operand = (node: Expr, other: Expr): Operand => {
    if (node.kind === 'literal' || node.kind === 'list') {
      return { kind: 'literal', value: literalValue(node), text: textOf(node) };
    }
    if (node.kind === 'regex') {
      return { kind: 'regex', node, text: textOf(node) };
    }
    if (node.kind === 'events' && node.name === 'count' && isNumberLiteral(other)) {
      return {
        kind: 'term',
        term: add(`count\u0000${textOf(node)}`, (id) => ({
          kind: 'count',
          id,
          condition: node.condition,
          text: textOf(node),
        })),
      };
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
      case 'compare':
        return {
          kind: 'compare',
          operator: node.operator,
          left: operand(node.left, node.right),
          right: operand(node.right, node.left),
          span: node.span,
        };
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
