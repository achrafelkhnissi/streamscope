import { describe, expect, it } from 'vitest';
import type { CompareOperator, Expr, SourceNode, Value } from '../../../src/expressions/ast';
import {
  parseExpression,
  sourcesOf,
  type ExpressionContext,
  type ExpressionError,
} from '../../../src/expressions/parse';

const unknownSource =
  'Unknown source `frist`. Expected status, headers, cookies, body, text, first, last, nth, all, count or jsonpath.';
const expectedLiteral = 'Expected a string, number, true, false, null, regular expression or list.';
const nestedRepetition =
  'This regular expression can take very long on some inputs, because a repeated group contains another repetition. Rewrite it without nested repetition.';
const repeatedAlternatives =
  'This regular expression can take very long on some inputs, because a repeated group contains alternatives. Rewrite it without alternatives inside a repeated group.';

function parse(text: string, context: ExpressionContext = 'capture'): Expr {
  const result = parseExpression(text, context);
  if (!result.ok) {
    throw new Error(
      `${text} failed: ${result.error.message} at ${JSON.stringify(result.error.span)}`,
    );
  }
  return result.expr;
}

function failure(text: string, context: ExpressionContext = 'capture'): ExpressionError {
  const result = parseExpression(text, context);
  if (result.ok) {
    throw new Error(`${text} parsed`);
  }
  return result.error;
}

function withoutSpans(value: unknown): unknown {
  if (Array.isArray(value)) {
    return (value as unknown[]).map(withoutSpans);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'span' && key !== 'querySpan')
        .map(([key, child]) => [key, withoutSpans(child)]),
    );
  }
  return value;
}

function shape(text: string, context: ExpressionContext = 'capture'): unknown {
  return withoutSpans(parse(text, context));
}

const source = (name: string): object => ({ kind: 'source', name });
const field = (name: string): object => ({ kind: 'field', name });
const literal = (value: Value): object => ({ kind: 'literal', value });
const regex = (pattern: string, flags = ''): object => ({ kind: 'regex', pattern, flags });
const list = (...items: object[]): object => ({ kind: 'list', items });
const named = (target: object, name: string): object => ({
  kind: 'access',
  target,
  step: { kind: 'name', name },
});
const indexed = (target: object, index: number): object => ({
  kind: 'access',
  target,
  step: { kind: 'index', index },
});
const wildcard = (target: object): object => ({
  kind: 'access',
  target,
  step: { kind: 'wildcard' },
});
const where = (target: object, condition: object): object => ({
  kind: 'access',
  target,
  step: { kind: 'where', condition },
});
const compare = (operator: CompareOperator, left: object, right: object): object => ({
  kind: 'compare',
  operator,
  left,
  right,
});
const logical = (operator: '&&' | '||', left: object, right: object): object => ({
  kind: 'logical',
  operator,
  left,
  right,
});
const not = (operand: object): object => ({ kind: 'not', operand });
const events = (name: 'first' | 'last' | 'all' | 'count', condition?: object): object => ({
  kind: 'events',
  name,
  condition,
});
const nth = (position: number, condition?: object): object => ({
  kind: 'nth',
  position,
  condition,
});
const piped = (target: object, filter: object): object => ({ kind: 'filter', target, filter });

describe('parseExpression', () => {
  describe('the design examples', () => {
    const examples: [string, object][] = [
      [
        'first(type == "RUN_STARTED").threadId',
        named(events('first', compare('==', field('type'), literal('RUN_STARTED'))), 'threadId'),
      ],
      [
        'last(type == "RUN_FINISHED").result.messageId',
        named(
          named(events('last', compare('==', field('type'), literal('RUN_FINISHED'))), 'result'),
          'messageId',
        ),
      ],
      ['headers["x-session-token"]', named(source('headers'), 'x-session-token')],
      [
        'nth(2, type == "TEXT_MESSAGE_CONTENT").delta',
        named(nth(2, compare('==', field('type'), literal('TEXT_MESSAGE_CONTENT'))), 'delta'),
      ],
      [
        'all(type == "TEXT_MESSAGE_CONTENT").delta | join("")',
        piped(
          named(
            events('all', compare('==', field('type'), literal('TEXT_MESSAGE_CONTENT'))),
            'delta',
          ),
          { kind: 'join', separator: '' },
        ),
      ],
      [
        'body.items[?status == "ok"][*].id',
        named(
          wildcard(
            where(named(source('body'), 'items'), compare('==', field('status'), literal('ok'))),
          ),
          'id',
        ),
      ],
      ['body.items[-1]', indexed(named(source('body'), 'items'), -1)],
      [
        'count(@sse.event == "ping") > 3',
        compare(
          '>',
          events('count', compare('==', named({ kind: 'sse' }, 'event'), literal('ping'))),
          literal(3),
        ),
      ],
      [
        'cookies.session | default("none")',
        piped(named(source('cookies'), 'session'), { kind: 'default', value: 'none' }),
      ],
      ['jsonpath("$.items[*].id")', { kind: 'jsonpath', query: '$.items[*].id' }],
      [
        'text | match(/id=(\\d+)/)',
        piped(source('text'), { kind: 'match', pattern: 'id=(\\d+)', flags: '' }),
      ],
      [
        '!(status in [500, 502]) && status >= 200',
        logical(
          '&&',
          not(compare('in', source('status'), list(literal(500), literal(502)))),
          compare('>=', source('status'), literal(200)),
        ),
      ],
    ];

    it.each(examples)('parses %s', (text, expected) => {
      expect(shape(text)).toStrictEqual(expected);
    });
  });

  describe('contexts', () => {
    it('treats every word in a condition as a field, including words that name sources', () => {
      expect(shape('first(status == "done")')).toStrictEqual(
        events('first', compare('==', field('status'), literal('done'))),
      );
      expect(shape('type == "done" && body != null && text > 1', 'condition')).toStrictEqual(
        logical(
          '&&',
          logical(
            '&&',
            compare('==', field('type'), literal('done')),
            compare('!=', field('body'), literal(null)),
          ),
          compare('>', field('text'), literal(1)),
        ),
      );
    });

    it('treats bare identifiers in a condition as fields', () => {
      const expr = parse('first(status == "done")');

      expect(expr).toMatchObject({
        kind: 'events',
        name: 'first',
        condition: {
          kind: 'compare',
          left: { kind: 'field', name: 'status', span: { start: 6, end: 12 } },
        },
      });
    });

    it('treats a word that names a source call as a field inside a condition', () => {
      expect(shape('first(first == 1 && count != all)')).toStrictEqual(
        events(
          'first',
          logical(
            '&&',
            compare('==', field('first'), literal(1)),
            compare('!=', field('count'), field('all')),
          ),
        ),
      );
      expect(shape('jsonpath == 1', 'condition')).toStrictEqual(
        compare('==', field('jsonpath'), literal(1)),
      );
    });

    it('reads fields in a filter as fields of the current element', () => {
      expect(shape('body[?price > 3 && @.kind == "a"]')).toStrictEqual(
        where(
          source('body'),
          logical(
            '&&',
            compare('>', field('price'), literal(3)),
            compare('==', named({ kind: 'item' }, 'kind'), literal('a')),
          ),
        ),
      );
    });

    it('reads fields in a condition nested in a condition', () => {
      expect(shape('first(items[?price > 3].length == 1)')).toStrictEqual(
        events(
          'first',
          compare(
            '==',
            named(where(field('items'), compare('>', field('price'), literal(3))), 'length'),
            literal(1),
          ),
        ),
      );
    });

    it('goes back to sources after a condition ends', () => {
      expect(shape('first(a == 1).x == status')).toStrictEqual(
        compare(
          '==',
          named(events('first', compare('==', field('a'), literal(1))), 'x'),
          source('status'),
        ),
      );
      expect(shape('body[?a == 1].x == status')).toStrictEqual(
        compare(
          '==',
          named(where(source('body'), compare('==', field('a'), literal(1))), 'x'),
          source('status'),
        ),
      );
    });

    it('allows checks only in # @expect', () => {
      expect(shape('exists(body.x)', 'expect')).toStrictEqual({
        kind: 'check',
        name: 'exists',
        args: [named(source('body'), 'x')],
      });
      expect(shape('unique(all().id)', 'expect')).toStrictEqual({
        kind: 'check',
        name: 'unique',
        args: [named(events('all'), 'id')],
      });
      expect(shape('before(first(type == "a"), first(type == "b"))', 'expect')).toStrictEqual({
        kind: 'check',
        name: 'before',
        args: [
          events('first', compare('==', field('type'), literal('a'))),
          events('first', compare('==', field('type'), literal('b'))),
        ],
      });
      expect(shape('!exists(body.x) || count() > 1', 'expect')).toStrictEqual(
        logical(
          '||',
          not({ kind: 'check', name: 'exists', args: [named(source('body'), 'x')] }),
          compare('>', events('count'), literal(1)),
        ),
      );
    });

    it('reports a check outside # @expect over the whole call', () => {
      expect(failure('exists(body.x)')).toStrictEqual({
        message: 'exists(…) is only available in # @expect.',
        span: { start: 0, end: 14 },
      });
      expect(failure('unique(body.x)')).toStrictEqual({
        message: 'unique(…) is only available in # @expect.',
        span: { start: 0, end: 14 },
      });
      expect(failure('before(first(), last())')).toStrictEqual({
        message: 'before(…) is only available in # @expect.',
        span: { start: 0, end: 23 },
      });
      expect(failure('1 && exists(body.x)')).toStrictEqual({
        message: 'exists(…) is only available in # @expect.',
        span: { start: 5, end: 19 },
      });
    });

    it('reports a syntax error inside a check before the context error', () => {
      expect(failure('exists(body.)')).toStrictEqual({
        message: 'Expected a name after ".".',
        span: { start: 12, end: 13 },
      });
    });

    it('reads a check name as a field in a condition and then rejects its parenthesis', () => {
      expect(failure('exists(body.x)', 'condition')).toStrictEqual({
        message: 'Unexpected `(`.',
        span: { start: 6, end: 7 },
      });
    });

    it('allows @ and @sse only in a condition', () => {
      expect(failure('@')).toStrictEqual({
        message: '`@` is only available inside a condition.',
        span: { start: 0, end: 1 },
      });
      expect(failure('@sse.event == "ping"', 'expect')).toStrictEqual({
        message: '`@sse` is only available inside a condition.',
        span: { start: 0, end: 4 },
      });
      expect(shape('@.type == "a" && @sse.id != null', 'condition')).toStrictEqual(
        logical(
          '&&',
          compare('==', named({ kind: 'item' }, 'type'), literal('a')),
          compare('!=', named({ kind: 'sse' }, 'id'), literal(null)),
        ),
      );
      expect(failure('first(@foo)')).toStrictEqual({
        message: 'Unknown `@foo`. Expected `@` or `@sse`.',
        span: { start: 6, end: 10 },
      });
    });
  });

  describe('or, and, not', () => {
    it('binds && tighter than ||', () => {
      expect(shape('a || b && c', 'condition')).toStrictEqual(
        logical('||', field('a'), logical('&&', field('b'), field('c'))),
      );
      expect(shape('a && b || c', 'condition')).toStrictEqual(
        logical('||', logical('&&', field('a'), field('b')), field('c')),
      );
    });

    it('groups chains of the same operator to the left', () => {
      expect(shape('a || b || c', 'condition')).toStrictEqual(
        logical('||', logical('||', field('a'), field('b')), field('c')),
      );
      expect(shape('a && b && c', 'condition')).toStrictEqual(
        logical('&&', logical('&&', field('a'), field('b')), field('c')),
      );
    });

    it('lets parentheses override precedence', () => {
      expect(shape('(a || b) && c', 'condition')).toStrictEqual(
        logical('&&', logical('||', field('a'), field('b')), field('c')),
      );
    });

    it('binds ! looser than a comparison and tighter than &&', () => {
      expect(shape('!a == b', 'condition')).toStrictEqual(
        not(compare('==', field('a'), field('b'))),
      );
      expect(shape('!a && b', 'condition')).toStrictEqual(
        logical('&&', not(field('a')), field('b')),
      );
      expect(shape('a && !b || c', 'condition')).toStrictEqual(
        logical('||', logical('&&', field('a'), not(field('b'))), field('c')),
      );
      expect(shape('!(a == b)', 'condition')).toStrictEqual(
        not(compare('==', field('a'), field('b'))),
      );
    });

    it('allows one ! only', () => {
      expect(failure('!!status')).toStrictEqual({
        message: 'Unexpected `!`.',
        span: { start: 1, end: 2 },
      });
    });
  });

  describe('comparison', () => {
    it('reads every comparison operator', () => {
      const operators: CompareOperator[] = [
        '==',
        '!=',
        '<',
        '<=',
        '>',
        '>=',
        'in',
        'contains',
        'startsWith',
        'matches',
      ];

      for (const operator of operators) {
        expect(shape(`status ${operator} 1`), operator).toStrictEqual(
          compare(operator, source('status'), literal(1)),
        );
      }
    });

    it('compares two pipes', () => {
      expect(shape('text | default("") == body.a | json')).toStrictEqual(
        compare(
          '==',
          piped(source('text'), { kind: 'default', value: '' }),
          piped(named(source('body'), 'a'), { kind: 'json' }),
        ),
      );
    });

    it('matches a string against a regex literal', () => {
      expect(shape('text matches /^ok$/i')).toStrictEqual(
        compare('matches', source('text'), regex('^ok$', 'i')),
      );
    });

    it('does not chain comparisons', () => {
      expect(failure('status == 1 == 2')).toStrictEqual({
        message: 'Unexpected `==`.',
        span: { start: 12, end: 14 },
      });
    });
  });

  describe('pipe and filters', () => {
    it('reads default, join, json and match', () => {
      expect(shape('body | default(null)')).toStrictEqual(
        piped(source('body'), { kind: 'default', value: null }),
      );
      expect(shape('body | default(5)')).toStrictEqual(
        piped(source('body'), { kind: 'default', value: 5 }),
      );
      expect(shape('body | default(true)')).toStrictEqual(
        piped(source('body'), { kind: 'default', value: true }),
      );
      expect(shape('body | default([1, "a", null, [false, -2.5]])')).toStrictEqual(
        piped(source('body'), {
          kind: 'default',
          value: [1, 'a', null, [false, -2.5]],
        }),
      );
      expect(shape("body | join(', ')")).toStrictEqual(
        piped(source('body'), { kind: 'join', separator: ', ' }),
      );
      expect(shape('body | json')).toStrictEqual(piped(source('body'), { kind: 'json' }));
      expect(shape('text | match(/a(b)/ius)')).toStrictEqual(
        piped(source('text'), { kind: 'match', pattern: 'a(b)', flags: 'ius' }),
      );
    });

    it('applies filters left to right', () => {
      expect(shape('body.a | join(",") | match(/x/) | json')).toStrictEqual(
        piped(
          piped(piped(named(source('body'), 'a'), { kind: 'join', separator: ',' }), {
            kind: 'match',
            pattern: 'x',
            flags: '',
          }),
          { kind: 'json' },
        ),
      );
    });

    it('keeps the digits of a large integer in default', () => {
      expect(shape('body | default(12345678901234567890)')).toStrictEqual(
        piped(source('body'), { kind: 'default', value: 12345678901234567890n }),
      );
    });

    it('binds a pipe looser than a path', () => {
      expect(shape('body.a.b | json')).toStrictEqual(
        piped(named(named(source('body'), 'a'), 'b'), { kind: 'json' }),
      );
    });

    it('rejects an unknown filter, naming the filters', () => {
      expect(failure('body | foo')).toStrictEqual({
        message: 'Unknown filter `foo`. Expected default, join, json or match.',
        span: { start: 7, end: 10 },
      });
      expect(failure('body | in')).toStrictEqual({
        message: 'Unknown filter `in`. Expected default, join, json or match.',
        span: { start: 7, end: 9 },
      });
      expect(failure('body | 5')).toStrictEqual({
        message: 'Expected default, join, json or match.',
        span: { start: 7, end: 8 },
      });
    });

    it('rejects filter arguments of the wrong kind', () => {
      expect(failure('body | join(1)')).toStrictEqual({
        message: 'Expected a string.',
        span: { start: 12, end: 13 },
      });
      expect(failure('body | match("x")')).toStrictEqual({
        message: 'Expected a regular expression.',
        span: { start: 13, end: 16 },
      });
      expect(failure('body | default(x)')).toStrictEqual({
        message: expectedLiteral,
        span: { start: 15, end: 16 },
      });
      expect(failure('body | default(/x/)')).toStrictEqual({
        message: 'default(…) cannot take a regular expression.',
        span: { start: 15, end: 18 },
      });
      expect(failure('body | default([1, /x/])')).toStrictEqual({
        message: 'default(…) cannot take a regular expression.',
        span: { start: 19, end: 22 },
      });
      expect(failure('body | join')).toStrictEqual({
        message: 'Expected "(".',
        span: { start: 11, end: 11 },
      });
    });
  });

  describe('access', () => {
    it('reads names, strings, indexes, wildcards and filters', () => {
      expect(shape('body.a')).toStrictEqual(named(source('body'), 'a'));
      expect(shape('body["a b"]')).toStrictEqual(named(source('body'), 'a b'));
      expect(shape("body['a']")).toStrictEqual(named(source('body'), 'a'));
      expect(shape('body[0]')).toStrictEqual(indexed(source('body'), 0));
      expect(shape('body[12]')).toStrictEqual(indexed(source('body'), 12));
      expect(shape('body[-3]')).toStrictEqual(indexed(source('body'), -3));
      expect(shape('body[-0]')).toStrictEqual(indexed(source('body'), 0));
      expect(shape('body[*]')).toStrictEqual(wildcard(source('body')));
      expect(shape('body[?a == 1]')).toStrictEqual(
        where(source('body'), compare('==', field('a'), literal(1))),
      );
    });

    it('chains steps left to right', () => {
      expect(shape('body.a[0]["b"][*].c')).toStrictEqual(
        named(wildcard(named(indexed(named(source('body'), 'a'), 0), 'b')), 'c'),
      );
    });

    it('allows keywords as names after a dot', () => {
      for (const name of ['true', 'false', 'null', 'in', 'contains', 'startsWith', 'matches']) {
        expect(shape(`body.${name}`), name).toStrictEqual(named(source('body'), name));
      }
    });

    it('reads a word that names a source after a dot as a name', () => {
      expect(shape('body.status.first.count')).toStrictEqual(
        named(named(named(source('body'), 'status'), 'first'), 'count'),
      );
    });

    it('applies steps to any primary', () => {
      expect(shape('(body).a')).toStrictEqual(named(source('body'), 'a'));
      expect(shape('"abc"[0]')).toStrictEqual(indexed(literal('abc'), 0));
      expect(shape('first(a == 1).b[0]')).toStrictEqual(
        indexed(named(events('first', compare('==', field('a'), literal(1))), 'b'), 0),
      );
      expect(shape('jsonpath("$.a")[0]')).toStrictEqual(
        indexed({ kind: 'jsonpath', query: '$.a' }, 0),
      );
    });

    it('tolerates spaces between tokens', () => {
      expect(shape('first ( type == "x" ) . a [ 0 ] | json')).toStrictEqual(
        shape('first(type == "x").a[0]|json'),
      );
      expect(shape('body [ * ] [ ? a == 1 ]')).toStrictEqual(shape('body[*][?a==1]'));
    });

    it('rejects a missing or malformed step', () => {
      expect(failure('body.')).toStrictEqual({
        message: 'Expected a name after ".".',
        span: { start: 5, end: 5 },
      });
      expect(failure('body.1')).toStrictEqual({
        message: 'Expected a name after ".".',
        span: { start: 5, end: 6 },
      });
      expect(failure('body[')).toStrictEqual({
        message: 'Expected an index, a string, `*` or `?`.',
        span: { start: 5, end: 5 },
      });
      expect(failure('body[a]')).toStrictEqual({
        message: 'Expected an index, a string, `*` or `?`.',
        span: { start: 5, end: 6 },
      });
      expect(failure('body[1')).toStrictEqual({
        message: 'Expected "]".',
        span: { start: 6, end: 6 },
      });
      expect(failure('body[*')).toStrictEqual({
        message: 'Expected "]".',
        span: { start: 6, end: 6 },
      });
      expect(failure('body["a" 1]')).toStrictEqual({
        message: 'Expected "]".',
        span: { start: 9, end: 10 },
      });
      expect(failure('body[?]')).toStrictEqual({
        message: 'Unexpected `]`.',
        span: { start: 6, end: 7 },
      });
    });

    it('rejects an index that is not a whole number', () => {
      expect(failure('body[1.5]')).toStrictEqual({
        message: 'An index must be a whole number.',
        span: { start: 5, end: 8 },
      });
      expect(failure('body[12345678901234567890]')).toStrictEqual({
        message: 'An index must be a whole number.',
        span: { start: 5, end: 25 },
      });
      expect(failure('body[1e300]')).toStrictEqual({
        message: 'An index must be a whole number.',
        span: { start: 5, end: 10 },
      });
    });
  });

  describe('primary and literals', () => {
    it('reads the plain sources', () => {
      for (const name of ['status', 'headers', 'cookies', 'body', 'text']) {
        expect(shape(name), name).toStrictEqual(source(name));
      }
    });

    it('reads strings, numbers, booleans and null', () => {
      expect(shape('"a"')).toStrictEqual(literal('a'));
      expect(shape("'a'")).toStrictEqual(literal('a'));
      expect(shape('1')).toStrictEqual(literal(1));
      expect(shape('-1.5')).toStrictEqual(literal(-1.5));
      expect(shape('true')).toStrictEqual(literal(true));
      expect(shape('false')).toStrictEqual(literal(false));
      expect(shape('null')).toStrictEqual(literal(null));
      expect(shape('12345678901234567890')).toStrictEqual(literal(12345678901234567890n));
    });

    it('reads a list of literals, including nested lists and regexes', () => {
      expect(shape('[1]')).toStrictEqual(list(literal(1)));
      expect(shape('[1, "a", true, null, [2, [3]], /x/i]')).toStrictEqual(
        list(
          literal(1),
          literal('a'),
          literal(true),
          literal(null),
          list(literal(2), list(literal(3))),
          regex('x', 'i'),
        ),
      );
      expect(shape('status in [200,204]')).toStrictEqual(
        compare('in', source('status'), list(literal(200), literal(204))),
      );
    });

    it('reads a regex literal with its flags', () => {
      expect(shape('/a+b/imsu')).toStrictEqual(regex('a+b', 'imsu'));
    });

    it('reads a parenthesized expression as the expression itself', () => {
      expect(shape('((status))')).toStrictEqual(source('status'));
    });

    it('rejects an empty list and a list of non-literals', () => {
      expect(failure('status in []')).toStrictEqual({
        message: expectedLiteral,
        span: { start: 11, end: 12 },
      });
      expect(failure('status in [1,]')).toStrictEqual({
        message: expectedLiteral,
        span: { start: 13, end: 14 },
      });
      expect(failure('status in [a]')).toStrictEqual({
        message: expectedLiteral,
        span: { start: 11, end: 12 },
      });
      expect(failure('status in [1 2]')).toStrictEqual({
        message: 'Expected "]".',
        span: { start: 13, end: 14 },
      });
      expect(failure('status in [1')).toStrictEqual({
        message: 'Expected "]".',
        span: { start: 12, end: 12 },
      });
    });
  });

  describe('sources', () => {
    it('reads first, last, all and count with and without a condition', () => {
      for (const name of ['first', 'last', 'all', 'count'] as const) {
        expect(shape(`${name}()`), name).toStrictEqual(events(name));
        expect(shape(`${name}(type == "a")`), name).toStrictEqual(
          events(name, compare('==', field('type'), literal('a'))),
        );
      }
    });

    it('reads a bare identifier as the whole condition', () => {
      expect(shape('first(done)')).toStrictEqual(events('first', field('done')));
      expect(shape('count(!done)')).toStrictEqual(events('count', not(field('done'))));
    });

    it('reads nth with a position and an optional condition', () => {
      expect(shape('nth(1)')).toStrictEqual(nth(1));
      expect(shape('nth(3, type == "a")')).toStrictEqual(
        nth(3, compare('==', field('type'), literal('a'))),
      );
      expect(shape('nth(2147483647, a)')).toStrictEqual(nth(2147483647, field('a')));
      expect(shape('nth(2.0)')).toStrictEqual(nth(2));
    });

    it('reads jsonpath with a string query', () => {
      expect(parse('jsonpath("$.items[*].id")')).toStrictEqual({
        kind: 'jsonpath',
        query: '$.items[*].id',
        querySpan: { start: 9, end: 24 },
        span: { start: 0, end: 25 },
      });
    });

    it('keeps the decoded query and the span of the literal as written', () => {
      expect(parse(String.raw`jsonpath('$["a\"b"]')`)).toMatchObject({
        kind: 'jsonpath',
        query: '$["a"b"]',
        querySpan: { start: 9, end: 20 },
        span: { start: 0, end: 21 },
      });
    });

    it('rejects an unknown source, naming the sources', () => {
      expect(failure('frist(type == "x")')).toStrictEqual({
        message: unknownSource,
        span: { start: 0, end: 5 },
      });
      expect(failure('frist')).toStrictEqual({
        message: unknownSource,
        span: { start: 0, end: 5 },
      });
      expect(failure('status == frist')).toStrictEqual({
        message: unknownSource,
        span: { start: 10, end: 15 },
      });
    });

    it('rejects a call source written without its parenthesis', () => {
      for (const name of ['first', 'last', 'nth', 'all', 'count', 'jsonpath']) {
        expect(failure(name), name).toStrictEqual({
          message: 'Expected "(".',
          span: { start: name.length, end: name.length },
        });
      }
      expect(failure('first == 1')).toStrictEqual({
        message: 'Expected "(".',
        span: { start: 6, end: 8 },
      });
    });

    it('rejects arguments of the wrong shape', () => {
      expect(failure('nth()')).toStrictEqual({
        message: 'Expected a whole number.',
        span: { start: 4, end: 5 },
      });
      expect(failure('nth(a)')).toStrictEqual({
        message: 'Expected a whole number.',
        span: { start: 4, end: 5 },
      });
      expect(failure('nth(2 a)')).toStrictEqual({
        message: 'Expected ")".',
        span: { start: 6, end: 7 },
      });
      expect(failure('jsonpath(1)')).toStrictEqual({
        message: 'Expected a string.',
        span: { start: 9, end: 10 },
      });
      expect(failure('jsonpath("$"')).toStrictEqual({
        message: 'Expected ")".',
        span: { start: 12, end: 12 },
      });
      expect(failure('jsonpath()')).toStrictEqual({
        message: 'Expected a string.',
        span: { start: 9, end: 10 },
      });
      expect(failure('exists()', 'expect')).toStrictEqual({
        message: 'Unexpected `)`.',
        span: { start: 7, end: 8 },
      });
      expect(failure('exists(body.x, 1)', 'expect')).toStrictEqual({
        message: 'Expected ")".',
        span: { start: 13, end: 14 },
      });
      expect(failure('before(first())', 'expect')).toStrictEqual({
        message: 'Expected ",".',
        span: { start: 14, end: 15 },
      });
      expect(failure('before(first(), last(), all())', 'expect')).toStrictEqual({
        message: 'Expected ")".',
        span: { start: 22, end: 23 },
      });
    });

    it('rejects a position that is not a whole number from 1 to 2,147,483,647', () => {
      const range = 'nth(…) takes a whole number from 1 to 2,147,483,647.';

      expect(failure('nth(0, x)')).toStrictEqual({
        message: 'nth(…) counts from 1.',
        span: { start: 4, end: 5 },
      });
      expect(failure('nth(-1, x)')).toStrictEqual({
        message: 'nth(…) counts from 1.',
        span: { start: 4, end: 6 },
      });
      expect(failure('nth(-12345678901234567890, x)')).toStrictEqual({
        message: 'nth(…) counts from 1.',
        span: { start: 4, end: 25 },
      });
      expect(failure('nth(1.5, a)')).toStrictEqual({ message: range, span: { start: 4, end: 7 } });
      expect(failure('nth(2147483648, a)')).toStrictEqual({
        message: range,
        span: { start: 4, end: 14 },
      });
      expect(failure('nth(12345678901234567890)')).toStrictEqual({
        message: range,
        span: { start: 4, end: 24 },
      });
    });
  });

  describe('regex literals', () => {
    it('rejects a catastrophic pattern over the literal', () => {
      expect(failure('text matches /(a+)+$/')).toStrictEqual({
        message: nestedRepetition,
        span: { start: 13, end: 21 },
      });
      expect(failure('status in [/(a|aa)*b/]')).toStrictEqual({
        message: repeatedAlternatives,
        span: { start: 11, end: 21 },
      });
    });

    it('rejects a catastrophic pattern in match() over the literal', () => {
      expect(failure('text | match(/(a|aa)*b/)')).toStrictEqual({
        message: repeatedAlternatives,
        span: { start: 13, end: 23 },
      });
      expect(failure(String.raw`text | match(/(a)\1/)`)).toStrictEqual({
        message:
          'This regular expression uses a backreference, which can take very long on some inputs. Rewrite it without one.',
        span: { start: 13, end: 20 },
      });
    });

    it('rejects a pattern that is not valid regular expression syntax', () => {
      const error = failure('text matches /(/');

      expect(error.message).toMatch(/^Invalid regular expression: .*\.$/);
      expect(error.span).toStrictEqual({ start: 13, end: 16 });
      expect(failure('text | match(/[/)').message).toMatch(/^Unterminated regular expression\.$/);
      expect(failure(String.raw`text | match(/\p{Nope}/u)`).message).toMatch(
        /^Invalid regular expression: /,
      );
    });

    it('reports a flag the lexer rejects over the flag', () => {
      expect(failure('text | match(/a/g)')).toStrictEqual({
        message: 'Unsupported regular expression flag `g`. Supported flags are i, m, s and u.',
        span: { start: 16, end: 17 },
      });
    });

    it('accepts a safe pattern with every flag', () => {
      expect(shape(String.raw`text | match(/id=(\d+)/imsu)`)).toStrictEqual(
        piped(source('text'), { kind: 'match', pattern: String.raw`id=(\d+)`, flags: 'imsu' }),
      );
    });
  });

  describe('errors', () => {
    it('reports a missing parenthesis at the end of the text', () => {
      expect(failure('first(type == "x"')).toStrictEqual({
        message: 'Expected ")".',
        span: { start: 17, end: 17 },
      });
      expect(failure('(status')).toStrictEqual({
        message: 'Expected ")".',
        span: { start: 7, end: 7 },
      });
    });

    it('reports an unknown source over the identifier', () => {
      expect(failure('frist(type == "x")')).toStrictEqual({
        message: unknownSource,
        span: { start: 0, end: 5 },
      });
    });

    it('reports an unterminated string over the string', () => {
      expect(failure('"abc')).toStrictEqual({
        message: 'Unterminated string.',
        span: { start: 0, end: 4 },
      });
      expect(failure('status == "abc')).toStrictEqual({
        message: 'Unterminated string.',
        span: { start: 10, end: 14 },
      });
    });

    it('reports an unexpected token over the token', () => {
      expect(failure('status 200')).toStrictEqual({
        message: 'Unexpected `200`.',
        span: { start: 7, end: 10 },
      });
      expect(failure('status)')).toStrictEqual({
        message: 'Unexpected `)`.',
        span: { start: 6, end: 7 },
      });
      expect(failure('status == == 1')).toStrictEqual({
        message: 'Unexpected `==`.',
        span: { start: 10, end: 12 },
      });
      expect(failure('status # 1')).toStrictEqual({
        message: 'Unexpected `#`.',
        span: { start: 7, end: 8 },
      });
    });

    it('reports the end of the text where an expression is missing', () => {
      expect(failure('')).toStrictEqual({
        message: 'Unexpected end of the expression.',
        span: { start: 0, end: 0 },
      });
      expect(failure('   ')).toStrictEqual({
        message: 'Unexpected end of the expression.',
        span: { start: 3, end: 3 },
      });
      expect(failure('status ==')).toStrictEqual({
        message: 'Unexpected end of the expression.',
        span: { start: 9, end: 9 },
      });
      expect(failure('first(')).toStrictEqual({
        message: 'Unexpected end of the expression.',
        span: { start: 6, end: 6 },
      });
      expect(failure('status &&')).toStrictEqual({
        message: 'Unexpected end of the expression.',
        span: { start: 9, end: 9 },
      });
    });

    it('reports the first error from left to right', () => {
      expect(failure('status 200 "abc')).toStrictEqual({
        message: 'Unexpected `200`.',
        span: { start: 7, end: 10 },
      });
      expect(failure('first(type == "x" "abc')).toStrictEqual({
        message: 'Unterminated string.',
        span: { start: 18, end: 22 },
      });
      expect(failure('frist("abc')).toStrictEqual({
        message: unknownSource,
        span: { start: 0, end: 5 },
      });
    });

    it('reports an invalid escape over the escape', () => {
      expect(failure(String.raw`"a\qb"`)).toStrictEqual({
        message: 'Invalid escape sequence.',
        span: { start: 2, end: 4 },
      });
    });

    it('rejects a text over 4,096 characters and accepts one of exactly 4,096', () => {
      expect(failure('1'.repeat(4097))).toStrictEqual({
        message: 'An expression is at most 4,096 characters.',
        span: { start: 0, end: 4097 },
      });
      expect(failure(' '.repeat(4097))).toStrictEqual({
        message: 'An expression is at most 4,096 characters.',
        span: { start: 0, end: 4097 },
      });
      expect(parse(' '.repeat(4095) + '1')).toMatchObject({
        kind: 'literal',
        value: 1,
        span: { start: 4095, end: 4096 },
      });
    });

    it('rejects 65 nested parentheses at the 65th and accepts 64', () => {
      expect(failure('('.repeat(65) + '1' + ')'.repeat(65))).toStrictEqual({
        message: 'The expression nests too deeply.',
        span: { start: 64, end: 65 },
      });
      expect(parse('('.repeat(64) + '1' + ')'.repeat(64))).toMatchObject({
        kind: 'literal',
        value: 1,
        span: { start: 64, end: 65 },
      });
    });

    it('counts parentheses, brackets and calls together', () => {
      const inner = (brackets: number): string =>
        'unique('.repeat(20) +
        '('.repeat(22) +
        '['.repeat(brackets) +
        '1' +
        ']'.repeat(brackets) +
        ')'.repeat(22) +
        ')'.repeat(20);

      expect(parse(inner(22), 'expect')).toMatchObject({ kind: 'check', name: 'unique' });
      expect(failure(inner(23), 'expect')).toStrictEqual({
        message: 'The expression nests too deeply.',
        span: { start: 184, end: 185 },
      });
    });

    it('counts the brackets of a path and the parentheses of a call', () => {
      expect(failure('body' + '[?a'.repeat(65) + ']'.repeat(65))).toStrictEqual({
        message: 'The expression nests too deeply.',
        span: { start: 4 + 3 * 64, end: 4 + 3 * 64 + 1 },
      });
      expect(failure('unique('.repeat(65) + '1' + ')'.repeat(65), 'expect')).toStrictEqual({
        message: 'The expression nests too deeply.',
        span: { start: 6 + 7 * 64, end: 6 + 7 * 64 + 1 },
      });
    });
  });

  describe('spans', () => {
    it('gives each node the span of the text it covers, parentheses included for its parents', () => {
      expect(parse('!(status in [500, 502]) && status >= 200')).toStrictEqual({
        kind: 'logical',
        operator: '&&',
        left: {
          kind: 'not',
          operand: {
            kind: 'compare',
            operator: 'in',
            left: { kind: 'source', name: 'status', span: { start: 2, end: 8 } },
            right: {
              kind: 'list',
              items: [
                { kind: 'literal', value: 500, span: { start: 13, end: 16 } },
                { kind: 'literal', value: 502, span: { start: 18, end: 21 } },
              ],
              span: { start: 12, end: 22 },
            },
            span: { start: 2, end: 22 },
          },
          span: { start: 0, end: 23 },
        },
        right: {
          kind: 'compare',
          operator: '>=',
          left: { kind: 'source', name: 'status', span: { start: 27, end: 33 } },
          right: { kind: 'literal', value: 200, span: { start: 37, end: 40 } },
          span: { start: 27, end: 40 },
        },
        span: { start: 0, end: 40 },
      });
    });

    it('gives every step of a path the span from the start of the path', () => {
      expect(parse('body.items[?status == "ok"][*].id')).toStrictEqual({
        kind: 'access',
        target: {
          kind: 'access',
          target: {
            kind: 'access',
            target: {
              kind: 'access',
              target: { kind: 'source', name: 'body', span: { start: 0, end: 4 } },
              step: { kind: 'name', name: 'items' },
              span: { start: 0, end: 10 },
            },
            step: {
              kind: 'where',
              condition: {
                kind: 'compare',
                operator: '==',
                left: { kind: 'field', name: 'status', span: { start: 12, end: 18 } },
                right: { kind: 'literal', value: 'ok', span: { start: 22, end: 26 } },
                span: { start: 12, end: 26 },
              },
            },
            span: { start: 0, end: 27 },
          },
          step: { kind: 'wildcard' },
          span: { start: 0, end: 30 },
        },
        step: { kind: 'name', name: 'id' },
        span: { start: 0, end: 33 },
      });
    });

    it('spans a call from its name to its closing parenthesis and a pipe to its filter', () => {
      expect(parse('first( type == "x" ) | json')).toMatchObject({
        kind: 'filter',
        target: {
          kind: 'events',
          condition: { span: { start: 7, end: 18 } },
          span: { start: 0, end: 20 },
        },
        filter: { kind: 'json' },
        span: { start: 0, end: 27 },
      });
      expect(parse('nth(2).a')).toMatchObject({
        kind: 'access',
        target: { kind: 'nth', position: 2, span: { start: 0, end: 6 } },
        span: { start: 0, end: 8 },
      });
    });

    it('spans a parenthesized operand from its opening parenthesis in its parent', () => {
      expect(parse('(status).a == 1')).toMatchObject({
        kind: 'compare',
        left: { kind: 'access', span: { start: 0, end: 10 } },
        span: { start: 0, end: 15 },
      });
    });
  });
});

describe('sourcesOf', () => {
  function names(text: string, context: ExpressionContext = 'capture'): string[] {
    return sourcesOf(parse(text, context)).map((node) => ('name' in node ? node.name : node.kind));
  }

  it('returns every source outside conditions, outermost first, left to right', () => {
    expect(names('status')).toStrictEqual(['status']);
    expect(names('body.a | default(1)')).toStrictEqual(['body']);
    expect(names('count(type == "a") > 3 && last(b).y == body.z')).toStrictEqual([
      'count',
      'last',
      'body',
    ]);
    expect(names('status in [200, 201] || (headers["a"] == text)')).toStrictEqual([
      'status',
      'headers',
      'text',
    ]);
    expect(names('!(jsonpath("$.a") == nth(2).b)')).toStrictEqual(['jsonpath', 'nth']);
  });

  it('puts a check before the sources of its arguments', () => {
    expect(
      names('before(first(type == "A"), first(type == "B")) && exists(body.x)', 'expect'),
    ).toStrictEqual(['before', 'first', 'first', 'exists', 'body']);
    expect(names('unique(all().id) && count() == 1', 'expect')).toStrictEqual([
      'unique',
      'all',
      'count',
    ]);
  });

  it('returns the node itself', () => {
    const expr = parse('first(a).b | json');
    const [node] = sourcesOf(expr);

    expect(node).toMatchObject({ kind: 'events', name: 'first', span: { start: 0, end: 8 } });
  });

  it('finds no source in a condition', () => {
    expect(names('first(status == 1 && body != 2)')).toStrictEqual(['first']);
    expect(names('body[?status == 1][*].id')).toStrictEqual(['body']);
    expect(names('type == "done" && body == 1', 'condition')).toStrictEqual([]);
  });

  it('finds none in an expression made of literals', () => {
    expect(sourcesOf(parse('[1, 2] == "a"'))).toStrictEqual([]);
  });

  it('walks the deepest path and the longest chain an expression can hold', () => {
    const path = 'status' + '.a'.repeat(2045);
    const chain = Array.from({ length: 400 }, () => 'status').join(' || ');

    expect(path).toHaveLength(4096);
    expect(sourcesOf(parse(path))).toStrictEqual([
      { kind: 'source', name: 'status', span: { start: 0, end: 6 } },
    ]);

    const sources: readonly SourceNode[] = sourcesOf(parse(chain));

    expect(sources).toHaveLength(400);
    expect(sources[0]).toMatchObject({ span: { start: 0, end: 6 } });
    expect(sources[399]).toMatchObject({ span: { start: 399 * 10, end: 399 * 10 + 6 } });
  });
});
