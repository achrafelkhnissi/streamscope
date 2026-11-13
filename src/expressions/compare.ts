import type { Value } from './ast';
import { isList, isObject, type ValueObject } from './value';
import { keysOf, textUnits, type WorkBudget } from './work';

function isNumeric(value: Value): value is number | bigint {
  return typeof value === 'number' || typeof value === 'bigint';
}

function compareNumeric(left: number | bigint, right: number | bigint): -1 | 0 | 1 | undefined {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return Number.isNaN(left) || Number.isNaN(right) ? undefined : 0;
}

function isPrimitive(value: Value): boolean {
  return typeof value !== 'object' || value === null;
}

function primitiveUnits(left: Value, right: Value): number {
  return typeof left === 'string' && typeof right === 'string'
    ? 1 + textUnits(Math.min(left.length, right.length))
    : 1;
}

type Walk =
  | { left: readonly Value[]; right: readonly Value[]; keys: undefined; at: number }
  | { left: ValueObject; right: ValueObject; keys: readonly string[]; at: number };

function opened(left: Value, right: Value, budget: WorkBudget | undefined): Walk | boolean {
  if (isList(left)) {
    return isList(right) && left.length === right.length
      ? { left, right, keys: undefined, at: 0 }
      : false;
  }
  if (isObject(left)) {
    if (!isObject(right)) {
      return false;
    }
    const keys = keysOf(left, budget);
    return keys.length === keysOf(right, budget).length ? { left, right, keys, at: 0 } : false;
  }
  return isNumeric(left) && isNumeric(right) && compareNumeric(left, right) === 0;
}

export function equalValues(left: Value, right: Value, budget?: WorkBudget): boolean {
  if (isPrimitive(left) || isPrimitive(right)) {
    budget?.spend(primitiveUnits(left, right));
    return (
      left === right || (isNumeric(left) && isNumeric(right) && compareNumeric(left, right) === 0)
    );
  }
  const walks: Walk[] = [];
  let a = left;
  let b = right;
  for (;;) {
    budget?.spend(primitiveUnits(a, b));
    if (a !== b) {
      const walk = opened(a, b, budget);
      if (walk === false) {
        return false;
      }
      if (walk !== true) {
        walks.push(walk);
      }
    }
    let top = walks.at(-1);
    while (top !== undefined && top.at === (top.keys ?? top.left).length) {
      walks.pop();
      top = walks.at(-1);
    }
    if (top === undefined) {
      return true;
    }
    if (top.keys === undefined) {
      a = top.left[top.at] as Value;
      b = top.right[top.at] as Value;
    } else {
      const key = top.keys[top.at] as string;
      if (!Object.hasOwn(top.right, key)) {
        return false;
      }
      a = top.left[key] as Value;
      b = top.right[key] as Value;
    }
    top.at += 1;
  }
}

export function compareValues(
  left: Value,
  right: Value,
  budget?: WorkBudget,
): -1 | 0 | 1 | undefined {
  if (isNumeric(left)) {
    return isNumeric(right) ? compareNumeric(left, right) : undefined;
  }
  if (typeof left === 'string') {
    if (typeof right !== 'string') {
      return undefined;
    }
    budget?.spend(primitiveUnits(left, right));
    if (left < right) {
      return -1;
    }
    return left > right ? 1 : 0;
  }
  return equalValues(left, right, budget) ? 0 : undefined;
}
