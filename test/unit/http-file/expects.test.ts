import { describe, expect, it } from 'vitest';
import { parseHttpFile } from '../../../src/http-file/parse';

function requestOf(lines: readonly string[], index = 0) {
  const request = parseHttpFile(lines.join('\n')).requests[index];
  if (request === undefined) {
    throw new Error(`no request ${String(index)}`);
  }
  return request;
}

describe('expects', () => {
  it('lists each expect of a request with its text, ranges and expression', () => {
    const request = requestOf([
      '### Start',
      '# @name startRun',
      '# @expect status == 200',
      '// @expect count(type == "A") > 2',
      'POST https://example.test/run',
    ]);

    expect(
      request.expects.map(({ text, range, expressionRange }) => ({ text, range, expressionRange })),
    ).toEqual([
      {
        text: 'status == 200',
        range: { start: { line: 2, character: 0 }, end: { line: 2, character: 23 } },
        expressionRange: { start: { line: 2, character: 10 }, end: { line: 2, character: 23 } },
      },
      {
        text: 'count(type == "A") > 2',
        range: { start: { line: 3, character: 0 }, end: { line: 3, character: 33 } },
        expressionRange: { start: { line: 3, character: 11 }, end: { line: 3, character: 33 } },
      },
    ]);
    expect(request.expects.map(({ expression }) => expression?.kind)).toEqual([
      'compare',
      'compare',
    ]);
  });

  it('keeps an expect with a syntax error, without an expression', () => {
    const file = parseHttpFile(
      ['# @expect status ==', '# @expect', 'GET https://example.test/a'].join('\n'),
    );

    expect(file.requests[0]?.expects.map(({ text, expression }) => [text, expression])).toEqual([
      ['status ==', undefined],
    ]);
    expect(file.diagnostics.map(({ code }) => code)).toEqual([
      'invalid-expression',
      'empty-expect',
    ]);
  });

  it('reports the 65th expect of a request', () => {
    const lines = [
      ...Array.from({ length: 66 }, (_, at) => `# @expect status == ${String(200 + at)}`),
      'GET https://example.test/a',
    ];
    const file = parseHttpFile(lines.join('\n'));

    expect(file.requests[0]?.expects).toHaveLength(64);
    expect(file.diagnostics).toEqual([
      {
        code: 'too-many-expects',
        message: 'A request can have at most 64 checks.',
        severity: 'error',
        range: { start: { line: 64, character: 0 }, end: { line: 64, character: 23 } },
      },
    ]);
  });

  it('gives requests without expects an empty list', () => {
    expect(requestOf(['GET https://example.test/a']).expects).toEqual([]);
    expect(
      requestOf(
        [
          '# @expect status == 200',
          'GET https://example.test/a',
          '',
          '###',
          'GET https://example.test/b',
        ],
        1,
      ).expects,
    ).toEqual([]);
  });
});
