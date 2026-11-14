import type { CompareOperator, Expr, Span, Value } from '../expressions/ast';
import { compareValues } from '../expressions/compare';
import { evaluate } from '../expressions/evaluate';
import { compactJson, maxInsertedLength } from '../expressions/insert';
import { canonicalKey } from './canonical';
import type { CheckProgram, Operand, Skeleton, Term } from './compile';

export type TermState =
  | { kind: 'pending' }
  | { kind: 'value'; value: Value }
  | { kind: 'missing'; reason: string }
  | { kind: 'count'; count: number; final: boolean }
  | { kind: 'before'; first: number | undefined; second: number | undefined; final: boolean };

export type Verdict =
  { state: 'pending' } | { state: 'passed' } | { state: 'failed'; detail: string };

interface Judged {
  truth: boolean | undefined;
  why: string;
}

type Side =
  | { kind: 'known'; value: Value; literal: boolean; text: string }
  | { kind: 'regex'; node: Expr; text: string }
  | { kind: 'missing'; reason: string; text: string }
  | { kind: 'bound'; count: number; text: string }
  | { kind: 'unknown' };

const maxShown = 200;
const unknown: Judged = { truth: undefined, why: '' };
const noSources = { value: () => ({ present: false as const, reason: 'no sources' }) };
const flipped: Record<CompareOperator, CompareOperator> = {
  '==': '==',
  '!=': '!=',
  '<': '>',
  '<=': '>=',
  '>': '<',
  '>=': '<=',
  in: 'in',
  contains: 'contains',
  startsWith: 'startsWith',
  matches: 'matches',
};

export function shown(value: Value): string {
  const short = compactJson(value, maxShown);
  if (short.ok) {
    return short.text;
  }
  const full = compactJson(value, maxInsertedLength);
  return `${full.ok ? full.text.slice(0, maxShown - 1) : ''}…`;
}

function isTruthy(value: Value): boolean {
  return value !== false && value !== null && !(Array.isArray(value) && value.length === 0);
}

function joined(parts: readonly Judged[]): string {
  return parts
    .map(({ why }) => why)
    .filter((why) => why !== '')
    .join('; ');
}

function missingWhy(text: string, reason: string): string {
  return `${text} is missing: ${reason}`;
}

function stateOf(states: ReadonlyMap<number, TermState>, term: number): TermState {
  return states.get(term) ?? { kind: 'pending' };
}

function side(
  operand: Operand,
  terms: readonly Term[],
  states: ReadonlyMap<number, TermState>,
): Side {
  if (operand.kind === 'literal') {
    return { kind: 'known', value: operand.value, literal: true, text: operand.text };
  }
  if (operand.kind === 'regex') {
    return { kind: 'regex', node: operand.node, text: operand.text };
  }
  const text = terms[operand.term]?.text ?? '';
  const state = stateOf(states, operand.term);
  switch (state.kind) {
    case 'value':
      return { kind: 'known', value: state.value, literal: false, text };
    case 'missing':
      return { kind: 'missing', reason: state.reason, text };
    case 'count':
      return state.final
        ? { kind: 'known', value: state.count, literal: false, text }
        : { kind: 'bound', count: state.count, text };
    default:
      return { kind: 'unknown' };
  }
}

function early(operator: CompareOperator, count: number, limit: Value): boolean | undefined {
  const order = compareValues(count, limit);
  if (order === undefined) {
    return undefined;
  }
  switch (operator) {
    case '>':
      return order > 0 ? true : undefined;
    case '>=':
      return order >= 0 ? true : undefined;
    case '<':
      return order >= 0 ? false : undefined;
    case '<=':
    case '==':
      return order > 0 ? false : undefined;
    case '!=':
      return order > 0 ? true : undefined;
    default:
      return undefined;
  }
}

function literalNode(value: Value, span: Span): Expr {
  return { kind: 'literal', value, span };
}

function compared(
  node: Extract<Skeleton, { kind: 'compare' }>,
  terms: readonly Term[],
  states: ReadonlyMap<number, TermState>,
): Judged {
  const left = side(node.left, terms, states);
  const right = side(node.right, terms, states);
  for (const part of [left, right]) {
    if (part.kind === 'missing') {
      return { truth: false, why: missingWhy(part.text, part.reason) };
    }
  }
  if (left.kind === 'bound' || right.kind === 'bound') {
    const bound = left.kind === 'bound' ? left : right;
    const other = left.kind === 'bound' ? right : left;
    if (bound.kind !== 'bound' || other.kind !== 'known' || !other.literal) {
      return unknown;
    }
    const operator = left.kind === 'bound' ? node.operator : flipped[node.operator];
    const truth = early(operator, bound.count, other.value);
    return truth === undefined
      ? unknown
      : { truth, why: truth ? '' : `${bound.text} reached ${String(bound.count)}` };
  }
  if (left.kind !== 'known' || (right.kind !== 'known' && right.kind !== 'regex')) {
    return unknown;
  }
  const outcome = evaluate(
    {
      kind: 'compare',
      operator: node.operator,
      left: literalNode(left.value, node.span),
      right: right.kind === 'regex' ? right.node : literalNode(right.value, node.span),
      span: node.span,
    },
    noSources,
  );
  const truth = outcome.present && outcome.value === true;
  let why: string;
  if (right.kind === 'regex' || right.literal) {
    why = `got ${shown(left.value)}`;
  } else if (left.literal) {
    why = `got ${shown(right.value)}`;
  } else {
    why = `${left.text} is ${shown(left.value)}, ${right.text} is ${shown(right.value)}`;
  }
  return { truth, why };
}

function before(term: Term | undefined, state: TermState): Judged {
  if (term?.kind !== 'before' || state.kind !== 'before') {
    return unknown;
  }
  const { first, second, final } = state;
  if (second !== undefined && (first === undefined || second <= first)) {
    return {
      truth: false,
      why:
        first === second
          ? `${term.firstText} and ${term.secondText} matched the same event ${String(second)}`
          : `${term.secondText} matched event ${String(second)} first`,
    };
  }
  if (first !== undefined) {
    return { truth: true, why: `${term.firstText} matched event ${String(first)} first` };
  }
  return final ? { truth: false, why: `no event matched ${term.firstText}` } : unknown;
}

function unique(text: string, value: Value): Judged {
  if (!Array.isArray(value)) {
    return { truth: false, why: `${text} is ${shown(value)}, not a list` };
  }
  const seen = new Set<string>();
  for (const item of value as readonly Value[]) {
    const key = canonicalKey(item);
    if (seen.has(key)) {
      return { truth: false, why: `${shown(item)} appears more than once` };
    }
    seen.add(key);
  }
  return { truth: true, why: '' };
}

function judge(
  node: Skeleton,
  program: CheckProgram,
  states: ReadonlyMap<number, TermState>,
): Judged {
  switch (node.kind) {
    case 'and': {
      const left = judge(node.left, program, states);
      const right = judge(node.right, program, states);
      if (left.truth === false) {
        return left;
      }
      if (right.truth === false) {
        return right;
      }
      return left.truth === true && right.truth === true
        ? { truth: true, why: joined([left, right]) }
        : unknown;
    }
    case 'or': {
      const left = judge(node.left, program, states);
      const right = judge(node.right, program, states);
      if (left.truth === true) {
        return left;
      }
      if (right.truth === true) {
        return right;
      }
      return left.truth === false && right.truth === false
        ? { truth: false, why: joined([left, right]) }
        : unknown;
    }
    case 'not': {
      const inner = judge(node.operand, program, states);
      return inner.truth === undefined ? unknown : { truth: !inner.truth, why: inner.why };
    }
    case 'compare':
      return compared(node, program.terms, states);
    case 'before':
      return before(program.terms[node.term], stateOf(states, node.term));
    default: {
      const text = program.terms[node.term]?.text ?? '';
      const state = stateOf(states, node.term);
      if (state.kind === 'missing') {
        return { truth: false, why: missingWhy(text, state.reason) };
      }
      if (state.kind !== 'value') {
        return unknown;
      }
      if (node.kind === 'unique') {
        return unique(text, state.value);
      }
      return {
        truth: node.kind === 'exists' ? true : isTruthy(state.value),
        why: `${text} is ${shown(state.value)}`,
      };
    }
  }
}

export function verdictOf(program: CheckProgram, states: ReadonlyMap<number, TermState>): Verdict {
  const result = judge(program.skeleton, program, states);
  if (result.truth === undefined) {
    return { state: 'pending' };
  }
  return result.truth ? { state: 'passed' } : { state: 'failed', detail: result.why };
}
