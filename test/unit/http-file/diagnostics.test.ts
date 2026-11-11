import { describe, expect, it } from 'vitest';
import type { DiagnosticCode } from '../../../src/http-file/model';
import { parseHttpFile } from '../../../src/http-file/parse';

function at(line: number, start: number, end: number) {
  return { start: { line, character: start }, end: { line, character: end } };
}

function diagnosticsOf(...content: string[]) {
  return parseHttpFile(content.join('\n')).diagnostics;
}

function only(code: DiagnosticCode, ...content: string[]) {
  const found = diagnosticsOf(...content);
  expect(found.map((diagnostic) => diagnostic.code)).toEqual([code]);
  return found[0];
}

describe('parseHttpFile variable references', () => {
  it('records variable references with their ranges', () => {
    const request = parseHttpFile('GET {{baseUrl}}/users/{{ userId }}').requests[0];

    expect(request?.variableReferences).toEqual([
      { expression: 'baseUrl', range: at(0, 4, 15) },
      { expression: 'userId', range: at(0, 22, 34) },
    ]);
  });

  it('collects references from headers and body text', () => {
    const request = parseHttpFile(
      [
        'POST {{baseUrl}}/items',
        'Authorization: Bearer {{token}}',
        '',
        '{"owner": "{{owner}}"}',
      ].join('\n'),
    ).requests[0];

    expect(request?.variableReferences.map((reference) => reference.expression)).toEqual([
      'baseUrl',
      'token',
      'owner',
    ]);
  });

  it('parses a 5,000-line file quickly', () => {
    const content = Array.from({ length: 1000 }, (_, index) =>
      [
        `### Request ${String(index)}`,
        `# @name request_${String(index)}`,
        'POST https://api.example.test/items/{{id}}',
        'Content-Type: application/json',
        '',
        `{"index": ${String(index)}}`,
      ].join('\n'),
    ).join('\n');
    const started = performance.now();
    const file = parseHttpFile(content);
    const elapsed = performance.now() - started;

    expect(file.requests).toHaveLength(1000);
    expect(elapsed).toBeLessThan(200);
  });
});

describe('parseHttpFile diagnostics', () => {
  it('reports an unclosed variable', () => {
    const diagnostic = only('unclosed-variable', 'GET {{baseUrl/users');

    expect(diagnostic).toMatchObject({ severity: 'error', range: at(0, 4, 19) });
  });

  it('reports an empty variable', () => {
    const diagnostic = only('empty-variable', 'GET https://api.example.test/{{ }}');

    expect(diagnostic).toMatchObject({ severity: 'error', range: at(0, 29, 34) });
  });

  it('reports an invalid request name and does not use it', () => {
    const file = parseHttpFile('# @name create-user\nGET https://api.example.test/users');

    expect(file.diagnostics).toEqual([
      expect.objectContaining({ code: 'invalid-name', severity: 'error', range: at(0, 8, 19) }),
    ]);
    expect(file.requests[0]?.name).toBeUndefined();
  });

  it('reports a duplicate request name on the later request', () => {
    const diagnostic = only(
      'duplicate-name',
      '# @name login',
      'POST https://api.example.test/login',
      '',
      '###',
      '# @name login',
      'POST https://api.example.test/login',
    );

    expect(diagnostic).toMatchObject({ severity: 'error', range: at(4, 8, 13) });
  });

  it('reports an invalid capture', () => {
    const diagnostic = only(
      'invalid-capture',
      '# @capture = body.id',
      'GET https://api.example.test/a',
    );

    expect(diagnostic).toMatchObject({ severity: 'error', range: at(0, 11, 20) });
  });

  it('reports an empty expect', () => {
    const diagnostic = only('empty-expect', '# @expect', 'GET https://api.example.test/a');

    expect(diagnostic).toMatchObject({ severity: 'error', range: at(0, 0, 9) });
  });

  it('reports an invalid stream format', () => {
    const diagnostic = only(
      'invalid-stream',
      '# @stream websocket',
      'GET https://api.example.test/a',
    );

    expect(diagnostic).toMatchObject({ severity: 'error', range: at(0, 10, 19) });
  });

  it('reports an invalid timeout', () => {
    const diagnostic = only(
      'invalid-timeout',
      '# @timeout 30 seconds',
      'GET https://api.example.test/a',
    );

    expect(diagnostic).toMatchObject({ severity: 'error', range: at(0, 11, 21) });
  });

  it('reports an empty until', () => {
    const diagnostic = only('empty-until', '# @until', 'GET https://api.example.test/a');

    expect(diagnostic).toMatchObject({ severity: 'error', range: at(0, 0, 8) });
  });

  it('warns about an argument on a flag directive', () => {
    const diagnostic = only(
      'unexpected-argument',
      '# @insecure please',
      'GET https://api.example.test/a',
    );

    expect(diagnostic).toMatchObject({ severity: 'warning', range: at(0, 12, 18) });
  });

  it('warns about a directive after the request line', () => {
    const diagnostic = only(
      'misplaced-directive',
      'GET https://api.example.test/me',
      '# @expect status == 200',
    );

    expect(diagnostic).toMatchObject({ severity: 'warning', range: at(1, 0, 23) });
  });

  it('warns about a header without a colon', () => {
    const diagnostic = only('header-without-colon', 'GET https://api.example.test/me', 'X-Flag');

    expect(diagnostic).toMatchObject({ severity: 'warning', range: at(1, 0, 6) });
  });

  it('warns about directives in a block without a request', () => {
    const diagnostic = only(
      'directives-without-request',
      '# @capture id = body.id',
      '',
      '###',
      'GET https://api.example.test/a',
    );

    expect(diagnostic).toMatchObject({ severity: 'warning', range: at(0, 0, 23) });
  });

  it('accepts valid directives without diagnostics', () => {
    expect(
      diagnosticsOf(
        '# @name createUser',
        '# @capture secret token = body.token',
        '# @capture id = first(type == "RUN_STARTED").threadId',
        '# @expect status == 201',
        '# @stream ndjson',
        '# @timeout 90s',
        '# @until type == "RUN_FINISHED"',
        '# @insecure',
        '# @no-redirect',
        'POST https://api.example.test/users',
      ),
    ).toEqual([]);
  });
});
