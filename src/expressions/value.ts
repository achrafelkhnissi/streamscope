import type { Value } from './ast';

export type ValueObject = { readonly [key: string]: Value };

export function isList(value: Value): value is readonly Value[] {
  return Array.isArray(value);
}

export function isObject(value: Value): value is ValueObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
