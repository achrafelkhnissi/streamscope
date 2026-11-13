import { describe, expect, it } from 'vitest';
import { checkJsonPath } from '../../../src/expressions/jsonpath';
import type { DiagnosticCode } from '../../../src/http-file/model';
import { parseHttpFile } from '../../../src/http-file/parse';

const request = 'GET https://api.example.test/a';

function at(line: number, start: number, end: number) {
  return { start: { line, character: start }, end: { line, character: end } };
}

function parse(...content: string[]) {
  return parseHttpFile(content.join('\n'));
}

function firstRequest(...content: string[]) {
  const found = parse(...content).requests[0];
  if (!found) {
    throw new Error('expected a request');
  }
  return found;
}

function only(code: DiagnosticCode, ...content: string[]) {
  const found = parse(...content).diagnostics;
  expect(found.map((diagnostic) => diagnostic.code)).toEqual([code]);
  return found[0];
}

function column(line: string, text: string): number {
  const index = line.indexOf(text);
  expect(index, text).toBeGreaterThanOrEqual(0);
  return index;
}

describe('parseHttpFile captures', () => {
  it('splits secret, name and expression with their ranges', () => {
    const line = '# @capture secret token = body.token';
    const captures = firstRequest(line, request).captures;

    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      secret: true,
      name: 'token',
      nameRange: at(0, 18, 23),
      expressionText: 'body.token',
      expressionRange: at(0, 26, 36),
      range: at(0, 0, 36),
      expression: {
        kind: 'access',
        target: { kind: 'source', name: 'body' },
        step: { kind: 'name', name: 'token' },
      },
    });
  });

  it('reads a capture that is not secret', () => {
    const [capture] = firstRequest(
      '# @capture id = first(type == "RUN_STARTED").threadId',
      request,
    ).captures;

    expect(capture).toMatchObject({
      secret: false,
      name: 'id',
      nameRange: at(0, 11, 13),
      expressionText: 'first(type == "RUN_STARTED").threadId',
      expressionRange: at(0, 16, 53),
    });
  });

  it('trims the whitespace around the name, the equals sign and the expression', () => {
    const line = '//   @capture   secret   id   =   status  ';
    const [capture] = firstRequest(line, request).captures;

    expect(capture).toMatchObject({
      secret: true,
      name: 'id',
      nameRange: at(0, 25, 27),
      expressionText: 'status',
      expressionRange: at(0, 34, 40),
      range: at(0, 0, 40),
    });
  });

  it('keeps the equals signs inside the expression', () => {
    const [capture] = firstRequest('# @capture ok = status == 200', request).captures;

    expect(capture).toMatchObject({ name: 'ok', expressionText: 'status == 200' });
  });

  it('treats secret as a keyword only as the first word', () => {
    const captures = firstRequest(
      '# @capture secret = body.a',
      '# @capture secret secret2 = body.b',
      '# @capture secret_x = body.c',
      '# @capture secret secret = body.d',
      request,
    ).captures;

    expect(captures.map(({ secret, name }) => ({ secret, name }))).toEqual([
      { secret: false, name: 'secret' },
      { secret: true, name: 'secret2' },
      { secret: false, name: 'secret_x' },
      { secret: true, name: 'secret' },
    ]);
  });

  it('lists the captures of a request in source order and leaves other requests alone', () => {
    const file = parse(
      '# @capture a = body.a',
      '# @expect status == 200',
      '# @capture b = body.b',
      request,
      '',
      '###',
      '# @capture c = body.c',
      request,
      '',
      '###',
      request,
    );

    expect(file.requests.map((found) => found.captures.map((capture) => capture.name))).toEqual([
      ['a', 'b'],
      ['c'],
      [],
    ]);
    expect(file.diagnostics).toEqual([]);
  });

  it('does not read a directive after the request line as a capture', () => {
    const found = firstRequest(request, '# @capture a = body.a');

    expect(found.captures).toEqual([]);
  });

  it('keeps the whole parse of a capture equal between CRLF and LF', () => {
    const content = ['# @capture secret a = body.a', '# @capture b = first(x == 1).y', request];

    expect(parseHttpFile(content.join('\r\n'))).toEqual(parseHttpFile(content.join('\n')));
  });

  it('keeps the invalid-capture message for lines that are not [secret] name = expression', () => {
    const message = 'Expected "# @capture [secret] name = expression".';
    const lines = [
      '# @capture',
      '# @capture id',
      '# @capture id =',
      '# @capture = body.id',
      '# @capture 1id = body.id',
      '# @capture secret',
      '# @capture secret id',
      '# @capture secret = ',
      '# @capture my-id = body.id',
    ];

    for (const line of lines) {
      const file = parse(line, request);

      expect(
        file.diagnostics.map(({ code, message: text }) => ({ code, text })),
        line,
      ).toEqual([{ code: 'invalid-capture', text: message }]);
      expect(file.requests[0]?.captures, line).toEqual([]);
    }
  });

  it('reports an invalid capture over its argument, or the whole line when there is none', () => {
    expect(only('invalid-capture', '# @capture id =', request)?.range).toEqual(at(0, 11, 15));
    expect(only('invalid-capture', '# @capture', request)?.range).toEqual(at(0, 0, 10));
  });
});

describe('parseHttpFile capture expressions', () => {
  it('keeps the error of the expression at its exact column', () => {
    const line = '# @capture id = first(type == "x"';
    const found = firstRequest(line, request);

    expect(parse(line, request).diagnostics).toEqual([
      {
        code: 'invalid-expression',
        message: 'Expected ")".',
        severity: 'error',
        range: at(0, line.length, line.length),
      },
    ]);
    expect(found.captures).toHaveLength(1);
    expect(found.captures[0]).toMatchObject({
      name: 'id',
      expressionText: 'first(type == "x"',
      expressionRange: at(0, 16, line.length),
      expression: undefined,
    });
  });

  it('maps the span of an error in the middle of the expression', () => {
    const line = '# @capture id = body.items[0] == = 2';
    const diagnostic = only('invalid-expression', line, request);

    expect(diagnostic).toMatchObject({
      message: 'Unexpected `=`.',
      severity: 'error',
      range: at(0, column(line, '= 2'), column(line, '= 2') + 1),
    });
  });

  it('maps an error after a tab and a secret keyword', () => {
    const line = '# @capture\tsecret\ttoken\t=\tbody..x';
    const diagnostic = only('invalid-expression', line, request);

    expect(diagnostic?.range.start.character).toBeGreaterThan(column(line, 'body'));
    expect(diagnostic?.range.end.character).toBeLessThanOrEqual(line.length);
    expect(diagnostic?.range.start.line).toBe(0);
  });

  it('reports the line of each directive', () => {
    const found = parse(
      '# @capture a = body.a',
      '# @capture b = status ==',
      '# @capture c = body.c',
      request,
    );

    expect(found.diagnostics).toEqual([
      expect.objectContaining({
        code: 'invalid-expression',
        range: at(1, 24, 24),
        message: 'Unexpected end of the expression.',
      }),
    ]);
    expect(found.requests[0]?.captures.map((capture) => capture.expression === undefined)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it('reports a check that is only valid in # @expect', () => {
    const line = '# @capture a = exists(body.x)';
    const diagnostic = only('invalid-expression', line, request);

    expect(diagnostic).toMatchObject({
      message: 'exists(…) is only available in # @expect.',
      range: at(0, 15, line.length),
    });
  });

  it('reports a regular expression that cannot run', () => {
    const line = String.raw`# @capture a = body.name | match(/(a)\1/)`;
    const diagnostic = only('invalid-expression', line, request);

    expect(diagnostic?.severity).toBe('error');
    expect(diagnostic?.range.start.character).toBeGreaterThan(column(line, '/('));
    expect(diagnostic?.range.end.character).toBeLessThanOrEqual(line.length);
  });

  it('reports an expression longer than 4,096 characters over all of it', () => {
    const expression = `body${'.a'.repeat(2049)}`;
    const line = `# @capture a = ${expression}`;
    const diagnostic = only('invalid-expression', line, request);

    expect(diagnostic).toMatchObject({
      message: 'An expression is at most 4,096 characters.',
      range: at(0, 15, 15 + expression.length),
    });
  });
});

describe('parseHttpFile capture names', () => {
  it('reports a name used twice on one request on the second', () => {
    const found = parse(
      '# @capture threadId = first(type == "RUN_STARTED").threadId',
      '# @capture runId = body.id',
      '# @capture threadId = last(type == "RUN_FINISHED").threadId',
      request,
    );

    expect(found.diagnostics).toEqual([
      {
        code: 'duplicate-capture',
        message: 'threadId is captured twice on this request.',
        severity: 'error',
        range: at(2, 11, 19),
      },
    ]);
    expect(found.requests[0]?.captures.map((capture) => capture.name)).toEqual([
      'threadId',
      'runId',
      'threadId',
    ]);
  });

  it('reports every later use of the name', () => {
    const found = parse(
      '# @capture a = body.a',
      '# @capture a = body.b',
      '# @capture a = body.c',
      request,
    );

    expect(found.diagnostics.map(({ code, range }) => ({ code, range }))).toEqual([
      { code: 'duplicate-capture', range: at(1, 11, 12) },
      { code: 'duplicate-capture', range: at(2, 11, 12) },
    ]);
  });

  it('counts a secret capture and a plain capture of the same name as duplicates', () => {
    const found = parse('# @capture token = body.a', '# @capture secret token = body.b', request);

    expect(found.diagnostics).toEqual([
      expect.objectContaining({
        code: 'duplicate-capture',
        message: 'token is captured twice on this request.',
        range: at(1, 18, 23),
      }),
    ]);
  });

  it('allows the same name on different requests', () => {
    const found = parse(
      '# @capture id = body.a',
      request,
      '',
      '###',
      '# @capture id = body.b',
      request,
    );

    expect(found.diagnostics).toEqual([]);
  });

  it('treats names that differ in case as different', () => {
    const found = parse('# @capture id = body.a', '# @capture Id = body.b', request);

    expect(found.diagnostics).toEqual([]);
  });

  it('reports the name and the expression of one line separately', () => {
    const found = parse('# @capture a = body.a', '# @capture a = status ==', request);

    expect(found.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'duplicate-capture',
      'invalid-expression',
    ]);
  });
});

describe('parseHttpFile capture limits', () => {
  function capturesOf(count: number): string[] {
    return Array.from({ length: count }, (_, index) => `# @capture c${String(index)} = body.a`);
  }

  it('allows 64 captures on one request', () => {
    const found = parse(...capturesOf(64), request);

    expect(found.diagnostics).toEqual([]);
    expect(found.requests[0]?.captures).toHaveLength(64);
  });

  it('reports a 65th capture as an error on its line', () => {
    const lines = capturesOf(65);
    const found = parse(...lines, request);

    expect(found.diagnostics).toEqual([
      {
        code: 'too-many-captures',
        message: 'A request can have at most 64 captures.',
        severity: 'error',
        range: at(64, 0, lines[64]?.length ?? 0),
      },
    ]);
    expect(found.requests[0]?.captures).toHaveLength(64);
  });

  it('reports the limit once, however many captures follow', () => {
    const found = parse(...capturesOf(200), request);

    expect(found.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['too-many-captures']);
    expect(found.requests[0]?.captures).toHaveLength(64);
  });

  it('counts the lines of a request, not its valid captures', () => {
    const lines = [
      ...capturesOf(60),
      '# @capture',
      '# @capture x',
      '# @capture y =',
      '# @capture z',
      '# @capture w',
    ];
    const found = parse(...lines, request);

    expect(found.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'invalid-capture',
      'invalid-capture',
      'invalid-capture',
      'invalid-capture',
      'too-many-captures',
    ]);
    expect(found.diagnostics.at(-1)?.range).toEqual(at(64, 0, lines[64]?.length ?? 0));
    expect(found.requests[0]?.captures).toHaveLength(60);
  });

  it('counts each request on its own', () => {
    const found = parse(...capturesOf(64), request, '', '###', ...capturesOf(64), request);

    expect(found.diagnostics).toEqual([]);
  });

  it('does not parse the expressions beyond the limit', () => {
    const lines = [
      ...capturesOf(64),
      ...Array.from({ length: 5000 }, () => `# @capture x = ${'('.repeat(70)}`),
    ];
    const started = performance.now();
    const found = parse(...lines, request);

    expect(performance.now() - started).toBeLessThan(200);
    expect(found.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['too-many-captures']);
  });
});

describe('parseHttpFile jsonpath() queries', () => {
  it('accepts a valid query', () => {
    expect(
      parse('# @capture a = jsonpath("$.items[?@.id == 1].name")', request).diagnostics,
    ).toEqual([]);
  });

  it('reports a syntax error at the offset inside the string literal', () => {
    const line = '# @capture a = jsonpath("$.a b")';
    const query = '$.a b';
    const offset = checkJsonPath(query)?.offset ?? -1;
    const start = column(line, query) + offset;

    expect(only('invalid-expression', line, request)).toEqual({
      code: 'invalid-expression',
      message: 'Unexpected `b` in the JSONPath.',
      severity: 'error',
      range: at(0, start, start + 1),
    });
  });

  it('works in a single-quoted string', () => {
    const line = "# @capture a = jsonpath('$.a b')";
    const start = column(line, 'b');

    expect(only('invalid-expression', line, request)?.range).toEqual(at(0, start, start + 1));
  });

  it('reports a query that ends unexpectedly over the closing quote', () => {
    const line = '# @capture a = jsonpath("$.items[")';
    const diagnostic = only('invalid-expression', line, request);
    const quote = line.lastIndexOf('"');

    expect(diagnostic).toMatchObject({
      message: 'The JSONPath ends unexpectedly.',
      range: at(0, quote, quote + 1),
    });
  });

  it('reports an unknown function', () => {
    const line = '# @capture a = jsonpath("$[?lenght(@.a)==1]")';
    const diagnostic = only('invalid-expression', line, request);
    const start = column(line, 'lenght');

    expect(diagnostic?.message).toContain('Unknown function `lenght`');
    expect(diagnostic?.range).toEqual(at(0, start, start + 1));
  });

  it('reports a pattern that cannot run at the pattern', () => {
    const line = '# @capture a = jsonpath("$[?search(@.a, \'(?<=a)b\')]")';
    const diagnostic = only('invalid-expression', line, request);

    expect(diagnostic?.range.start.character).toBe(column(line, "'(?<=a)b'"));
  });

  it('reports a query over 384 characters at the 385th', () => {
    const query = `$${'.a'.repeat(192)}`;
    const line = `# @capture a = jsonpath("${query}")`;
    const start = column(line, query) + 384;

    expect(query).toHaveLength(385);
    expect(only('invalid-expression', line, request)).toMatchObject({
      message: 'the query is longer than 384 characters',
      range: at(0, start, start + 1),
    });
  });

  it('spans the whole literal when the query has an escape', () => {
    const line = '# @capture a = jsonpath("\\u0024.a b")';
    const open = column(line, '"');

    expect(only('invalid-expression', line, request)).toMatchObject({
      message: 'Unexpected `b` in the JSONPath.',
      range: at(0, open, line.lastIndexOf('"') + 1),
    });
  });

  it('does not mistake a backslash in a query for an escape-free literal', () => {
    const line = String.raw`# @capture a = jsonpath("$['a\\b'] c")`;
    const found = parse(line, request).diagnostics;

    expect(found).toHaveLength(1);
    expect(found[0]?.range).toEqual(at(0, column(line, '"'), line.lastIndexOf('"') + 1));
  });

  it('maps an offset past an astral character in an escape-free literal', () => {
    const line = '# @capture a = jsonpath("$[\'\u{1F600}\'] x")';
    const diagnostic = only('invalid-expression', line, request);
    const start = column(line, ' x') + 1;

    expect(diagnostic?.range).toEqual(at(0, start, start + 1));
  });

  it('checks the query inside a larger expression', () => {
    const line = '# @capture a = jsonpath("$.a") | default(jsonpath("$.b c"))';
    const found = parse(line, request).diagnostics;

    expect(found.map((diagnostic) => diagnostic.code)).toEqual(['invalid-expression']);
  });

  it('checks every query in an expression', () => {
    const line = '# @capture a = jsonpath("$.a b") == jsonpath("$.c d")';
    const found = parse(line, request).diagnostics;

    expect(found.map((diagnostic) => diagnostic.range.start.character)).toEqual([
      column(line, 'b"'),
      column(line, 'd"'),
    ]);
  });

  it('reports a JSONPath problem in # @expect too', () => {
    const line = '# @expect jsonpath("$.a b") == 1';
    const found = parse(line, request).diagnostics;

    expect(found.map((diagnostic) => diagnostic.range.start.character)).toEqual([
      column(line, 'b"'),
    ]);
  });

  it('does not check a query of an expression that does not parse', () => {
    const found = parse('# @capture a = jsonpath("$.a b") ==', request).diagnostics;

    expect(found.map((diagnostic) => diagnostic.message)).toEqual([
      'Unexpected end of the expression.',
    ]);
  });
});

describe('parseHttpFile # @expect and # @until', () => {
  it('accepts valid arguments without storing them', () => {
    const found = firstRequest(
      '# @capture id = body.id',
      '# @expect status == 201 && exists(body.id)',
      '# @expect before(type == "A", type == "B")',
      '# @until type == "RUN_FINISHED"',
      request,
    );

    expect(
      parse(...['# @expect status == 201', '# @until type == "x"'], request).diagnostics,
    ).toEqual([]);
    expect(found.captures.map((capture) => capture.name)).toEqual(['id']);
    expect(Object.keys(found).sort()).toEqual([
      'body',
      'captures',
      'directives',
      'headers',
      'name',
      'range',
      'requestLine',
      'title',
      'variableReferences',
    ]);
    expect(found.directives.map((directive) => directive.kind)).toEqual([
      'capture',
      'expect',
      'expect',
      'until',
    ]);
  });

  it('checks an # @expect argument in the expect context', () => {
    const line = '# @expect status ==';
    const diagnostic = only('invalid-expression', line, request);

    expect(diagnostic).toEqual({
      code: 'invalid-expression',
      message: 'Unexpected end of the expression.',
      severity: 'error',
      range: at(0, line.length, line.length),
    });
  });

  it('allows a check in # @expect but not in # @until', () => {
    const check = 'before(type == "A", type == "B")';
    const until = `# @until ${check}`;

    expect(parse(`# @expect ${check}`, request).diagnostics).toEqual([]);
    expect(only('invalid-expression', until, request)).toMatchObject({
      message: 'Unexpected `(`.',
      range: at(0, column(until, '('), column(until, '(') + 1),
    });
  });

  it('reads a bare word in # @until as a field of the event', () => {
    expect(parse('# @until done', request).diagnostics).toEqual([]);
    expect(parse('# @until body == 1 && status != 2', request).diagnostics).toEqual([]);
  });

  it('reports an error in # @until at its column', () => {
    const line = '# @until type == "RUN_FINISHED" &&';
    const diagnostic = only('invalid-expression', line, request);

    expect(diagnostic?.range).toEqual(at(0, line.length, line.length));
  });

  it('allows @ and @sse in # @until but not in # @expect outside a condition', () => {
    expect(parse('# @until @sse.event == "done"', request).diagnostics).toEqual([]);
    expect(only('invalid-expression', '# @expect @ == 1', request)?.message).toBe(
      '`@` is only available inside a condition.',
    );
  });

  it('keeps the empty checks', () => {
    expect(only('empty-expect', '# @expect', request)?.range).toEqual(at(0, 0, 9));
    expect(only('empty-until', '# @until', request)?.range).toEqual(at(0, 0, 8));
  });

  it('does not count them against the capture limit or the names', () => {
    const lines = [
      ...Array.from({ length: 64 }, (_, index) => `# @capture c${String(index)} = body.a`),
      ...Array.from({ length: 10 }, () => '# @expect status == 200'),
      '# @until done',
    ];

    expect(parse(...lines, request).diagnostics).toEqual([]);
  });
});

describe('parseHttpFile capture parsing speed', () => {
  function maximalQuery(index: number): string {
    const unit = `match(@.a, 'a+b${String(index)}')`;
    const terms: string[] = [];
    let length = '$[?]'.length;
    while (length + unit.length + 4 <= 384) {
      terms.push(unit);
      length += unit.length + 4;
    }
    return `$[?${terms.join(' || ')}]`;
  }

  const lines = Array.from(
    { length: 64 },
    (_, index) => `# @capture c${String(index)} = jsonpath("${maximalQuery(index)}")`,
  );
  const content = [...lines, request].join('\n');

  it('uses queries of the maximal length, valid and distinct', () => {
    const queries = lines.map((_, index) => maximalQuery(index));

    expect(new Set(queries).size).toBe(64);
    for (const query of queries) {
      expect(query.length).toBeGreaterThan(340);
      expect(query.length).toBeLessThanOrEqual(384);
      expect(checkJsonPath(query)).toBeUndefined();
    }
  });

  it('parses 64 captures with maximal jsonpath() queries in under 100 ms the second time', () => {
    const first = parseHttpFile(content);
    const started = performance.now();
    const second = parseHttpFile(content);
    const elapsed = performance.now() - started;

    expect(first.diagnostics).toEqual([]);
    expect(second.requests[0]?.captures).toHaveLength(64);
    expect(second.diagnostics).toEqual([]);
    expect(elapsed).toBeLessThan(100);
  });
});
