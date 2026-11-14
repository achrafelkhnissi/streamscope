import { describe, expect, it } from 'vitest';
import { compileCheck, type CheckProgram } from '../../../src/checks/compile';
import { parseExpression } from '../../../src/expressions/parse';

function program(text: string): CheckProgram {
  const parsed = parseExpression(text, 'expect');
  if (!parsed.ok) {
    throw new Error(`${text}: ${parsed.error.message}`);
  }
  return compileCheck(parsed.expr, text);
}

function terms(text: string): [string, string][] {
  return program(text).terms.map((term) => [term.kind, term.text]);
}

describe('compileCheck', () => {
  it('splits logic and comparisons from value terms', () => {
    expect(terms('status == 200 && count(type == "A") > 2')).toEqual([
      ['value', 'status'],
      ['count', 'count(type == "A")'],
    ]);
    expect(terms('!exists(first(type == "RUN_ERROR")) || headers["x"] contains "y"')).toEqual([
      ['count', 'count(type == "RUN_ERROR")'],
      ['value', 'headers["x"]'],
    ]);
    expect(terms('unique(all(type == "A").id)')).toEqual([['value', 'all(type == "A").id']]);
    expect(terms('first(type == "A").ok')).toEqual([['value', 'first(type == "A").ok']]);
    expect(terms('text matches /hello/i')).toEqual([['value', 'text']]);
    expect(terms('2 <= count()')).toEqual([['count', 'count()']]);
  });

  it('keeps a count compared with a non-literal inside a value term', () => {
    expect(terms('count(type == "A") == count(type == "B")')).toEqual([
      ['value', 'count(type == "A")'],
      ['value', 'count(type == "B")'],
    ]);
    expect(terms('count(type == "A") == "3"')).toEqual([['value', 'count(type == "A")']]);
  });

  it('makes a before term of each before(…)', () => {
    const compiled = program(
      'before(type == "A", type == "B") && before(type == "B", type == "C")',
    );

    expect(compiled.terms.map((term) => [term.kind, term.text])).toEqual([
      ['before', 'before(type == "A", type == "B")'],
      ['before', 'before(type == "B", type == "C")'],
    ]);
    expect(compiled.terms[0]?.kind === 'before' ? compiled.terms[0].firstText : undefined).toBe(
      'type == "A"',
    );
  });

  it('gives identical terms of one check one id', () => {
    expect(terms('status >= 200 && status < 300')).toEqual([['value', 'status']]);
  });
});

describe('compileCheck after the review', () => {
  it('turns exists of a first, last or nth event into a count term', () => {
    expect(terms('!exists(first(type == "RUN_ERROR"))')).toEqual([
      ['count', 'count(type == "RUN_ERROR")'],
    ]);
    expect(terms('exists(nth(3, type == "A")) && exists(last())')).toEqual([
      ['count', 'count(type == "A")'],
      ['count', 'count()'],
    ]);
    expect(terms('exists(first(type == "A").id)')).toEqual([['value', 'first(type == "A").id']]);
  });

  it('marks a value term that uses a check function outside logic', () => {
    const compiled = program('exists(body.id) == 1');
    expect(
      compiled.terms.map((term) => [term.text, term.kind === 'value' ? term.problem : undefined]),
    ).toEqual([
      [
        'exists(body.id)',
        'exists(…), before(…) and unique(…) can only be combined with &&, || and !, or compared with true or false',
      ],
    ]);
  });
});
