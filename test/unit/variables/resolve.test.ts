import { describe, expect, it } from 'vitest';
import { parseHttpFile } from '../../../src/http-file/parse';
import { resolveRequest, type Resolution } from '../../../src/variables/resolve';
import type { SystemContext } from '../../../src/variables/system';

function counter(): SystemContext {
  let next = 0;
  return {
    now: () => new Date('2026-11-11T10:20:30.456Z'),
    uuid: () => {
      next += 1;
      return `uuid-${String(next)}`;
    },
    randomInt: (minInclusive) => minInclusive,
  };
}

function resolve(...lines: string[]): Resolution {
  const file = parseHttpFile(lines.join('\n'));
  const request = file.requests[0];
  if (!request) {
    throw new Error('expected a request');
  }
  return resolveRequest(file, request, counter());
}

function resolved(...lines: string[]) {
  const result = resolve(...lines);
  if (!result.ok) {
    throw new Error(result.problems.map((problem) => problem.message).join('\n'));
  }
  return result;
}

function problems(...lines: string[]) {
  const result = resolve(...lines);
  if (result.ok) {
    throw new Error('expected problems');
  }
  return result.problems;
}

function at(line: number, start: number, end: number) {
  return { start: { line, character: start }, end: { line, character: end } };
}

describe('resolveRequest', () => {
  it('resolves file variables in the url, header names and values, and body text', () => {
    const { request } = resolved(
      '@host = api.example.test',
      '@header = X-Trace',
      '@token = synthetic-token',
      '@name = Ada',
      'POST https://{{host}}/items',
      '{{header}}: {{token}}',
      '',
      '{"name": "{{name}}"}',
    );

    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://api.example.test/items');
    expect(request.urlRange).toEqual(at(4, 5, 27));
    expect(request.headers).toEqual([{ name: 'X-Trace', value: 'synthetic-token' }]);
    expect(request.body).toEqual([{ kind: 'text', lines: ['{"name": "Ada"}'] }]);
  });

  it('unescapes \\n, \\r, \\t and other escaped characters in file variable values', () => {
    const { request } = resolved(
      String.raw`@text = a\nb\tc\\d\qe\rf`,
      'POST https://api.example.test/items',
      '',
      '{{text}}',
    );

    expect(request.body).toEqual([{ kind: 'text', lines: ['a\nb\tc\\dqe\rf'] }]);
  });

  it('uses the last definition of a file variable', () => {
    const { request } = resolved(
      '@host = first.example.test',
      'GET https://{{host}}/items',
      '',
      '###',
      '@host = second.example.test',
    );

    expect(request.url).toBe('https://second.example.test/items');
  });

  it('resolves file variables that refer to later file variables and to system variables', () => {
    const { request } = resolved(
      '@base = https://{{host}}/v{{$randomInt 1 3}}',
      '@host = api.example.test',
      'GET {{base}}/items',
    );

    expect(request.url).toBe('https://api.example.test/v1/items');
  });

  it('evaluates a system variable inside a file variable once per send', () => {
    const { request } = resolved(
      '@id = {{$guid}}',
      'GET https://api.example.test/items/{{id}}',
      'X-Id: {{id}}',
    );

    expect(request.url).toBe('https://api.example.test/items/uuid-1');
    expect(request.headers).toEqual([{ name: 'X-Id', value: 'uuid-1' }]);
  });

  it('evaluates each system variable in the request separately', () => {
    const { request } = resolved('GET https://api.example.test/items/{{$guid}}', 'X-Id: {{$guid}}');

    expect(request.url).toBe('https://api.example.test/items/uuid-1');
    expect(request.headers).toEqual([{ name: 'X-Id', value: 'uuid-2' }]);
  });

  it('trims whitespace inside braces', () => {
    const { request } = resolved('@host = api.example.test', 'GET https://{{  host }}/items');

    expect(request.url).toBe('https://api.example.test/items');
  });

  it('does not re-scan inserted values', () => {
    const { request } = resolved(
      '@open = {{',
      '@raw = {{open}}host}}',
      '@host = api.example.test',
      'POST https://api.example.test/items',
      '',
      '{{raw}}',
    );

    expect(request.body).toEqual([{ kind: 'text', lines: ['{{host}}'] }]);
  });

  it('reports an undefined variable at every place it is used', () => {
    expect(problems('GET https://{{host}}/items', 'X-Host: {{host}}')).toEqual([
      { message: '`{{host}}` is not defined.', range: at(0, 12, 20) },
      { message: '`{{host}}` is not defined.', range: at(1, 8, 16) },
    ]);
  });

  it('reports an undefined variable inside a file variable at its value', () => {
    expect(problems('@base = https://{{host}}', 'GET {{base}}/items', 'X-Base: {{base}}')).toEqual([
      { message: '`{{host}}` is not defined.', range: at(0, 8, 24) },
    ]);
  });

  it('reports file variables that refer to each other', () => {
    expect(problems('@a = {{b}}', '@b = {{a}}', 'GET https://api.example.test/{{a}}')).toEqual([
      { message: '`{{a}}` and `{{b}}` refer to each other.', range: at(0, 5, 10) },
    ]);
  });

  it('reports a file variable that refers to itself', () => {
    expect(problems('@a = x{{a}}', 'GET https://api.example.test/{{a}}')).toEqual([
      { message: '`{{a}}` refers to itself.', range: at(0, 5, 11) },
    ]);
  });

  it('reports request references as not supported yet', () => {
    expect(problems('GET https://api.example.test/{{login.response.body.$.token}}')).toEqual([
      {
        message:
          'Request references such as `{{login.response.body.$.token}}` are not supported yet.',
        range: at(0, 29, 60),
      },
    ]);
  });

  it('reports system variable problems where they are used', () => {
    expect(problems('GET https://api.example.test/{{$processEnv HOME}}')).toEqual([
      { message: '`{{$processEnv HOME}}` is not supported yet.', range: at(0, 29, 49) },
    ]);
  });

  it('resolves variables in body file paths and keeps the file part', () => {
    const { request } = resolved(
      '@dir = fixtures',
      'POST https://api.example.test/upload',
      '',
      '<@latin1 ./{{dir}}/payload.json',
    );

    expect(request.body).toEqual([
      {
        kind: 'file',
        path: './fixtures/payload.json',
        processVariables: true,
        encoding: 'latin1',
        pathRange: at(3, 9, 31),
      },
    ]);
  });

  it('scope.resolveText resolves file and system variables in file contents', () => {
    const { scope } = resolved('@name = Ada', 'POST https://api.example.test/items');

    expect(scope.resolveText('{"name": "{{name}}",\n"id": "{{$guid}}"}')).toEqual({
      ok: true,
      text: '{"name": "Ada",\n"id": "uuid-1"}',
    });
    expect(scope.resolveText('{{missing}}')).toEqual({
      ok: false,
      messages: ['`{{missing}}` is not defined.'],
    });
  });
});
