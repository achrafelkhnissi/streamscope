import { describe, expect, it, vi } from 'vitest';
import type { Expr, Value } from '../../../src/expressions/ast';
import {
  evaluate,
  holds,
  textTooLongReason,
  type ConditionItem,
  type Outcome,
  type Sources,
} from '../../../src/expressions/evaluate';
import { valueTooLargeReason } from '../../../src/expressions/insert';
import { parseExpression, type ExpressionContext } from '../../../src/expressions/parse';
import * as regex from '../../../src/expressions/regex';
import { WorkBudget } from '../../../src/expressions/work';

vi.mock('../../../src/expressions/regex', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/expressions/regex')>();
  return { ...original, compilePattern: vi.fn(original.compilePattern) };
});

const tooLong = 'the text is too long for this regular expression';
const tooLarge = 'the value is larger than 1 MiB';

function parse(text: string, context: ExpressionContext = 'capture'): Expr {
  const result = parseExpression(text, context);
  if (!result.ok) {
    throw new Error(
      `${text} failed: ${result.error.message} at ${JSON.stringify(result.error.span)}`,
    );
  }
  return result.expr;
}

function found(value: Value, event?: number): Outcome {
  return event === undefined
    ? { present: true, value, path: '' }
    : { present: true, value, path: '', event };
}

function sourcesWith(answers: Record<string, Outcome>): Sources {
  return {
    value(node) {
      const key =
        node.kind === 'source' || node.kind === 'events' || node.kind === 'check'
          ? node.name
          : node.kind;
      return answers[key] ?? { present: false, reason: `no ${key}` };
    },
  };
}

function run(text: string, answers: Record<string, Outcome> = {}): Outcome {
  return evaluate(parse(text), sourcesWith(answers));
}

function bodyOf(value: Value): Record<string, Outcome> {
  return { body: found(value) };
}

function item(value: Value, extra: Partial<ConditionItem> = {}): ConditionItem {
  return { value, sse: undefined, malformed: false, ...extra };
}

function holdsFor(text: string, value: Value, extra: Partial<ConditionItem> = {}): boolean {
  return holds(parse(text, 'condition'), item(value, extra));
}

function nested(depth: number, leaf: Value): Value {
  let value = leaf;
  for (let level = 0; level < depth; level += 1) {
    value = { next: value };
  }
  return value;
}

function nestedLists(depth: number, leaf: Value): Value {
  let value = leaf;
  for (let level = 0; level < depth; level += 1) {
    value = [value];
  }
  return value;
}

function presentValue(outcome: Outcome): Value {
  if (!outcome.present) {
    throw new Error(`missing: ${outcome.reason}`);
  }
  return outcome.value;
}

const catalog = {
  items: [
    { id: 1, price: 5, tags: ['a', 'b'] },
    { id: 2, price: 15, tags: ['c'] },
    { id: 3, price: 25, tags: [] },
  ],
  user: { name: 'Ada' },
  tags: ['alpha', 'beta', 'gamma'],
};

describe('evaluate paths', () => {
  it('walks names, indexes, negative indexes, wildcards and [?…]', () => {
    const answers = bodyOf(catalog);
    expect(run('body.user.name', answers)).toEqual({
      present: true,
      value: 'Ada',
      path: 'user.name',
    });
    expect(run('body["user"]["name"]', answers)).toEqual({
      present: true,
      value: 'Ada',
      path: 'user.name',
    });
    expect(run('body.items[0].id', answers)).toEqual({
      present: true,
      value: 1,
      path: 'items[0].id',
    });
    expect(run('body.items[-1].id', answers)).toEqual({
      present: true,
      value: 3,
      path: 'items[-1].id',
    });
    expect(run('body.items[*].id', answers)).toEqual({
      present: true,
      value: [1, 2, 3],
      path: 'items[*].id',
    });
    expect(run('body.items[?price > 10].id', answers)).toEqual({
      present: true,
      value: [2, 3],
      path: 'items[?…].id',
    });
    expect(run('body.items[?price > 10 && id != 3]', answers)).toEqual({
      present: true,
      value: [{ id: 2, price: 15, tags: ['c'] }],
      path: 'items[?…]',
    });
    expect(run('body.tags[?@ startsWith "a" || @ == "gamma"]', answers)).toEqual({
      present: true,
      value: ['alpha', 'gamma'],
      path: 'tags[?…]',
    });
  });

  it('writes the path of a name that is not an identifier with brackets', () => {
    const headers = { 'x-session-token': 'abc', plain: 'p' };
    expect(run('headers["x-session-token"]', { headers: found(headers) })).toEqual({
      present: true,
      value: 'abc',
      path: '["x-session-token"]',
    });
    expect(run('headers.plain', { headers: found(headers) })).toEqual({
      present: true,
      value: 'p',
      path: 'plain',
    });
    expect(run('body.a["b c"].d', bodyOf({ a: { 'b c': { d: 1 } } }))).toEqual({
      present: true,
      value: 1,
      path: 'a["b c"].d',
    });
  });

  it('a name after a filter maps over the matches', () => {
    const answers = bodyOf(catalog);
    expect(run('body.items[?price > 10].id', answers)).toEqual({
      present: true,
      value: [2, 3],
      path: 'items[?…].id',
    });
    expect(run('body.items[*].tags', answers)).toEqual({
      present: true,
      value: [['a', 'b'], ['c'], []],
      path: 'items[*].tags',
    });
    expect(run('body.items[?price > 100].id', answers)).toEqual({
      present: true,
      value: [],
      path: 'items[?…].id',
    });
  });

  it('an index after a filter takes that match', () => {
    const answers = bodyOf(catalog);
    expect(run('body.items[?price > 10][0]', answers)).toEqual({
      present: true,
      value: { id: 2, price: 15, tags: ['c'] },
      path: 'items[?…][0]',
    });
    expect(run('body.items[?price > 10][-1]', answers)).toEqual({
      present: true,
      value: { id: 3, price: 25, tags: [] },
      path: 'items[?…][-1]',
    });
    expect(run('body.items[?price > 10][5]', answers)).toEqual({
      present: false,
      reason: 'has no value at items[?…][5] (the list has 2 items)',
    });
    expect(run('body.items[?price > 100][0]', answers)).toEqual({
      present: false,
      reason: 'has no value at items[?…][0] (the list has 0 items)',
    });
  });

  it('body.items[?status == "ok"][0].id gives the first ok item id', () => {
    const items = [
      { id: 'a', status: 'failed' },
      { id: 'b', status: 'ok' },
      { id: 'c', status: 'ok' },
    ];
    expect(run('body.items[?status == "ok"][0].id', bodyOf({ items }))).toEqual({
      present: true,
      value: 'b',
      path: 'items[?…][0].id',
    });
    expect(run('body.items[?status == "ok"][-1].id', bodyOf({ items }))).toEqual({
      present: true,
      value: 'c',
      path: 'items[?…][-1].id',
    });
  });

  it('an index after a wildcard indexes the list itself', () => {
    const answers = bodyOf(catalog);
    expect(run('body.items[*][-1].id', answers)).toEqual({
      present: true,
      value: 3,
      path: 'items[*][-1].id',
    });
    expect(run('body.items[*][0].id', answers)).toEqual({
      present: true,
      value: 1,
      path: 'items[*][0].id',
    });
    expect(run('body.items[*].id[0]', answers)).toEqual({
      present: true,
      value: 1,
      path: 'items[*].id[0]',
    });
    expect(run('body.items[*].tags[0]', answers)).toEqual({
      present: true,
      value: ['a', 'b'],
      path: 'items[*].tags[0]',
    });
  });

  it('a wildcard after a list maps over each item and flattens one level', () => {
    expect(run('body.items[*].tags[*]', bodyOf(catalog))).toEqual({
      present: true,
      value: ['a', 'b', 'c'],
      path: 'items[*].tags[*]',
    });
    expect(run('body.items[*].tags[*][0]', bodyOf(catalog))).toEqual({
      present: true,
      value: 'a',
      path: 'items[*].tags[*][0]',
    });
    expect(run('body.items[*].tags[*]', bodyOf({ items: [{ tags: [] }, { tags: [] }] }))).toEqual({
      present: true,
      value: [],
      path: 'items[*].tags[*]',
    });
  });

  it('a filter after a list maps over each item and flattens one level', () => {
    const items = [
      { a: 1, tags: ['x', 'y'] },
      { a: 2, tags: ['x'] },
      { a: 1, tags: ['z', 'x'] },
    ];
    expect(run('body.items[?a == 1].tags[?@ == "x"]', bodyOf({ items }))).toEqual({
      present: true,
      value: ['x', 'x'],
      path: 'items[?…].tags[?…]',
    });
    expect(run('body.items[*].tags[?@ != "x"]', bodyOf({ items }))).toEqual({
      present: true,
      value: ['y', 'z'],
      path: 'items[*].tags[?…]',
    });
    expect(run('body.items[?a == 1][0].tags', bodyOf({ items }))).toEqual({
      present: true,
      value: ['x', 'y'],
      path: 'items[?…][0].tags',
    });
    expect(run('body.items[?a == 1].tags[?@ == "q"]', bodyOf({ items }))).toEqual({
      present: true,
      value: [],
      path: 'items[?…].tags[?…]',
    });
  });

  it('a wildcard on an object yields its member values in insertion order', () => {
    const answers = bodyOf({ obj: { b: 1, a: 2, c: { x: 1 } }, none: {} });
    expect(run('body.obj[*]', answers)).toEqual({
      present: true,
      value: [1, 2, { x: 1 }],
      path: 'obj[*]',
    });
    expect(run('body.obj[*][0]', answers)).toEqual({ present: true, value: 1, path: 'obj[*][0]' });
    expect(run('body.obj[*][-1].x', answers)).toEqual({
      present: true,
      value: 1,
      path: 'obj[*][-1].x',
    });
    expect(run('body.none[*]', answers)).toEqual({ present: true, value: [], path: 'none[*]' });
    expect(run('body[*]', bodyOf({ first: 'a', second: 'b' }))).toEqual({
      present: true,
      value: ['a', 'b'],
      path: '[*]',
    });
  });

  it('a filter on an object filters its member values', () => {
    const answers = bodyOf({ scores: { ann: 3, bob: 9, cy: 12 } });
    expect(run('body.scores[?@ > 5]', answers)).toEqual({
      present: true,
      value: [9, 12],
      path: 'scores[?…]',
    });
    expect(run('body.scores[?@ > 50]', answers)).toEqual({
      present: true,
      value: [],
      path: 'scores[?…]',
    });
    expect(
      run(
        'body.users[?active].name',
        bodyOf({
          users: { u1: { active: true, name: 'Ann' }, u2: { active: false, name: 'Bob' } },
        }),
      ),
    ).toEqual({ present: true, value: ['Ann'], path: 'users[?…].name' });
    expect(
      run(
        'body.users[?active][0].name',
        bodyOf({
          users: { u1: { active: false, name: 'Ann' }, u2: { active: true, name: 'Bob' } },
        }),
      ),
    ).toEqual({ present: true, value: 'Bob', path: 'users[?…][0].name' });
  });

  it('a wildcard or filter after a list flattens the member values of object items', () => {
    const teams: Value[] = [
      { name: 'a', roster: { lead: 'ann', dev: 'bob' } },
      { name: 'b', roster: { lead: 'cy' } },
      { name: 'c', roster: {} },
    ];
    expect(run('body.teams[*].roster[*]', bodyOf({ teams }))).toEqual({
      present: true,
      value: ['ann', 'bob', 'cy'],
      path: 'teams[*].roster[*]',
    });
    expect(run('body.teams[*].roster[?@ != "ann"]', bodyOf({ teams }))).toEqual({
      present: true,
      value: ['bob', 'cy'],
      path: 'teams[*].roster[?…]',
    });
    expect(run('body.items[*][*]', bodyOf(catalog))).toEqual({
      present: true,
      value: [1, 5, ['a', 'b'], 2, 15, ['c'], 3, 25, []],
      path: 'items[*][*]',
    });
    expect(run('body.items[?price > 5][?@ > 10]', bodyOf(catalog))).toEqual({
      present: true,
      value: [15, 25],
      path: 'items[?…][?…]',
    });
    expect(run('all()[*]', { all: found([{ a: 1, b: [2] }, { c: 3 }]) })).toEqual({
      present: true,
      value: [1, [2], 3],
      path: '[*]',
    });
  });

  it('names the result that is neither a list nor an object when a wildcard or filter maps over items', () => {
    expect(run('body.items[*][*]', bodyOf({ items: [{ a: 1 }, 2] }))).toEqual({
      present: false,
      reason:
        'has no value at items[*][*] (the value is a number, not a list or an object) in result 2',
    });
    expect(
      run('body.items[*].tags[*]', bodyOf({ items: [{ tags: ['a'] }, { tags: 'b' }] })),
    ).toEqual({
      present: false,
      reason:
        'has no value at items[*].tags[*] (the value is a string, not a list or an object) in result 2',
    });
    expect(run('body.items[*].tags[?@ == "a"]', bodyOf({ items: [{ tags: null }] }))).toEqual({
      present: false,
      reason:
        'has no value at items[*].tags[?…] (the value is null, not a list or an object) in result 1',
    });
  });

  it('reads the first and last elements and an element of the root value', () => {
    expect(run('body[0]', bodyOf([10, 20, 30]))).toEqual({ present: true, value: 10, path: '[0]' });
    expect(run('body[-1]', bodyOf([10, 20, 30]))).toEqual({
      present: true,
      value: 30,
      path: '[-1]',
    });
    expect(run('body', bodyOf('text'))).toEqual({ present: true, value: 'text', path: '' });
  });

  it('maps a path over all(…) results', () => {
    const events: Value[] = [
      { type: 'X', result: { id: 'a', n: 1 } },
      { type: 'X', result: { id: 'b', n: 2 } },
      { type: 'X', result: { id: 'c', n: 3 } },
    ];
    const answers = { all: found(events) };
    expect(run('all(type == "X").result.id', answers)).toEqual({
      present: true,
      value: ['a', 'b', 'c'],
      path: 'result.id',
    });
    expect(run('all(type == "X").result.id | join(",")', answers)).toEqual({
      present: true,
      value: 'a,b,c',
      path: 'result.id',
    });
    expect(run('all(type == "X").result.n | json', answers)).toEqual({
      present: true,
      value: '[1,2,3]',
      path: 'result.n',
    });
    expect(run('all(type == "X")', answers)).toEqual({ present: true, value: events, path: '' });
    expect(run('all(type == "X")[0]', answers)).toEqual({
      present: true,
      value: events[0],
      path: '[0]',
    });
    expect(run('all(type == "X")[-1].result.id', answers)).toEqual({
      present: true,
      value: 'c',
      path: '[-1].result.id',
    });
    expect(run('all(type == "X")[5]', answers)).toEqual({
      present: false,
      reason: 'has no value at [5] (the list has 3 items)',
    });
    expect(run('all(type == "X")[*].result', answers)).toEqual({
      present: false,
      reason: 'has no value at [*].result (the value is a string, not an object) in result 1',
    });
    expect(run('all()', { all: found([]) })).toEqual({ present: true, value: [], path: '' });
    expect(run('all(type == "X").result.id', { all: found([]) })).toEqual({
      present: true,
      value: [],
      path: 'result.id',
    });
  });

  it('all(…).delta is still a list of deltas', () => {
    const events: Value[] = [
      { type: 'x', delta: 'He' },
      { type: 'y', delta: 'no' },
      { type: 'x', delta: 'llo' },
    ];
    expect(
      run('all(type == "x").delta', { all: found([events[0] as Value, events[2] as Value]) }),
    ).toEqual({
      present: true,
      value: ['He', 'llo'],
      path: 'delta',
    });
    expect(
      run('all(type == "x").delta | join("")', {
        all: found([events[0] as Value, events[2] as Value]),
      }),
    ).toEqual({ present: true, value: 'Hello', path: 'delta' });
  });

  it('names the result that lacks the path when mapping', () => {
    const events: Value[] = [{ result: { id: 'a' } }, { result: {} }, { result: { id: 'c' } }];
    expect(run('all().result.id', { all: found(events) })).toEqual({
      present: false,
      reason: 'has no value at result.id ("id" is missing) in result 2',
    });
    expect(run('body.items[*].id', bodyOf({ items: [{ id: 1 }, {}] }))).toEqual({
      present: false,
      reason: 'has no value at items[*].id ("id" is missing) in result 2',
    });
  });

  it('passes the event and the source path through from the source', () => {
    const outcome = evaluate(
      parse('first(type == "X").result.id'),
      sourcesWith({ first: found({ result: { id: 'abc' } }, 3) }),
    );
    expect(outcome).toEqual({ present: true, value: 'abc', path: 'result.id', event: 3 });
    const filtered = evaluate(
      parse('first(type == "X").result.id | match(/^a/)'),
      sourcesWith({ first: found({ result: { id: 'abc' } }, 3) }),
    );
    expect(filtered).toEqual({ present: true, value: 'a', path: 'result.id', event: 3 });
  });

  it('reads a header name without regard to case, dotted or in brackets', () => {
    const headers = { headers: found({ 'x-session-token': 'abc', authorization: 'Bearer t' }) };
    expect(run('headers["x-session-token"]', headers)).toEqual({
      present: true,
      value: 'abc',
      path: '["x-session-token"]',
    });
    expect(run('headers["X-Session-Token"]', headers)).toEqual({
      present: true,
      value: 'abc',
      path: '["x-session-token"]',
    });
    expect(run('headers.Authorization', headers)).toEqual({
      present: true,
      value: 'Bearer t',
      path: 'authorization',
    });
    expect(run('headers.authorization | match(/^Bearer (.+)$/)', headers)).toEqual({
      present: true,
      value: 't',
      path: 'authorization',
    });
    expect(run('headers["X-Missing"]', headers)).toEqual({
      present: false,
      reason: 'has no value at ["x-missing"] ("x-missing" is missing)',
    });
  });

  it('lowercases only the first name step after headers', () => {
    expect(run('headers.Outer.Inner', { headers: found({ outer: { Inner: 1 } }) })).toEqual({
      present: true,
      value: 1,
      path: 'outer.Inner',
    });
    expect(run('headers.Outer.inner', { headers: found({ outer: { Inner: 1 } }) })).toEqual({
      present: false,
      reason: 'has no value at outer.inner ("inner" is missing)',
    });
  });

  it('keeps the case of names after other sources', () => {
    expect(
      run('cookies.SessionId', { cookies: found({ SessionId: 'c', sessionid: 'x' }) }),
    ).toEqual({
      present: true,
      value: 'c',
      path: 'SessionId',
    });
    expect(run('body.Token', bodyOf({ Token: 'a', token: 'b' }))).toEqual({
      present: true,
      value: 'a',
      path: 'Token',
    });
    expect(run('body["X-Id"]', bodyOf({ 'x-id': 1 }))).toEqual({
      present: false,
      reason: 'has no value at ["X-Id"] ("X-Id" is missing)',
    });
  });

  it('hands every source node to Sources and never computes one itself', () => {
    const seen: string[] = [];
    const sources: Sources = {
      value(node) {
        seen.push(node.kind);
        return found(node.kind);
      },
    };
    for (const text of [
      'status',
      'headers',
      'cookies',
      'body',
      'text',
      'first()',
      'last()',
      'nth(2)',
      'all()',
      'count()',
      'jsonpath("$.a")',
    ]) {
      evaluate(parse(text), sources);
    }
    expect(seen).toEqual([
      'source',
      'source',
      'source',
      'source',
      'source',
      'events',
      'events',
      'nth',
      'events',
      'events',
      'jsonpath',
    ]);
    const check = evaluate(parse('exists(body.a)', 'expect'), sources);
    expect(check).toEqual({ present: true, value: 'check', path: '' });
  });

  it('passes a missing source outcome through its path', () => {
    expect(run('first(type == "X").result.id')).toEqual({
      present: false,
      reason: 'no first',
    });
    expect(evaluate(parse('exists(body.a)', 'expect'), sourcesWith({}))).toEqual({
      present: false,
      reason: 'no exists',
    });
  });

  it('evaluates literals and lists', () => {
    expect(run('"text"')).toEqual({ present: true, value: 'text', path: '' });
    expect(run('12345678901234567890')).toEqual({
      present: true,
      value: 12345678901234567890n,
      path: '',
    });
    expect(run('[1, "a", [true, null]]')).toEqual({
      present: true,
      value: [1, 'a', [true, null]],
      path: '',
    });
  });

  it('has no value for a bare regular expression', () => {
    expect(run('/abc/')).toEqual({
      present: false,
      reason: 'has no value (a regular expression is not a value)',
    });
  });
});

describe('evaluate defaults', () => {
  it('default(…) replaces a missing value and nothing else', () => {
    expect(run('body.nope | default("none")', bodyOf({ a: 1 }))).toEqual({
      present: true,
      value: 'none',
      path: '',
    });
    expect(run('first(type == "X").id | default(0)')).toEqual({
      present: true,
      value: 0,
      path: '',
    });
    expect(run('body.items[9] | default([1, "a"])', bodyOf({ items: [] }))).toEqual({
      present: true,
      value: [1, 'a'],
      path: '',
    });
    expect(run('body.a | default("none")', bodyOf({ a: null }))).toEqual({
      present: true,
      value: null,
      path: 'a',
    });
    expect(run('body.a | default("none")', bodyOf({ a: '' }))).toEqual({
      present: true,
      value: '',
      path: 'a',
    });
    expect(run('body.a | default("none")', bodyOf({ a: false }))).toEqual({
      present: true,
      value: false,
      path: 'a',
    });
    expect(run('body.a | default("none")', bodyOf({ a: 0 }))).toEqual({
      present: true,
      value: 0,
      path: 'a',
    });
    expect(run('body.a | default("none")', bodyOf({ a: [] }))).toEqual({
      present: true,
      value: [],
      path: 'a',
    });
  });

  it('keeps the event of a value that is present', () => {
    const outcome = evaluate(
      parse('first().a | default(1)'),
      sourcesWith({ first: found({ a: 2 }, 7) }),
    );
    expect(outcome).toEqual({ present: true, value: 2, path: 'a', event: 7 });
  });
});

describe('evaluate filters', () => {
  it('join, json and match filters', () => {
    expect(run('body.tags | join(", ")', bodyOf(catalog))).toEqual({
      present: true,
      value: 'alpha, beta, gamma',
      path: 'tags',
    });
    expect(run('body | join("")', bodyOf([]))).toEqual({ present: true, value: '', path: '' });
    expect(
      run(
        'body | join(",")',
        bodyOf([1, 12345678901234567890n, 1.5, true, null, 'x', { a: 1 }, [2]]),
      ),
    ).toEqual({
      present: true,
      value: '1,12345678901234567890,1.5,true,null,x,{"a":1},[2]',
      path: '',
    });
    expect(run('body.user | json', bodyOf(catalog))).toEqual({
      present: true,
      value: '{"name":"Ada"}',
      path: 'user',
    });
    expect(run('body.user.name | json', bodyOf(catalog))).toEqual({
      present: true,
      value: '"Ada"',
      path: 'user.name',
    });
    expect(run('body | json', bodyOf({ id: 12345678901234567890n }))).toEqual({
      present: true,
      value: '{"id":12345678901234567890}',
      path: '',
    });
    expect(run('body.id | match(/^run-(\\d+)$/)', bodyOf({ id: 'run-42' }))).toEqual({
      present: true,
      value: '42',
      path: 'id',
    });
    expect(run('body.id | match(/^run-\\d+$/)', bodyOf({ id: 'run-42' }))).toEqual({
      present: true,
      value: 'run-42',
      path: 'id',
    });
    expect(run('body.id | match(/RUN-(\\d+)/i)', bodyOf({ id: 'a run-7 b' }))).toEqual({
      present: true,
      value: '7',
      path: 'id',
    });
    expect(run('body.id | match(/(x)?run/)', bodyOf({ id: 'run' }))).toEqual({
      present: true,
      value: 'run',
      path: 'id',
    });
    expect(run('body.id | match(/(x*)run/)', bodyOf({ id: 'run' }))).toEqual({
      present: true,
      value: '',
      path: 'id',
    });
  });

  it('chains filters', () => {
    expect(run('body.tags | join("-") | match(/^(a\\w+)/)', bodyOf(catalog))).toEqual({
      present: true,
      value: 'alpha',
      path: 'tags',
    });
    expect(run('body.tags | join("-") | json', bodyOf(catalog))).toEqual({
      present: true,
      value: '"alpha-beta-gamma"',
      path: 'tags',
    });
  });

  it('is missing when join gets something that is not a list', () => {
    expect(run('body.user.name | join(",")', bodyOf(catalog))).toEqual({
      present: false,
      reason: 'has no value at user.name (join needs a list, not a string)',
    });
    expect(run('body | join(",")', bodyOf(3))).toEqual({
      present: false,
      reason: 'has no value (join needs a list, not a number)',
    });
  });

  it('is missing, naming the pattern, when match does not match', () => {
    expect(run('body.id | match(/^run-(\\d+)$/i)', bodyOf({ id: 'job-42' }))).toEqual({
      present: false,
      reason: 'has no value at id (the text does not match /^run-(\\d+)$/i)',
    });
  });

  it('is missing when match gets something that is not a string', () => {
    expect(run('body.id | match(/\\d+/)', bodyOf({ id: 42 }))).toEqual({
      present: false,
      reason: 'has no value at id (match needs a string, not a number)',
    });
  });

  it('match(…) on a text too long for its regex is missing with the reason', () => {
    expect(run('body | match(/x/)', bodyOf('x'.repeat(2_000_000)))).toEqual({
      present: false,
      reason: tooLong,
    });
  });

  it('passes a missing target through every filter except default', () => {
    expect(run('body.nope | join(",")', bodyOf({}))).toEqual({
      present: false,
      reason: 'has no value at nope ("nope" is missing)',
    });
    expect(run('body.nope | json', bodyOf({}))).toEqual({
      present: false,
      reason: 'has no value at nope ("nope" is missing)',
    });
    expect(run('body.nope | match(/a/)', bodyOf({}))).toEqual({
      present: false,
      reason: 'has no value at nope ("nope" is missing)',
    });
  });

  it('treats a pattern that does not compile as not matching, never throwing', () => {
    const span = { start: 0, end: 1 };
    const filter: Expr = {
      kind: 'filter',
      target: { kind: 'literal', value: 'abc', span },
      filter: { kind: 'match', pattern: '(', flags: '' },
      span,
    };
    expect(evaluate(filter, sourcesWith({}))).toEqual({
      present: false,
      reason: 'has no value (the regular expression is not valid: Unterminated group.)',
    });
    const condition: Expr = {
      kind: 'compare',
      operator: 'matches',
      left: { kind: 'literal', value: 'abc', span },
      right: { kind: 'regex', pattern: '(', flags: '', span },
      span,
    };
    expect(holds(condition, item(null))).toBe(false);
  });
});

describe('evaluate missing values', () => {
  it('names the missing segment', () => {
    expect(run('body.items[5]', bodyOf({ items: [1, 2, 3] }))).toEqual({
      present: false,
      reason: 'has no value at items[5] (the list has 3 items)',
    });
    expect(run('body.items[-4]', bodyOf({ items: [1, 2, 3] }))).toEqual({
      present: false,
      reason: 'has no value at items[-4] (the list has 3 items)',
    });
    expect(run('body.items[0]', bodyOf({ items: [] }))).toEqual({
      present: false,
      reason: 'has no value at items[0] (the list has 0 items)',
    });
    expect(run('body.items[1]', bodyOf({ items: [1] }))).toEqual({
      present: false,
      reason: 'has no value at items[1] (the list has 1 item)',
    });
    expect(run('first().result.messageId', { first: found({ result: {} }, 3) })).toEqual({
      present: false,
      reason: 'has no value at result.messageId ("messageId" is missing)',
    });
    expect(run('body.name', bodyOf('text'))).toEqual({
      present: false,
      reason: 'has no value at name (the value is a string, not an object)',
    });
    expect(run('body.a.b', bodyOf({ a: null }))).toEqual({
      present: false,
      reason: 'has no value at a.b (the value is null, not an object)',
    });
    expect(run('body.a.b', bodyOf({ a: [1] }))).toEqual({
      present: false,
      reason: 'has no value at a.b (the value is a list, not an object)',
    });
    expect(run('body.a[0]', bodyOf({ a: { b: 1 } }))).toEqual({
      present: false,
      reason: 'has no value at a[0] (the value is an object, not a list)',
    });
    expect(run('body.a[*]', bodyOf({ a: 5 }))).toEqual({
      present: false,
      reason: 'has no value at a[*] (the value is a number, not a list or an object)',
    });
    expect(run('body.a[?@ == 1]', bodyOf({ a: true }))).toEqual({
      present: false,
      reason: 'has no value at a[?…] (the value is a boolean, not a list or an object)',
    });
    expect(run('body[0]', bodyOf({}))).toEqual({
      present: false,
      reason: 'has no value at [0] (the value is an object, not a list)',
    });
    expect(run('headers["x-session-token"]', { headers: found({}) })).toEqual({
      present: false,
      reason: 'has no value at ["x-session-token"] ("x-session-token" is missing)',
    });
  });

  it('reports the first missing segment only', () => {
    expect(run('body.a.b.c', bodyOf({ a: {} }))).toEqual({
      present: false,
      reason: 'has no value at a.b ("b" is missing)',
    });
  });

  it('does not read inherited names', () => {
    expect(run('body.toString', bodyOf({}))).toEqual({
      present: false,
      reason: 'has no value at toString ("toString" is missing)',
    });
    expect(run('body.constructor', bodyOf({}))).toEqual({
      present: false,
      reason: 'has no value at constructor ("constructor" is missing)',
    });
    expect(run('body.length', bodyOf([1]))).toEqual({
      present: false,
      reason: 'has no value at length (the value is a list, not an object)',
    });
  });

  it('reads an own property named __proto__', () => {
    const value = JSON.parse('{"__proto__": {"a": 1}}') as Value;
    expect(run('body["__proto__"].a', bodyOf(value))).toEqual({
      present: true,
      value: 1,
      path: '__proto__.a',
    });
  });
});

describe('evaluate comparisons and logic', () => {
  it('evaluates comparisons to booleans', () => {
    expect(run('status == 200', { status: found(200) })).toEqual({
      present: true,
      value: true,
      path: '',
    });
    expect(run('status >= 300', { status: found(200) })).toEqual({
      present: true,
      value: false,
      path: '',
    });
    expect(run('!(status == 200)', { status: found(200) })).toEqual({
      present: true,
      value: false,
      path: '',
    });
    expect(
      run('status == 200 && body.ok || false', { status: found(200), ...bodyOf({ ok: true }) }),
    ).toEqual({
      present: true,
      value: true,
      path: '',
    });
  });

  it('follows RFC 9535 for a missing side of a comparison', () => {
    const outcome = (text: string): Outcome => run(text, bodyOf({ a: 1 }));
    const result = (value: boolean): Outcome => ({ present: true, value, path: '' });
    expect(outcome('body.nope == 1')).toEqual(result(false));
    expect(outcome('body.nope != 1')).toEqual(result(true));
    expect(outcome('1 != body.nope')).toEqual(result(true));
    expect(outcome('body.nope == body.other')).toEqual(result(true));
    expect(outcome('body.nope != body.other')).toEqual(result(false));
    expect(outcome('body.nope < 1')).toEqual(result(false));
    expect(outcome('body.nope > body.other')).toEqual(result(false));
    expect(outcome('body.nope <= body.other')).toEqual(result(true));
    expect(outcome('body.nope >= body.other')).toEqual(result(true));
    expect(outcome('body.nope <= 1')).toEqual(result(false));
    expect(outcome('1 >= body.nope')).toEqual(result(false));
    expect(outcome('body.a == 1')).toEqual(result(true));
    expect(outcome('body.a != 1')).toEqual(result(false));
  });
});

describe('holds', () => {
  it('a condition holds only for present values other than false and null', () => {
    expect(holdsFor('done', { done: true })).toBe(true);
    expect(holdsFor('done', { done: 'yes' })).toBe(true);
    expect(holdsFor('done', { done: 0 })).toBe(true);
    expect(holdsFor('done', { done: '' })).toBe(true);
    expect(holdsFor('done', { done: {} })).toBe(true);
    expect(holdsFor('done', { done: [0] })).toBe(true);
    expect(holdsFor('done', { done: false })).toBe(false);
    expect(holdsFor('done', { done: null })).toBe(false);
    expect(holdsFor('done', {})).toBe(false);
    expect(holdsFor('done', 'not an object')).toBe(false);
    expect(holdsFor('done', null)).toBe(false);
    expect(holdsFor('result.ok', { result: { ok: true } })).toBe(true);
    expect(holdsFor('result.ok', { result: null })).toBe(false);
    expect(holdsFor('@', true)).toBe(true);
    expect(holdsFor('@', false)).toBe(false);
    expect(holdsFor('@', null)).toBe(false);
  });

  it('treats words that name sources as fields of the item', () => {
    expect(holdsFor('status == "ok"', { status: 'ok' })).toBe(true);
    expect(holdsFor('first == 1 && count == 2', { first: 1, count: 2 })).toBe(true);
    expect(holdsFor('status', {})).toBe(false);
  });

  it('combines conditions with !, && and ||', () => {
    expect(holdsFor('!done', {})).toBe(true);
    expect(holdsFor('!done', { done: true })).toBe(false);
    expect(holdsFor('!done', { done: false })).toBe(true);
    expect(holdsFor('type == "A" && ok', { type: 'A', ok: true })).toBe(true);
    expect(holdsFor('type == "A" && ok', { type: 'A', ok: false })).toBe(false);
    expect(holdsFor('type == "A" || type == "B"', { type: 'B' })).toBe(true);
    expect(holdsFor('type == "A" || type == "B"', { type: 'C' })).toBe(false);
    expect(holdsFor('!(type == "A" || type == "B")', { type: 'C' })).toBe(true);
    expect(holdsFor('a == 1 && b == 2 || c == 3', { a: 1, c: 3 })).toBe(true);
  });

  it('malformed items never match', () => {
    expect(holdsFor('type == "A"', { type: 'A' }, { malformed: true })).toBe(false);
    expect(holdsFor('!done', {}, { malformed: true })).toBe(false);
    expect(holdsFor('@', true, { malformed: true })).toBe(false);
    expect(holdsFor('type == "A"', { type: 'A' }, { malformed: false })).toBe(true);
  });

  it('@sse fields are readable in a condition', () => {
    const sse = { event: 'delta', id: '7', retry: 1500 };
    expect(holdsFor('@sse.event == "delta"', {}, { sse })).toBe(true);
    expect(holdsFor('@sse.event == "other"', {}, { sse })).toBe(false);
    expect(holdsFor('@sse.id == "7"', {}, { sse })).toBe(true);
    expect(holdsFor('@sse.retry == 1500', {}, { sse })).toBe(true);
    expect(holdsFor('@sse.retry > 1000 && type == "A"', { type: 'A' }, { sse })).toBe(true);
    expect(holdsFor('@sse.event == "delta"', {}, { sse: { id: '1' } })).toBe(false);
    expect(holdsFor('@sse.event == "delta"', {}, { sse: undefined })).toBe(false);
    expect(holdsFor('@sse.event', {}, { sse: undefined })).toBe(false);
    expect(holdsFor('@sse', {}, { sse: { id: '1' } })).toBe(true);
    expect(holdsFor('@sse', {}, { sse: undefined })).toBe(false);
    expect(holdsFor('!@sse.event', {}, { sse: { id: '1' } })).toBe(true);
  });

  it('reads @sse inside a [?…] of the same condition', () => {
    expect(
      holdsFor('items[?@sse.event == "delta"]', { items: [1] }, { sse: { event: 'delta' } }),
    ).toBe(true);
    expect(holdsFor('items[?@ > 1] == [2]', { items: [1, 2] }, { sse: undefined })).toBe(true);
  });

  it('compares with lossless numbers and never coerces', () => {
    expect(holdsFor('id == 12345678901234567890', { id: 12345678901234567890n })).toBe(true);
    expect(holdsFor('id == 12345678901234567891', { id: 12345678901234567890n })).toBe(false);
    expect(holdsFor('id < 12345678901234567891', { id: 12345678901234567890n })).toBe(true);
    expect(holdsFor('n == 2', { n: 2n })).toBe(true);
    expect(holdsFor('n < 2.5', { n: 2n })).toBe(true);
    expect(holdsFor('n == "1"', { n: 1 })).toBe(false);
    expect(holdsFor('n != "1"', { n: 1 })).toBe(true);
    expect(holdsFor('n < "2"', { n: 1 })).toBe(false);
    expect(holdsFor('flag == 1', { flag: true })).toBe(false);
    expect(holdsFor('name < "b"', { name: 'a' })).toBe(true);
    expect(holdsFor('name >= "b"', { name: 'a' })).toBe(false);
    expect(holdsFor('name <= "a"', { name: 'a' })).toBe(true);
    expect(holdsFor('name > "A"', { name: 'a' })).toBe(true);
  });

  it('compares objects and lists deeply with ==', () => {
    expect(holdsFor('pair == [1, "a"]', { pair: [1, 'a'] })).toBe(true);
    expect(holdsFor('pair == [1, "a"]', { pair: ['a', 1] })).toBe(false);
    expect(holdsFor('pair != [1, "a"]', { pair: [1, 'b'] })).toBe(true);
    expect(holdsFor('a == b', { a: { x: [1, { y: 2n }] }, b: { x: [1, { y: 2 }] } })).toBe(true);
    expect(holdsFor('a == b', { a: { x: 1 }, b: { x: 2 } })).toBe(false);
  });

  it('!= is the negation of ==, which is true for two missing sides and false for one', () => {
    expect(holdsFor('nope == 1', {})).toBe(false);
    expect(holdsFor('nope != 1', {})).toBe(true);
    expect(holdsFor('1 == nope', {})).toBe(false);
    expect(holdsFor('1 != nope', {})).toBe(true);
    expect(holdsFor('nope == null', {})).toBe(false);
    expect(holdsFor('nope != null', {})).toBe(true);
    expect(holdsFor('nope == other', {})).toBe(true);
    expect(holdsFor('nope != other', {})).toBe(false);
    expect(holdsFor('nope == other', { nope: 1 })).toBe(false);
    expect(holdsFor('nope != other', { nope: 1 })).toBe(true);
    expect(holdsFor('type != "x"', {})).toBe(true);
    expect(holdsFor('type != "x"', { type: 'x' })).toBe(false);
    expect(holdsFor('type != "x"', { type: 'y' })).toBe(true);
    expect(holdsFor('result != null', { result: { ok: true } })).toBe(true);
    expect(holdsFor('result != null', { result: null })).toBe(false);
    expect(holdsFor('!(nope == 1)', {})).toBe(true);
    expect(holdsFor('!(nope != 1)', {})).toBe(false);
    expect(holdsFor('nope == /a/', {})).toBe(false);
  });

  it('<= and >= are true when both sides are missing and false when one is', () => {
    expect(holdsFor('nope <= other', {})).toBe(true);
    expect(holdsFor('nope >= other', {})).toBe(true);
    expect(holdsFor('nope <= 1', {})).toBe(false);
    expect(holdsFor('1 <= nope', {})).toBe(false);
    expect(holdsFor('nope >= 1', {})).toBe(false);
    expect(holdsFor('1 >= nope', {})).toBe(false);
    expect(holdsFor('nope <= other', { other: 1 })).toBe(false);
    expect(holdsFor('nope <= /a/', {})).toBe(false);
    expect(holdsFor('nope >= /a/', {})).toBe(false);
  });

  it('a missing side makes every other comparison false', () => {
    for (const operator of ['<', '>']) {
      expect(holdsFor(`nope ${operator} 1`, {})).toBe(false);
      expect(holdsFor(`1 ${operator} nope`, {})).toBe(false);
      expect(holdsFor(`nope ${operator} other`, {})).toBe(false);
    }
    for (const operator of ['<=', '>=']) {
      expect(holdsFor(`nope ${operator} 1`, {})).toBe(false);
      expect(holdsFor(`1 ${operator} nope`, {})).toBe(false);
    }
    expect(holdsFor('nope in [1]', {})).toBe(false);
    expect(holdsFor('1 in nope', {})).toBe(false);
    expect(holdsFor('nope in other', {})).toBe(false);
    expect(holdsFor('nope contains "a"', {})).toBe(false);
    expect(holdsFor('"a" contains nope', {})).toBe(false);
    expect(holdsFor('nope contains other', {})).toBe(false);
    expect(holdsFor('nope startsWith "a"', {})).toBe(false);
    expect(holdsFor('"a" startsWith nope', {})).toBe(false);
    expect(holdsFor('nope startsWith other', {})).toBe(false);
    expect(holdsFor('nope matches /a/', {})).toBe(false);
    expect(holdsFor('!(nope < 1)', {})).toBe(true);
  });

  it('an empty filter result does not satisfy a condition', () => {
    const items = { items: [{ id: 'a', tags: [] }] };
    expect(holdsFor('items[?id == "x"]', items)).toBe(false);
    expect(holdsFor('items[?id == "x"].id', items)).toBe(false);
    expect(holdsFor('items[?id == "x"] && items[0]', items)).toBe(false);
    expect(holdsFor('items[*]', { items: [] })).toBe(false);
    expect(holdsFor('items[*].id', { items: [] })).toBe(false);
    expect(holdsFor('items[?tags]', items)).toBe(false);
    expect(holdsFor('tags', { tags: [] })).toBe(false);
    expect(holdsFor('items[?id == "x"][0]', items)).toBe(false);
    expect(holdsFor('!items[?id == "x"]', items)).toBe(true);
    expect(holdsFor('items[?id == "x"] || items[?id == "a"]', items)).toBe(true);
  });

  it('an empty flattened result does not satisfy a condition, a non-empty one does', () => {
    expect(holdsFor('items[*].tags[*]', { items: [{ tags: [] }, { tags: [] }] })).toBe(false);
    expect(holdsFor('items[*].tags[*]', { items: [{ tags: [] }, { tags: ['a'] }] })).toBe(true);
    expect(holdsFor('items[?a == 1].tags[?@ == "x"]', { items: [{ a: 1, tags: ['y'] }] })).toBe(
      false,
    );
    expect(holdsFor('items[?a == 1].tags[?@ == "x"]', { items: [{ a: 1, tags: ['x'] }] })).toBe(
      true,
    );
  });

  it('a non-empty filter result does', () => {
    const items = {
      items: [
        { id: 'a', tags: ['t'] },
        { id: 'x', tags: [] },
      ],
    };
    expect(holdsFor('items[?id == "x"]', items)).toBe(true);
    expect(holdsFor('items[?id == "x"].id', items)).toBe(true);
    expect(holdsFor('items[*]', items)).toBe(true);
    expect(holdsFor('items[*].id', items)).toBe(true);
    expect(holdsFor('items[?tags]', items)).toBe(true);
    expect(holdsFor('items[?id == "x"][0].id == "x"', items)).toBe(true);
    expect(holdsFor('items[?id == "a"][0].tags', items)).toBe(true);
    expect(holdsFor('!items[?id == "x"]', items)).toBe(false);
  });

  it('still evaluates an empty filter result as a present list outside a condition', () => {
    expect(run('body.items[?id == "x"]', bodyOf({ items: [] }))).toEqual({
      present: true,
      value: [],
      path: 'items[?…]',
    });
    expect(run('body.items[?id == "x"] | default("none")', bodyOf({ items: [] }))).toEqual({
      present: true,
      value: [],
      path: 'items[?…]',
    });
  });

  it('tests membership, substrings, prefixes and patterns', () => {
    expect(holdsFor('type in ["A", "B"]', { type: 'B' })).toBe(true);
    expect(holdsFor('type in ["A", "B"]', { type: 'C' })).toBe(false);
    expect(holdsFor('n in [1, 2]', { n: 2n })).toBe(true);
    expect(holdsFor('type in ["1"]', { type: 1 })).toBe(false);
    expect(holdsFor('type in "AB"', { type: 'A' })).toBe(false);
    expect(holdsFor('type in tags', { type: 'A', tags: ['A'] })).toBe(true);
    expect(holdsFor('text contains "ell"', { text: 'hello' })).toBe(true);
    expect(holdsFor('text contains "xyz"', { text: 'hello' })).toBe(false);
    expect(holdsFor('text contains 1', { text: 'a1' })).toBe(false);
    expect(holdsFor('tags contains "b"', { tags: ['a', 'b'] })).toBe(true);
    expect(holdsFor('tags contains "c"', { tags: ['a', 'b'] })).toBe(false);
    expect(holdsFor('tags contains 2', { tags: [1, 2n] })).toBe(true);
    expect(holdsFor('obj contains "a"', { obj: { a: 1 } })).toBe(false);
    expect(holdsFor('text startsWith "he"', { text: 'hello' })).toBe(true);
    expect(holdsFor('text startsWith "lo"', { text: 'hello' })).toBe(false);
    expect(holdsFor('text startsWith 1', { text: '1a' })).toBe(false);
    expect(holdsFor('n startsWith "1"', { n: 12 })).toBe(false);
    expect(holdsFor('type matches /^RUN_/', { type: 'RUN_STARTED' })).toBe(true);
    expect(holdsFor('type matches /^RUN_/', { type: 'TEXT' })).toBe(false);
    expect(holdsFor('type matches /^run_/i', { type: 'RUN_STARTED' })).toBe(true);
    expect(holdsFor('type matches /^1/', { type: 12 })).toBe(false);
    expect(holdsFor('type matches "RUN"', { type: 'RUN' })).toBe(false);
    expect(holdsFor('type matches nope', { type: 'RUN' })).toBe(false);
  });

  it('a regex whose test is too long never matches in a condition', () => {
    const long = 'x'.repeat(2_000_000);
    expect(holdsFor('text matches /x/', { text: long })).toBe(false);
    expect(holdsFor('text matches /^x+$/', { text: long })).toBe(false);
    expect(holdsFor('text matches /x/', { text: 'x'.repeat(10) })).toBe(true);
    expect(holdsFor('!(text matches /x/)', { text: long })).toBe(true);
  });

  it('evaluates [?…] inside a condition against each element', () => {
    expect(holdsFor('items[?price > 10]', { items: [{ price: 5 }, { price: 15 }] })).toBe(true);
    expect(
      holdsFor('items[?price > 10].price == [15]', { items: [{ price: 5 }, { price: 15 }] }),
    ).toBe(true);
    expect(holdsFor('items[*].price == [5, 15]', { items: [{ price: 5 }, { price: 15 }] })).toBe(
      true,
    );
    expect(holdsFor('items[0].price == 5', { items: [{ price: 5 }] })).toBe(true);
    expect(holdsFor('items[3].price == 5', { items: [{ price: 5 }] })).toBe(false);
  });

  it('never reads a source from inside a condition', () => {
    const span = { start: 0, end: 4 };
    const condition: Expr = { kind: 'source', name: 'body', span };
    expect(holds(condition, item({ body: 1 }))).toBe(false);
  });
});

describe('reason constants', () => {
  it('name the fixed reasons', () => {
    expect(textTooLongReason).toBe(tooLong);
    expect(valueTooLargeReason).toBe(tooLarge);
  });
});

describe('evaluate size limit', () => {
  const kilobyte = 'x'.repeat(1_000);

  it('json fails above 1 MiB', () => {
    expect(run('body | json', bodyOf(Array.from({ length: 2_000 }, () => kilobyte)))).toEqual({
      present: false,
      reason: tooLarge,
    });
    expect(run('body | json', bodyOf(kilobyte.repeat(1_100)))).toEqual({
      present: false,
      reason: tooLarge,
    });
  });

  it('join fails above 1 MiB, counting separators', () => {
    expect(run('body | join(",")', bodyOf(Array.from({ length: 2_000 }, () => kilobyte)))).toEqual({
      present: false,
      reason: tooLarge,
    });
    const separator = '-'.repeat(2_000);
    expect(
      run(`body | join("${separator}")`, bodyOf(Array.from({ length: 600 }, () => 'x'))),
    ).toEqual({
      present: false,
      reason: tooLarge,
    });
    expect(run('body | join(",")', bodyOf(['x'.repeat(1_048_577)]))).toEqual({
      present: false,
      reason: tooLarge,
    });
  });

  it('json and join still work below 1 MiB', () => {
    const list = Array.from({ length: 1_000 }, () => kilobyte);
    const joined = presentValue(run('body | join("")', bodyOf(list)));
    expect(typeof joined === 'string' && joined.length).toBe(1_000_000);
    const json = presentValue(run('body | json', bodyOf(list)));
    expect(typeof json === 'string' && json.length).toBe(1_000 * 1_002 + 999 + 2);
  });
});

describe('regular expression caching', () => {
  it('compiles each regex node once however often it runs', () => {
    const condition = parse('type matches /^RUN_/i && text matches /a/', 'condition');
    const filtered = parse('body | match(/b(c)/)');
    vi.mocked(regex.compilePattern).mockClear();
    for (let run = 0; run < 50; run += 1) {
      holds(condition, item({ type: 'run_started', text: 'a' }));
      evaluate(filtered, sourcesWith({ body: found('abc') }));
    }
    expect(vi.mocked(regex.compilePattern)).toHaveBeenCalledTimes(3);
  });

  it('compiles a regex node of a different expression separately', () => {
    const first = parse('type matches /^A/', 'condition');
    const second = parse('type matches /^A/', 'condition');
    vi.mocked(regex.compilePattern).mockClear();
    holds(first, item({ type: 'A' }));
    holds(second, item({ type: 'A' }));
    expect(vi.mocked(regex.compilePattern)).toHaveBeenCalledTimes(2);
  });
});

describe('evaluate values nested 10,000 levels deep', () => {
  it('walks a value nested 10,000 levels deep without overflowing', () => {
    const deep = nested(10_000, 'leaf');
    const outcome = run('body.next', bodyOf({ next: deep }));
    expect(outcome.present).toBe(true);
    expect(presentValue(outcome)).toBe(deep);

    const json = presentValue(run('body | json', bodyOf(deep)));
    expect(typeof json === 'string' && json.length).toBe(8 * 10_000 + 6 + 10_000);

    const lists = nestedLists(10_000, 7);
    const mapped = presentValue(run('body[*]', bodyOf(lists)));
    expect(Array.isArray(mapped) && mapped.length).toBe(1);
    expect(presentValue(run('body[0]', bodyOf(lists)))).toBe((lists as Value[])[0]);

    expect(holdsFor('a == b', { a: nested(10_000, 1), b: nested(10_000, 1) })).toBe(true);
    expect(holdsFor('a == b', { a: nested(10_000, 1), b: nested(10_000, 2) })).toBe(false);
    expect(
      holdsFor('a.next.next == b.next.next', { a: nested(10_000, 1), b: nested(10_000, 1) }),
    ).toBe(true);
    expect(presentValue(run('body | join(",")', bodyOf([deep, deep])))).toEqual(
      expect.stringContaining('"leaf"'),
    );
  });

  it('evaluates an expression with thousands of chained steps without recursing per step', () => {
    const path = `body${'.next'.repeat(700)}`;
    const outcome = run(path, bodyOf(nested(700, 'leaf')));
    expect(presentValue(outcome)).toBe('leaf');
    const chain = Array.from({ length: 1_000 }, () => 'a').join('||');
    expect(holdsFor(chain, { a: true })).toBe(true);
    expect(holdsFor(chain, { b: true })).toBe(false);
    const filters = `body${' | default(1)'.repeat(300)}`;
    expect(run(filters, bodyOf(1)).present).toBe(true);
  });
});

describe('work budget', () => {
  const tooMuchWork = 'the expression needs too much work for this value';
  const numbers = (count: number): string => `[${Array<string>(count).fill('7').join(',')}]`;
  const spent = (text: string, value: Value): number => {
    const budget = new WorkBudget();
    evaluate(parse(text), sourcesWith(bodyOf(value)), { budget });
    return budget.spent;
  };

  it('stops an evaluation that needs more work than its budget', () => {
    const value: Value = Array.from({ length: 5_000 }, (_, at) => at);
    const budget = new WorkBudget({ units: 100_000 });

    const outcome = evaluate(parse(`body[?@ in ${numbers(1_300)}]`), sourcesWith(bodyOf(value)), {
      budget,
    });

    expect(outcome).toEqual({ present: false, reason: tooMuchWork });
    expect(budget.exhausted).toBe(true);
  });

  it('is not hidden by default(…)', () => {
    const value: Value = Array.from({ length: 5_000 }, (_, at) => at);

    const outcome = evaluate(
      parse(`body[?@ in ${numbers(1_300)}] | default("none")`),
      sourcesWith(bodyOf(value)),
      { budget: new WorkBudget({ units: 100_000 }) },
    );

    expect(outcome).toEqual({ present: false, reason: tooMuchWork });
  });

  it('counts each path step per item, each comparison, each membership comparison and regex work', () => {
    const items: Value = Array.from({ length: 100 }, (_, at) => at + 100);

    expect(spent('body[*]', items)).toBeGreaterThanOrEqual(100);
    expect(spent('body[?@ == 1]', items)).toBeGreaterThanOrEqual(200);
    expect(spent(`body[?@ in ${numbers(50)}]`, items)).toBeGreaterThanOrEqual(100 * 50);
    expect(spent('body[?@ matches /a+b/]', ['a'.repeat(1_000)])).toBeGreaterThanOrEqual(1_000);
    expect(spent('body', items)).toBeLessThan(10);
  });

  it('charges string operations by length / 16 and object members by key count', () => {
    const text = 'a'.repeat(16_384);
    const other = `${'a'.repeat(16_383)}b`;
    const keyed = Object.fromEntries(
      Array.from({ length: 2_000 }, (_, at) => [`k${String(at)}`, 0]),
    );

    expect(spent('body.s contains "ab"', { s: text })).toBeGreaterThanOrEqual(1_024);
    expect(spent('body.s startsWith body.t', { s: text, t: other })).toBeGreaterThanOrEqual(1_024);
    expect(spent('body.s == body.t', { s: text, t: other })).toBeGreaterThanOrEqual(1_024);
    expect(spent('body.s < body.t', { s: text, t: other })).toBeGreaterThanOrEqual(1_024);
    expect(spent('body.s in [1, 2]', { s: text })).toBeLessThan(16);
    expect(spent('body.o[*][0] == 1', { o: keyed })).toBeGreaterThanOrEqual(2_000);
    expect(spent('body[?@.o[?@ == 1]]', [{ o: keyed }])).toBeGreaterThanOrEqual(4_000);
    expect(spent('body.o == body.o', { o: keyed })).toBeLessThan(16);
    expect(spent('body.o == body.p', { o: keyed, p: { ...keyed } })).toBeGreaterThanOrEqual(4_000);
  });

  it('charges json and join by their output, each default(…) by 1 and each list item once', () => {
    const zeros: Value = Array<number>(4_000).fill(0);

    expect(spent('body | json', zeros)).toBeGreaterThanOrEqual(4_000);
    expect(spent('body | join(",")', [zeros])).toBeGreaterThanOrEqual(4_000);
    expect(spent('body | join(",")', ['x'.repeat(65_536)])).toBeGreaterThanOrEqual(4_096);
    expect(spent(`body${' | default(0)'.repeat(300)}`, 1)).toBeGreaterThanOrEqual(300);
    expect(spent(`body.nope${'.a'.repeat(300)}`, {})).toBeGreaterThanOrEqual(300);

    const list = parse(`body in ${numbers(1_000)}`);
    const first = new WorkBudget();
    evaluate(list, sourcesWith(bodyOf(7)), { budget: first });
    const second = new WorkBudget();
    evaluate(list, sourcesWith(bodyOf(7)), { budget: second });
    expect(first.spent).toBeGreaterThanOrEqual(1_000);
    expect(second.spent).toBeLessThan(16);
  });

  it('checks its clock every 1,024 units and stops once the clock has expired', () => {
    let checks = 0;
    let expired = false;
    const budget = new WorkBudget({
      expired: () => {
        checks += 1;
        return expired;
      },
      reason: 'out of time',
    });

    budget.spend(1_023);
    expect(checks).toBe(0);
    budget.spend(1);
    expect(checks).toBe(1);
    budget.spend(1_023);
    expect(checks).toBe(1);
    expired = true;
    expect(() => {
      budget.spend(1);
    }).toThrow();
    expect(checks).toBe(2);
    expect(budget.exhausted).toBe(true);
  });

  it('fails an evaluation whose clock expires with its budget reason, and stays exhausted', () => {
    let calls = 0;
    const budget = new WorkBudget({
      expired: () => {
        calls += 1;
        return calls > 2;
      },
      reason: 'out of time',
    });
    const value: Value = Array.from({ length: 5_000 }, (_, at) => at);

    expect(evaluate(parse('body[?@ == 1]'), sourcesWith(bodyOf(value)), { budget })).toEqual({
      present: false,
      reason: 'out of time',
    });
    expect(budget.exhausted).toBe(true);
    expect(evaluate(parse('body[0]'), sourcesWith(bodyOf(value)), { budget })).toEqual({
      present: false,
      reason: 'out of time',
    });
    expect(holds(parse('type == "A"', 'condition'), item({ type: 'A' }), { budget })).toBe(false);
  });

  it('makes a condition false and marks its budget exhausted', () => {
    const budget = new WorkBudget({ units: 1_000 });

    const result = holds(
      parse(`items[?@ in ${numbers(100)}]`, 'condition'),
      item({
        items: Array.from({ length: 1_000 }, (_, at) => at),
      }),
      { budget },
    );

    expect(result).toBe(false);
    expect(budget.exhausted).toBe(true);
    expect(holdsFor('type == "A"', { type: 'A' })).toBe(true);
  });

  it('builds a constant list literal once per node', () => {
    const expression = parse('[1, 2, [3, 4]]');

    const first = evaluate(expression, sourcesWith({}));
    const second = evaluate(expression, sourcesWith({}));

    expect(first).toEqual({ present: true, value: [1, 2, [3, 4]], path: '' });
    expect(first.present && second.present && first.value === second.value).toBe(true);
  });

  it('finds a text that spans the windows of a long string', () => {
    const long = 'a'.repeat(200_000);
    for (const at of [0, 65_535, 65_536, 131_071, 199_998]) {
      const text = `${long.slice(0, at)}xy${long.slice(at + 2)}`;
      expect(holdsFor('s contains "xy"', { s: text }), String(at)).toBe(true);
      expect(holdsFor('s contains "xz"', { s: text }), String(at)).toBe(false);
    }
    const needle = 'b'.repeat(70_000);
    expect(holdsFor('s contains t', { s: `${long}${needle}`, t: needle })).toBe(true);
    expect(holdsFor('s contains t', { s: long, t: `${long}a` })).toBe(false);
    expect(holdsFor('s contains ""', { s: long })).toBe(true);
  });
});
