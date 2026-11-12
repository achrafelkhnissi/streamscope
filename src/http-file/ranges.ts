import type { Range } from './model';

export function span(line: number, start: number, end: number): Range {
  return { start: { line, character: start }, end: { line, character: end } };
}
