import { describe, expect, it } from 'vitest';
import { canonicalKey } from '../../../src/checks/canonical';
import { compileCheck, type CheckProgram } from '../../../src/checks/compile';
import { verdictOf, type TermState, type Verdict } from '../../../src/checks/verdict';
import type { Value } from '../../../src/expressions/ast';
import { parseExpression } from '../../../src/expressions/parse';

function program(text: string): CheckProgram {
  const parsed = parseExpression(text, 'expect');
  if (!parsed.ok) {
    throw new Error(`${text}: ${parsed.error.message}`);
  }
  return compileCheck(parsed.expr, text);
}

function verdict(text: string, states: Record<string, TermState>): Verdict {
  const compiled = program(text);
  const byId = new Map<number, TermState>();
  for (const term of compiled.terms) {
    byId.set(term.id, states[term.text] ?? { kind: 'pending' });
  }
  return verdictOf(compiled, byId);
}

const value = (v: Value): TermState => ({ kind: 'value', value: v });
const missing = (reason: string): TermState => ({ kind: 'missing', reason });
const counted = (count: number, final = false): TermState => ({ kind: 'count', count, final });
const passed: Verdict = { state: 'passed' };
const pending: Verdict = { state: 'pending' };

describe('verdictOf', () => {
  it('follows Kleene logic for &&, || and !', () => {
    const states = (a: TermState, b: TermState) => ({
      'first(type == "A").ok': a,
      'first(type == "B").ok': b,
    });
    const T = value(true);
    const F = value(false);
    const U: TermState = { kind: 'pending' };
    const and = 'first(type == "A").ok && first(type == "B").ok';
    const or = 'first(type == "A").ok || first(type == "B").ok';
    const expected: [TermState, TermState, Verdict['state'], Verdict['state']][] = [
      [T, T, 'passed', 'passed'],
      [T, F, 'failed', 'passed'],
      [T, U, 'pending', 'passed'],
      [F, T, 'failed', 'passed'],
      [F, F, 'failed', 'failed'],
      [F, U, 'failed', 'pending'],
      [U, T, 'pending', 'passed'],
      [U, F, 'failed', 'pending'],
      [U, U, 'pending', 'pending'],
    ];
    for (const [a, b, andState, orState] of expected) {
      expect(verdict(and, states(a, b)).state, `${a.kind} && ${b.kind}`).toBe(andState);
      expect(verdict(or, states(a, b)).state, `${a.kind} || ${b.kind}`).toBe(orState);
    }
    expect(verdict('!first(type == "A").ok', { 'first(type == "A").ok': T }).state).toBe('failed');
    expect(verdict('!first(type == "A").ok', { 'first(type == "A").ok': F })).toEqual(passed);
    expect(verdict('!first(type == "A").ok', { 'first(type == "A").ok': U })).toEqual(pending);
    expect(
      verdict('!exists(first(type == "E"))', { 'first(type == "E")': value({ type: 'E' }) }),
    ).toEqual({
      state: 'failed',
      detail: 'first(type == "E") is {"type":"E"}',
    });
    expect(
      verdict('first(type == "A").items', { 'first(type == "A").items': value([]) }).state,
    ).toBe('failed');
  });

  it('decides count comparisons from the running count', () => {
    const c = 'count(type == "A")';
    const table: [string, number, Verdict['state']][] = [
      [`${c} > 2`, 2, 'pending'],
      [`${c} > 2`, 3, 'passed'],
      [`${c} >= 2`, 2, 'passed'],
      [`${c} < 2`, 1, 'pending'],
      [`${c} < 2`, 2, 'failed'],
      [`${c} <= 2`, 2, 'pending'],
      [`${c} <= 2`, 3, 'failed'],
      [`${c} == 2`, 2, 'pending'],
      [`${c} == 2`, 3, 'failed'],
      [`${c} != 2`, 2, 'pending'],
      [`${c} != 2`, 3, 'passed'],
      [`2 < ${c}`, 3, 'passed'],
      [`2 >= ${c}`, 3, 'failed'],
      [`${c} > -1`, 0, 'passed'],
      [`${c} > 2.5`, 3, 'passed'],
      [`${c} > 2.5`, 2, 'pending'],
      [`${c} < 12345678901234567890`, 5, 'pending'],
    ];
    for (const [text, count, state] of table) {
      expect(verdict(text, { [c]: counted(count) }).state, `${text} at ${String(count)}`).toBe(
        state,
      );
    }
    expect(verdict(`${c} == 2`, { [c]: counted(2, true) })).toEqual(passed);
    expect(verdict(`${c} <= 2`, { [c]: counted(3) })).toEqual({
      state: 'failed',
      detail: 'count(type == "A") reached 3',
    });
    expect(verdict(`${c} == 2`, { [c]: counted(1, true) })).toEqual({
      state: 'failed',
      detail: 'got 1',
    });
  });

  it('waits for the end for a count compared with a non-literal', () => {
    const text = 'count(type == "A") == count(type == "B")';
    expect(verdict(text, { 'count(type == "A")': value(5) })).toEqual(pending);
    expect(
      verdict(text, { 'count(type == "A")': value(5), 'count(type == "B")': value(5) }),
    ).toEqual(passed);
    expect(
      verdict(text, { 'count(type == "A")': value(5), 'count(type == "B")': value(4) }),
    ).toEqual({
      state: 'failed',
      detail: 'count(type == "A") is 5, count(type == "B") is 4',
    });
  });

  it('decides before from the first matching events', () => {
    const text = 'before(type == "A", type == "B")';
    const before = (first: number | undefined, second: number | undefined, final = false) => ({
      [text]: { kind: 'before' as const, first, second, final },
    });
    expect(verdict(text, before(3, undefined))).toEqual(passed);
    expect(verdict(text, before(3, 7))).toEqual(passed);
    expect(verdict(text, before(undefined, undefined))).toEqual(pending);
    expect(verdict(text, before(undefined, 2))).toEqual({
      state: 'failed',
      detail: 'type == "B" matched event 2 first',
    });
    expect(verdict(text, before(4, 4))).toEqual({
      state: 'failed',
      detail: 'type == "A" and type == "B" matched the same event 4',
    });
    expect(verdict(text, before(undefined, undefined, true))).toEqual({
      state: 'failed',
      detail: 'no event matched type == "A"',
    });
  });

  it('fails a comparison with a missing operand, naming it', () => {
    expect(
      verdict('first(type == "A").id == 1', {
        'first(type == "A").id': missing('no event matched type == "A"'),
      }),
    ).toEqual({
      state: 'failed',
      detail: 'first(type == "A").id is missing: no event matched type == "A"',
    });
    expect(verdict('exists(body.id)', { 'body.id': missing('has no value at body.id') })).toEqual({
      state: 'failed',
      detail: 'body.id is missing: has no value at body.id',
    });
  });

  it('fails unique on equal values, including objects with keys in another order and equal big integers', () => {
    const text = 'unique(all(type == "A").id)';
    const term = 'all(type == "A").id';
    expect(verdict(text, { [term]: value([1, 2, 3]) })).toEqual(passed);
    expect(verdict(text, { [term]: value([1, { a: 1, b: 2 }, { b: 2, a: 1 }]) })).toEqual({
      state: 'failed',
      detail: '{"b":2,"a":1} appears more than once',
    });
    expect(verdict(text, { [term]: value([1e21, 1000000000000000000000n]) }).state).toBe('failed');
    expect(verdict(text, { [term]: value(['1', 1]) })).toEqual(passed);
    expect(verdict(text, { [term]: value('x') })).toEqual({
      state: 'failed',
      detail: 'all(type == "A").id is "x", not a list',
    });
    expect(canonicalKey({ b: [1, 2n], a: null })).toBe(canonicalKey({ a: null, b: [1n, 2] }));
  });

  it('writes the expected and actual values', () => {
    expect(verdict('status == 201', { status: value(500) })).toEqual({
      state: 'failed',
      detail: 'got 500',
    });
    expect(verdict('201 == status', { status: value(500) })).toEqual({
      state: 'failed',
      detail: 'got 500',
    });
    expect(
      verdict('status == body.status', { status: value(200), 'body.status': value(201) }),
    ).toEqual({
      state: 'failed',
      detail: 'status is 200, body.status is 201',
    });
    expect(
      verdict('status == 200 && text contains "x"', { status: value(500), text: value('y') }),
    ).toEqual({ state: 'failed', detail: 'got 500' });
    expect(verdict('status == 200 || status == 201', { status: value(500) })).toEqual({
      state: 'failed',
      detail: 'got 500; got 500',
    });
    expect(verdict('text matches /hel+o/i', { text: value('HELLO there') })).toEqual(passed);
    expect(verdict('headers["x"] contains "y"', { 'headers["x"]': value('xyz') })).toEqual(passed);
    expect(verdict('status in [200, 201]', { status: value(201) })).toEqual(passed);
  });

  it('cuts each value in a detail to 200 characters', () => {
    const long = 'x'.repeat(500);
    const result = verdict('body.name == "y"', { 'body.name': value(long) });
    expect(result.state).toBe('failed');
    expect(result.state === 'failed' ? result.detail : '').toBe(`got "${'x'.repeat(198)}…`);
  });
});
