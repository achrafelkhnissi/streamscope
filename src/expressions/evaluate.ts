import type { CompareOperator, Expr, Filter, SourceNode, Step, Value } from './ast';
import { compareValues, equalValues } from './compare';
import { compactJson, insertText, maxInsertedLength } from './insert';
import { compilePattern, type CompileResult } from './regex';
import { isList, isObject } from './value';

export type Outcome =
  | { present: true; value: Value; event?: number; path: string }
  | { present: false; reason: string };

export interface Sources {
  value(node: SourceNode): Outcome;
}

export interface ConditionItem {
  value: Value;
  sse: { event?: string; id?: string; retry?: number } | undefined;
  malformed: boolean;
}

type Present = Extract<Outcome, { present: true }>;
type Absent = Extract<Outcome, { present: false }>;
type ChainNode = Extract<Expr, { kind: 'access' | 'filter' }>;
type LogicalNode = Extract<Expr, { kind: 'logical' }>;
type CompareNode = Extract<Expr, { kind: 'compare' }>;
type NameStep = Extract<Step, { kind: 'name' }>;

interface Scope {
  readonly sources: Sources;
  readonly sse: ConditionItem['sse'];
  readonly explain: boolean;
  item: Value | undefined;
}

interface Walk {
  value: Value;
  path: string;
  event: number | undefined;
  fanned: boolean;
  missing: Absent | undefined;
}

const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const textTooLong = 'the text is too long for this regular expression';
const valueTooLarge = 'the value is larger than 1 MiB';
const silent: Absent = Object.freeze({ present: false, reason: '' });
const yes: Present = Object.freeze({ present: true, value: true, path: '' });
const no: Present = Object.freeze({ present: true, value: false, path: '' });
const unreadable: Sources = { value: () => silent };
const patterns = new WeakMap<object, CompileResult>();

function present(value: Value, path = '', event?: number): Present {
  return event === undefined
    ? { present: true, value, path }
    : { present: true, value, path, event };
}

function absent(reason: string): Absent {
  return { present: false, reason };
}

function noValue(path: string, detail: string): string {
  return path === '' ? `has no value (${detail})` : `has no value at ${path} (${detail})`;
}

function kindOf(value: Value): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
      return 'a string';
    case 'number':
    case 'bigint':
      return 'a number';
    case 'boolean':
      return 'a boolean';
    default:
      return isList(value) ? 'a list' : 'an object';
  }
}

function appendName(path: string, name: string): string {
  if (!identifier.test(name)) {
    return `${path}[${JSON.stringify(name)}]`;
  }
  return path === '' ? name : `${path}.${name}`;
}

function appendStep(path: string, step: Step): string {
  switch (step.kind) {
    case 'name':
      return appendName(path, step.name);
    case 'index':
      return `${path}[${String(step.index)}]`;
    case 'wildcard':
      return `${path}[*]`;
    case 'where':
      return `${path}[?…]`;
  }
}

function readName(input: Value, name: string): Value | undefined {
  return isObject(input) && Object.hasOwn(input, name) ? input[name] : undefined;
}

function readIndex(input: Value, index: number): Value | undefined {
  if (!isList(input)) {
    return undefined;
  }
  const position = index < 0 ? input.length + index : index;
  return position >= 0 && position < input.length ? input[position] : undefined;
}

function stepFailure(input: Value, step: Step, path: string, suffix: string): Absent {
  let detail: string;
  if (step.kind === 'name') {
    detail = isObject(input)
      ? `${JSON.stringify(step.name)} is missing`
      : `the value is ${kindOf(input)}, not an object`;
  } else if (!isList(input)) {
    detail = `the value is ${kindOf(input)}, not a list`;
  } else {
    const count = input.length;
    detail = `the list has ${String(count)} ${count === 1 ? 'item' : 'items'}`;
  }
  return absent(`${noValue(path, detail)}${suffix}`);
}

function compiledPattern(owner: object, pattern: string, flags: string): CompileResult {
  let compiled = patterns.get(owner);
  if (compiled === undefined) {
    compiled = compilePattern(pattern, flags);
    patterns.set(owner, compiled);
  }
  return compiled;
}

function sseValue(sse: NonNullable<ConditionItem['sse']>): Value {
  const fields: Record<string, Value> = {};
  if (sse.event !== undefined) {
    fields['event'] = sse.event;
  }
  if (sse.id !== undefined) {
    fields['id'] = sse.id;
  }
  if (sse.retry !== undefined) {
    fields['retry'] = sse.retry;
  }
  return fields;
}

function relate(
  operator: Exclude<CompareOperator, 'matches' | '==' | '!='>,
  left: Value,
  right: Value,
): boolean {
  switch (operator) {
    case '<':
      return compareValues(left, right) === -1;
    case '>':
      return compareValues(left, right) === 1;
    case '<=': {
      const order = compareValues(left, right);
      return order === -1 || order === 0;
    }
    case '>=': {
      const order = compareValues(left, right);
      return order === 1 || order === 0;
    }
    case 'in':
      return isList(right) && right.some((element) => equalValues(left, element));
    case 'contains':
      if (typeof left === 'string') {
        return typeof right === 'string' && left.includes(right);
      }
      return isList(left) && left.some((element) => equalValues(element, right));
    case 'startsWith':
      return typeof left === 'string' && typeof right === 'string' && left.startsWith(right);
  }
}

function matches(node: CompareNode, scope: Scope): boolean {
  const { right } = node;
  if (right.kind !== 'regex') {
    return false;
  }
  const left = evaluateNode(node.left, scope);
  if (!left.present || typeof left.value !== 'string') {
    return false;
  }
  const compiled = compiledPattern(right, right.pattern, right.flags);
  return compiled.ok && compiled.pattern.test(left.value) === true;
}

function equality(node: CompareNode, scope: Scope): boolean {
  if (node.left.kind === 'regex' || node.right.kind === 'regex') {
    return false;
  }
  const left = evaluateNode(node.left, scope);
  const right = evaluateNode(node.right, scope);
  if (!left.present || !right.present) {
    return !left.present && !right.present;
  }
  return equalValues(left.value, right.value);
}

function comparison(node: CompareNode, scope: Scope): boolean {
  switch (node.operator) {
    case 'matches':
      return matches(node, scope);
    case '==':
      return equality(node, scope);
    case '!=':
      return !equality(node, scope);
    default: {
      const left = evaluateNode(node.left, scope);
      if (!left.present) {
        return false;
      }
      const right = evaluateNode(node.right, scope);
      return right.present && relate(node.operator, left.value, right.value);
    }
  }
}

function logical(node: LogicalNode, scope: Scope): boolean {
  if (node.left.kind !== 'logical') {
    const left = truthy(node.left, scope);
    return node.operator === '&&'
      ? left && truthy(node.right, scope)
      : left || truthy(node.right, scope);
  }
  const spine: LogicalNode[] = [];
  let leftmost: Expr = node;
  while (leftmost.kind === 'logical') {
    spine.push(leftmost);
    leftmost = leftmost.left;
  }
  let result = truthy(leftmost, scope);
  for (let index = spine.length - 1; index >= 0; index -= 1) {
    const link = spine[index] as LogicalNode;
    result =
      link.operator === '&&'
        ? result && truthy(link.right, scope)
        : result || truthy(link.right, scope);
  }
  return result;
}

function truthy(node: Expr, scope: Scope): boolean {
  switch (node.kind) {
    case 'not':
      return !truthy(node.operand, scope);
    case 'logical':
      return logical(node, scope);
    case 'compare':
      return comparison(node, scope);
    default: {
      const outcome = evaluateNode(node, scope);
      return (
        outcome.present &&
        outcome.value !== false &&
        outcome.value !== null &&
        !(isList(outcome.value) && outcome.value.length === 0)
      );
    }
  }
}

function filterWhere(list: readonly Value[], condition: Expr, scope: Scope): Value[] {
  const inner: Scope = { sources: scope.sources, sse: scope.sse, explain: false, item: undefined };
  const kept: Value[] = [];
  for (const element of list) {
    inner.item = element;
    if (truthy(condition, inner)) {
      kept.push(element);
    }
  }
  return kept;
}

function mapName(walk: Walk, step: NameStep, path: string, scope: Scope): void {
  const items = walk.value as readonly Value[];
  const names: Value[] = [];
  for (let position = 0; position < items.length; position += 1) {
    const item = items[position] as Value;
    const next = readName(item, step.name);
    if (next === undefined) {
      walk.missing = scope.explain
        ? stepFailure(item, step, path, ` in result ${String(position + 1)}`)
        : silent;
      return;
    }
    names.push(next);
  }
  walk.value = names;
  walk.path = path;
}

function applyStep(walk: Walk, step: Step, scope: Scope): void {
  const path = scope.explain ? appendStep(walk.path, step) : '';
  if (step.kind === 'name' && walk.fanned) {
    mapName(walk, step, path, scope);
    return;
  }
  let next: Value | undefined;
  switch (step.kind) {
    case 'name':
      next = readName(walk.value, step.name);
      break;
    case 'index':
      next = readIndex(walk.value, step.index);
      break;
    case 'wildcard':
      next = isList(walk.value) ? walk.value : undefined;
      break;
    case 'where':
      next = isList(walk.value) ? filterWhere(walk.value, step.condition, scope) : undefined;
      break;
  }
  if (next === undefined) {
    walk.missing = scope.explain ? stepFailure(walk.value, step, path, '') : silent;
    return;
  }
  walk.value = next;
  walk.path = path;
  walk.fanned = step.kind === 'wildcard' || step.kind === 'where';
}

function joinText(items: readonly Value[], separator: string): string | undefined {
  const parts: string[] = [];
  let length = 0;
  for (const item of items) {
    if (parts.length > 0) {
      length += separator.length;
    }
    if (length > maxInsertedLength) {
      return undefined;
    }
    const text = insertText(item, maxInsertedLength - length);
    if (!text.ok) {
      return undefined;
    }
    length += text.text.length;
    parts.push(text.text);
  }
  return parts.join(separator);
}

function lose(walk: Walk, scope: Scope, reason: () => string): void {
  walk.missing = scope.explain ? absent(reason()) : silent;
}

function applyFilter(walk: Walk, filter: Filter, scope: Scope): void {
  walk.fanned = false;
  if (filter.kind === 'default') {
    if (walk.missing !== undefined) {
      walk.missing = undefined;
      walk.value = filter.value;
      walk.path = '';
      walk.event = undefined;
    }
    return;
  }
  if (walk.missing !== undefined) {
    return;
  }
  const { value, path } = walk;
  switch (filter.kind) {
    case 'join': {
      if (!isList(value)) {
        lose(walk, scope, () => noValue(path, `join needs a list, not ${kindOf(value)}`));
        return;
      }
      const joined = joinText(value, filter.separator);
      if (joined === undefined) {
        lose(walk, scope, () => valueTooLarge);
      } else {
        walk.value = joined;
      }
      return;
    }
    case 'json': {
      const json = compactJson(value, maxInsertedLength);
      if (json.ok) {
        walk.value = json.text;
      } else {
        lose(walk, scope, () => valueTooLarge);
      }
      return;
    }
    case 'match': {
      if (typeof value !== 'string') {
        lose(walk, scope, () => noValue(path, `match needs a string, not ${kindOf(value)}`));
        return;
      }
      const compiled = compiledPattern(filter, filter.pattern, filter.flags);
      if (!compiled.ok) {
        lose(walk, scope, () =>
          noValue(path, `the regular expression is not valid: ${compiled.message}`),
        );
        return;
      }
      const found = compiled.pattern.firstMatch(value);
      if (found === 'too-long') {
        lose(walk, scope, () => textTooLong);
      } else if (found === undefined) {
        lose(walk, scope, () =>
          noValue(path, `the text does not match /${filter.pattern}/${filter.flags}`),
        );
      } else {
        walk.value = found.group ?? found.match;
      }
      return;
    }
  }
}

function evaluateChain(node: ChainNode, scope: Scope): Outcome {
  const links: ChainNode[] = [];
  let root: Expr = node;
  while (root.kind === 'access' || root.kind === 'filter') {
    links.push(root);
    root = root.target;
  }
  const start = evaluateNode(root, scope);
  if (!start.present && !links.some((link) => link.kind === 'filter')) {
    return start;
  }
  const walk: Walk = start.present
    ? {
        value: start.value,
        path: start.path,
        event: start.event,
        fanned: root.kind === 'events' && root.name === 'all' && isList(start.value),
        missing: undefined,
      }
    : { value: null, path: '', event: undefined, fanned: false, missing: start };
  for (let index = links.length - 1; index >= 0; index -= 1) {
    const link = links[index] as ChainNode;
    if (link.kind === 'filter') {
      applyFilter(walk, link.filter, scope);
    } else if (walk.missing === undefined) {
      applyStep(walk, link.step, scope);
    }
  }
  return walk.missing ?? present(walk.value, walk.path, walk.event);
}

function evaluateNode(node: Expr, scope: Scope): Outcome {
  switch (node.kind) {
    case 'source':
    case 'events':
    case 'nth':
    case 'jsonpath':
    case 'check':
      return scope.sources.value(node);
    case 'literal':
      return present(node.value);
    case 'list': {
      const items: Value[] = [];
      for (const element of node.items) {
        const outcome = evaluateNode(element, scope);
        if (!outcome.present) {
          return outcome;
        }
        items.push(outcome.value);
      }
      return present(items);
    }
    case 'regex':
      return absent(noValue('', 'a regular expression is not a value'));
    case 'field': {
      const { item } = scope;
      if (item === undefined) {
        return absent(noValue(node.name, 'there is no item to read it from'));
      }
      const value = readName(item, node.name);
      if (value !== undefined) {
        return present(value, scope.explain ? appendName('', node.name) : '');
      }
      return scope.explain
        ? stepFailure(item, { kind: 'name', name: node.name }, appendName('', node.name), '')
        : silent;
    }
    case 'item':
      return scope.item === undefined
        ? absent(noValue('@', 'there is no item to read'))
        : present(scope.item);
    case 'sse':
      if (scope.sse !== undefined) {
        return present(sseValue(scope.sse));
      }
      return scope.explain ? absent(noValue('@sse', 'the event has no SSE fields')) : silent;
    case 'access':
    case 'filter':
      return evaluateChain(node, scope);
    case 'not':
    case 'logical':
    case 'compare':
      return truthy(node, scope) ? yes : no;
  }
}

export function evaluate(expr: Expr, sources: Sources): Outcome {
  return evaluateNode(expr, { sources, sse: undefined, explain: true, item: undefined });
}

export function holds(condition: Expr, item: ConditionItem): boolean {
  if (item.malformed) {
    return false;
  }
  return truthy(condition, {
    sources: unreadable,
    sse: item.sse,
    explain: false,
    item: item.value,
  });
}
