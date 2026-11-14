import type { CompareOperator, Expr, Span, Value } from '../expressions/ast';
import { compareValues } from '../expressions/compare';
import { evaluate } from '../expressions/evaluate';
import { compactJson, maxInsertedLength } from '../expressions/insert';
import type { WorkBudget } from '../expressions/work';
import { canonicalKey } from './canonical';
import type { CheckProgram, Operand, Skeleton, Term } from './compile';

export type TermState =
  | { kind: 'pending' }
  | { kind: 'value'; value: Value; preview: string }
  | { kind: 'missing'; reason: string }
  | { kind: 'error'; reason: string }
  | { kind: 'count'; count: number; index: number | undefined; final: boolean }
  | { kind: 'before'; first: number | undefined; second: number | undefined; final: boolean };

export type Verdict =
  { state: 'pending' } | { state: 'passed' } | { state: 'failed'; detail: string };

export interface Judged {
  truth: boolean | undefined;
  why: string;
}

export interface VerdictOptions {
  format: (value: Value) => string;
  budget?: WorkBudget;
  memo?: Map<Skeleton, Judged>;
}

type Side =
  | { kind: 'known'; value: Value; preview: string; literal: boolean; text: string }
  | { kind: 'regex'; node: Expr; text: string }
  | { kind: 'missing'; reason: string; text: string }
  | { kind: 'bound'; count: number; text: string }
  | { kind: 'unknown' };

interface Context {
  program: CheckProgram;
  states: ReadonlyMap<number, TermState>;
  options: VerdictOptions;
}

const maxShown = 200;
export const tooMuchWorkDetail = 'the check needs too much work for this response';
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

export function cutText(text: string, length = maxShown): string {
  if (text.length <= length) {
    return text;
  }
  const end = /[\uD800-\uDBFF]/.test(text.charAt(length - 2)) ? length - 2 : length - 1;
  return `${text.slice(0, end)}…`;
}

export function shown(value: Value): string {
  const short = compactJson(value, maxShown);
  if (short.ok) {
    return short.text;
  }
  const full = compactJson(value, maxInsertedLength);
  return full.ok ? cutText(full.text) : '…';
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

function stateOf(context: Context, term: number): TermState {
  return context.states.get(term) ?? { kind: 'pending' };
}

function textOf(context: Context, term: number): string {
  return context.program.terms[term]?.text ?? '';
}

function side(operand: Operand, context: Context): Side {
  if (operand.kind === 'literal') {
    return {
      kind: 'known',
      value: operand.value,
      preview: context.options.format(operand.value),
      literal: true,
      text: operand.text,
    };
  }
  if (operand.kind === 'regex') {
    return { kind: 'regex', node: operand.node, text: operand.text };
  }
  const text = textOf(context, operand.term);
  const state = stateOf(context, operand.term);
  switch (state.kind) {
    case 'value':
      return { kind: 'known', value: state.value, preview: state.preview, literal: false, text };
    case 'missing':
      return { kind: 'missing', reason: state.reason, text };
    case 'count':
      return state.final
        ? {
            kind: 'known',
            value: state.count,
            preview: String(state.count),
            literal: false,
            text,
          }
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

function compared(node: Extract<Skeleton, { kind: 'compare' }>, context: Context): Judged {
  const left = side(node.left, context);
  const right = side(node.right, context);
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
      : { truth, why: `${bound.text} reached ${String(bound.count)}` };
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
    { budget: context.options.budget },
  );
  const truth = outcome.present && outcome.value === true;
  let why: string;
  if (right.kind === 'regex' || right.literal) {
    why = `got ${left.preview}`;
  } else if (left.literal) {
    why = `got ${right.preview}`;
  } else {
    why = `${left.text} is ${left.preview}, ${right.text} is ${right.preview}`;
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

function matched(node: Extract<Skeleton, { kind: 'matched' }>, context: Context): Judged {
  const state = stateOf(context, node.term);
  if (state.kind !== 'count') {
    return unknown;
  }
  if (state.count >= node.at) {
    return {
      truth: true,
      why: `${node.text} matched event ${String(state.index ?? state.count)}`,
    };
  }
  return state.final ? { truth: false, why: `${node.text} matched no event` } : unknown;
}

function unique(
  text: string,
  state: Extract<TermState, { kind: 'value' }>,
  context: Context,
): Judged {
  const { value } = state;
  if (!Array.isArray(value)) {
    return { truth: false, why: `${text} is ${state.preview}, not a list` };
  }
  const seen = new Set<string>();
  for (const item of value as readonly Value[]) {
    const key = canonicalKey(item);
    if (seen.has(key)) {
      return { truth: false, why: `${context.options.format(item)} appears more than once` };
    }
    seen.add(key);
  }
  return { truth: true, why: `all values of ${text} are distinct` };
}

function judgeNode(node: Skeleton, context: Context): Judged {
  switch (node.kind) {
    case 'and': {
      const left = judge(node.left, context);
      const right = judge(node.right, context);
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
      const left = judge(node.left, context);
      const right = judge(node.right, context);
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
      const inner = judge(node.operand, context);
      return inner.truth === undefined ? unknown : { truth: !inner.truth, why: inner.why };
    }
    case 'compare':
      return compared(node, context);
    case 'before':
      return before(context.program.terms[node.term], stateOf(context, node.term));
    case 'matched':
      return matched(node, context);
    default: {
      const text = textOf(context, node.term);
      const state = stateOf(context, node.term);
      if (state.kind === 'missing') {
        return { truth: false, why: missingWhy(text, state.reason) };
      }
      if (state.kind !== 'value') {
        return unknown;
      }
      if (node.kind === 'unique') {
        return unique(text, state, context);
      }
      return {
        truth: node.kind === 'exists' ? true : isTruthy(state.value),
        why: `${text} is ${state.preview}`,
      };
    }
  }
}

function judge(node: Skeleton, context: Context): Judged {
  const known = context.options.memo?.get(node);
  if (known !== undefined) {
    return known;
  }
  const result = judgeNode(node, context);
  if (result.truth !== undefined && context.options.budget?.exhausted !== true) {
    context.options.memo?.set(node, result);
  }
  return result;
}

export function verdictOf(
  program: CheckProgram,
  states: ReadonlyMap<number, TermState>,
  options: VerdictOptions = { format: shown },
): Verdict {
  for (const term of program.terms) {
    const state = states.get(term.id);
    if (state?.kind === 'error') {
      return { state: 'failed', detail: `${term.text} could not be evaluated: ${state.reason}` };
    }
  }
  const result = judge(program.skeleton, { program, states, options });
  if (options.budget?.exhausted === true) {
    return { state: 'failed', detail: tooMuchWorkDetail };
  }
  if (result.truth === undefined) {
    return { state: 'pending' };
  }
  return result.truth ? { state: 'passed' } : { state: 'failed', detail: result.why };
}
