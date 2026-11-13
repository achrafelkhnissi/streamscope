import type { Value } from './ast';
import { isList, isObject } from './value';

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

export function equalValues(left: Value, right: Value): boolean {
  const lefts: Value[] = [left];
  const rights: Value[] = [right];
  while (lefts.length > 0) {
    const a = lefts.pop() as Value;
    const b = rights.pop() as Value;
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
      const keys = Object.keys(a);
      if (keys.length !== Object.keys(b).length) {
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

export function compareValues(left: Value, right: Value): -1 | 0 | 1 | undefined {
  if (isNumeric(left)) {
    return isNumeric(right) ? compareNumeric(left, right) : undefined;
  }
  if (typeof left === 'string') {
    if (typeof right !== 'string') {
      return undefined;
    }
    if (left < right) {
      return -1;
    }
    return left > right ? 1 : 0;
  }
  return equalValues(left, right) ? 0 : undefined;
}
