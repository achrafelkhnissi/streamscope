import type { CompareOperator, Expr, Filter, ListItem, SourceNode, Step, Value } from './ast';
import { compareValues, equalValues } from './compare';
import { compactJson, insertText, maxInsertedLength, valueTooLargeReason } from './insert';
import { compilePattern, type CompileResult } from './regex';
import { isList, isObject } from './value';
import { keysOf, outOfWork, textUnits, type WorkBudget } from './work';

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

export interface EvaluateOptions {
  budget?: WorkBudget;
}

type Present = Extract<Outcome, { present: true }>;
type Absent = Extract<Outcome, { present: false }>;
type ChainNode = Extract<Expr, { kind: 'access' | 'filter' }>;
type LogicalNode = Extract<Expr, { kind: 'logical' }>;
type CompareNode = Extract<Expr, { kind: 'compare' }>;
type IndexStep = Extract<Step, { kind: 'index' }>;
type ListNode = Extract<ListItem, { kind: 'list' }>;

interface Scope {
  readonly sources: Sources;
  readonly sse: ConditionItem['sse'];
  readonly explain: boolean;
  readonly budget: WorkBudget | undefined;
  item: Value | undefined;
}

interface Walk {
  value: Value;
  path: string;
  event: number | undefined;
  fanned: boolean;
  missing: Absent | undefined;
}

export const textTooLongReason = 'the text is too long for this regular expression';

const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const silent: Absent = Object.freeze({ present: false, reason: '' });
const yes: Present = Object.freeze({ present: true, value: true, path: '' });
const no: Present = Object.freeze({ present: true, value: false, path: '' });
const unreadable: Sources = { value: () => silent };
const patterns = new WeakMap<object, CompileResult>();
const constantLists = new WeakMap<object, Value>();
const textWindow = 65_536;

function spend(scope: Scope, units: number): void {
  scope.budget?.spend(units);
}

function listValue(node: ListNode, scope: Scope): Value {
  const built = constantLists.get(node);
  if (built !== undefined) {
    return built;
  }
  const items: Value[] = [];
  for (const element of node.items) {
    spend(scope, 1);
    items.push(element.kind === 'literal' ? element.value : listValue(element, scope));
  }
  constantLists.set(node, items);
  return items;
}

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

function members(input: Value, scope: Scope): readonly Value[] | undefined {
  if (isList(input)) {
    spend(scope, input.length);
    return input;
  }
  if (!isObject(input)) {
    return undefined;
  }
  const keys = keysOf(input, scope.budget);
  spend(scope, keys.length);
  const values: Value[] = [];
  for (const key of keys) {
    values.push(input[key] as Value);
  }
  return values;
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
  } else if (step.kind !== 'index') {
    detail = `the value is ${kindOf(input)}, not a list or an object`;
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

function containsText(text: string, part: string, scope: Scope): boolean {
  if (part.length > text.length) {
    return false;
  }
  const window = Math.max(textWindow, part.length);
  if (text.length <= window) {
    spend(scope, textUnits(text.length));
    return text.includes(part);
  }
  for (let start = 0; start < text.length; start += window) {
    const end = Math.min(text.length, start + window + part.length - 1);
    spend(scope, textUnits(end - start));
    if (text.slice(start, end).includes(part)) {
      return true;
    }
    if (end === text.length) {
      return false;
    }
  }
  return false;
}

function relate(
  operator: Exclude<CompareOperator, 'matches' | '==' | '!='>,
  left: Value,
  right: Value,
  scope: Scope,
): boolean {
  const { budget } = scope;
  switch (operator) {
    case '<':
      return compareValues(left, right, budget) === -1;
    case '>':
      return compareValues(left, right, budget) === 1;
    case '<=': {
      const order = compareValues(left, right, budget);
      return order === -1 || order === 0;
    }
    case '>=': {
      const order = compareValues(left, right, budget);
      return order === 1 || order === 0;
    }
    case 'in':
      return isList(right) && right.some((element) => equalValues(left, element, budget));
    case 'contains':
      if (typeof left === 'string') {
        return typeof right === 'string' && containsText(left, right, scope);
      }
      return isList(left) && left.some((element) => equalValues(element, right, budget));
    case 'startsWith':
      if (typeof left !== 'string' || typeof right !== 'string') {
        return false;
      }
      spend(scope, textUnits(Math.min(left.length, right.length)));
      return left.startsWith(right);
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
  if (!compiled.ok) {
    return false;
  }
  spend(scope, compiled.pattern.work(left.value));
  return compiled.pattern.test(left.value) === true;
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
  return equalValues(left.value, right.value, scope.budget);
}

function comparison(node: CompareNode, scope: Scope): boolean {
  spend(scope, 1);
  switch (node.operator) {
    case 'matches':
      return matches(node, scope);
    case '==':
      return equality(node, scope);
    case '!=':
      return !equality(node, scope);
    default: {
      if (node.left.kind === 'regex' || node.right.kind === 'regex') {
        return false;
      }
      const left = evaluateNode(node.left, scope);
      const right = evaluateNode(node.right, scope);
      if (!left.present || !right.present) {
        return (
          !left.present && !right.present && (node.operator === '<=' || node.operator === '>=')
        );
      }
      return relate(node.operator, left.value, right.value, scope);
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
  spend(scope, spine.length);
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
  const inner: Scope = {
    sources: scope.sources,
    sse: scope.sse,
    explain: false,
    budget: scope.budget,
    item: undefined,
  };
  const kept: Value[] = [];
  for (const element of list) {
    spend(scope, 1);
    inner.item = element;
    if (truthy(condition, inner)) {
      kept.push(element);
    }
  }
  return kept;
}

function mapStep(walk: Walk, step: Exclude<Step, IndexStep>, path: string, scope: Scope): void {
  const items = walk.value as readonly Value[];
  const mapped: Value[] = [];
  for (let position = 0; position < items.length; position += 1) {
    spend(scope, 1);
    const item = items[position] as Value;
    if (step.kind === 'name') {
      const next = readName(item, step.name);
      if (next !== undefined) {
        mapped.push(next);
        continue;
      }
    } else {
      const children = members(item, scope);
      if (children !== undefined) {
        const kept =
          step.kind === 'wildcard' ? children : filterWhere(children, step.condition, scope);
        spend(scope, kept.length);
        for (const element of kept) {
          mapped.push(element);
        }
        continue;
      }
    }
    walk.missing = scope.explain
      ? stepFailure(item, step, path, ` in result ${String(position + 1)}`)
      : silent;
    return;
  }
  walk.value = mapped;
  walk.path = path;
}

function applyStep(walk: Walk, step: Step, scope: Scope): void {
  const path = scope.explain ? appendStep(walk.path, step) : '';
  if (walk.fanned && step.kind !== 'index') {
    mapStep(walk, step, path, scope);
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
      next = members(walk.value, scope);
      break;
    case 'where': {
      const children = members(walk.value, scope);
      next = children === undefined ? undefined : filterWhere(children, step.condition, scope);
      break;
    }
  }
  if (next === undefined) {
    walk.missing = scope.explain ? stepFailure(walk.value, step, path, '') : silent;
    return;
  }
  walk.value = next;
  walk.path = path;
  walk.fanned = step.kind === 'wildcard' || step.kind === 'where';
}

function joinText(items: readonly Value[], separator: string, scope: Scope): string | undefined {
  const parts: string[] = [];
  let length = 0;
  for (const item of items) {
    spend(scope, 1);
    if (parts.length > 0) {
      length += separator.length;
    }
    if (length > maxInsertedLength) {
      return undefined;
    }
    const text = insertText(item, maxInsertedLength - length, scope.budget);
    if (!text.ok) {
      return undefined;
    }
    length += text.text.length;
    parts.push(text.text);
  }
  spend(scope, textUnits(length));
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
      const joined = joinText(value, filter.separator, scope);
      if (joined === undefined) {
        lose(walk, scope, () => valueTooLargeReason);
      } else {
        walk.value = joined;
      }
      return;
    }
    case 'json': {
      const json = compactJson(value, maxInsertedLength, scope.budget);
      if (json.ok) {
        walk.value = json.text;
      } else {
        lose(walk, scope, () => valueTooLargeReason);
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
      spend(scope, compiled.pattern.work(value));
      const found = compiled.pattern.firstMatch(value);
      if (found === 'too-long') {
        lose(walk, scope, () => textTooLongReason);
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
  spend(scope, links.length);
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
  const headers = root.kind === 'source' && root.name === 'headers';
  for (let index = links.length - 1; index >= 0; index -= 1) {
    const link = links[index] as ChainNode;
    if (link.kind === 'filter') {
      applyFilter(walk, link.filter, scope);
    } else if (walk.missing === undefined) {
      const { step } = link;
      applyStep(
        walk,
        headers && index === links.length - 1 && step.kind === 'name'
          ? { kind: 'name', name: step.name.toLowerCase() }
          : step,
        scope,
      );
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
    case 'list':
      return present(listValue(node, scope));
    case 'regex':
      return absent(noValue('', 'a regular expression is not a value'));
    case 'field': {
      spend(scope, 1);
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

export function evaluate(expr: Expr, sources: Sources, options: EvaluateOptions = {}): Outcome {
  try {
    return evaluateNode(expr, {
      sources,
      sse: undefined,
      explain: true,
      budget: options.budget,
      item: undefined,
    });
  } catch (error) {
    if (error === outOfWork && options.budget !== undefined) {
      return absent(options.budget.reason);
    }
    throw error;
  }
}

export function holds(
  condition: Expr,
  item: ConditionItem,
  options: EvaluateOptions = {},
): boolean {
  if (item.malformed) {
    return false;
  }
  try {
    return truthy(condition, {
      sources: unreadable,
      sse: item.sse,
      explain: false,
      budget: options.budget,
      item: item.value,
    });
  } catch (error) {
    if (error === outOfWork) {
      return false;
    }
    throw error;
  }
}
