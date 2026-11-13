import type { Value } from './ast';
import { isList, isObject } from './value';
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

export function equalValues(left: Value, right: Value, budget?: WorkBudget): boolean {
  if (isPrimitive(left) || isPrimitive(right)) {
    budget?.spend(primitiveUnits(left, right));
    return (
      left === right || (isNumeric(left) && isNumeric(right) && compareNumeric(left, right) === 0)
    );
  }
  const lefts: Value[] = [left];
  const rights: Value[] = [right];
  while (lefts.length > 0) {
    const a = lefts.pop() as Value;
    const b = rights.pop() as Value;
    budget?.spend(primitiveUnits(a, b));
    if (a === b) {
      continue;
    }
    if (isList(a)) {
      if (!isList(b) || a.length !== b.length) {
        return false;
      }
      for (let index = 0; index < a.length; index += 1) {
        lefts.push(a[index] as Value);
        rights.push(b[index] as Value);
      }
    } else if (isObject(a)) {
      if (!isObject(b)) {
        return false;
      }
      const keys = keysOf(a, budget);
      if (keys.length !== keysOf(b, budget).length) {
        return false;
      }
      for (const key of keys) {
        if (!Object.hasOwn(b, key)) {
          return false;
        }
        lefts.push(a[key] as Value);
        rights.push(b[key] as Value);
      }
    } else if (!isNumeric(a) || !isNumeric(b) || compareNumeric(a, b) !== 0) {
      return false;
    }
  }
  return true;
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
