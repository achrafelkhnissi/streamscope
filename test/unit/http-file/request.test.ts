import { describe, expect, it } from 'vitest';
import { parseHttpFile } from '../../../src/http-file/parse';

function firstRequest(...content: string[]) {
  const request = parseHttpFile(content.join('\n')).requests[0];
  if (!request) {
    throw new Error('expected a request');
  }
  return request;
}

function at(line: number, start: number, end: number) {
  return { start: { line, character: start }, end: { line, character: end } };
}

describe('parseHttpFile request content', () => {
  it('defaults the method to GET', () => {
    const { requestLine } = firstRequest('https://api.example.test/items');

    expect(requestLine.method).toBe('GET');
    expect(requestLine.methodRange).toBeUndefined();
    expect(requestLine.url).toBe('https://api.example.test/items');
  });

  it('reads method, url and http version', () => {
    const { requestLine } = firstRequest('post https://api.example.test/items HTTP/1.1');

    expect(requestLine.method).toBe('post');
    expect(requestLine.methodRange).toEqual(at(0, 0, 4));
    expect(requestLine.url).toBe('https://api.example.test/items');
    expect(requestLine.urlRanges).toEqual([at(0, 5, 35)]);
    expect(requestLine.httpVersion).toBe('HTTP/1.1');
  });

  it('joins query continuation lines', () => {
    const { requestLine } = firstRequest(
      'GET https://api.example.test/search',
      '  ?q=stream',
      '  &limit=10',
    );

    expect(requestLine.url).toBe('https://api.example.test/search?q=stream&limit=10');
    expect(requestLine.urlRanges).toEqual([at(0, 4, 35), at(1, 2, 11), at(2, 2, 11)]);
  });

  it('splits headers at the first colon', () => {
    const { headers } = firstRequest(
      'GET https://api.example.test/me',
      'Authorization: Bearer {{token}}',
      'X-Time: 12:30',
    );

    expect(headers).toEqual([
      expect.objectContaining({
        name: 'Authorization',
        value: 'Bearer {{token}}',
        nameRange: at(1, 0, 13),
        valueRange: at(1, 15, 31),
      }),
      expect.objectContaining({ name: 'X-Time', value: '12:30' }),
    ]);
  });

  it('keeps a header without a colon as an empty-valued header', () => {
    const { headers } = firstRequest('GET https://api.example.test/me', 'X-Flag');

    expect(headers).toEqual([expect.objectContaining({ name: 'X-Flag', value: '' })]);
  });

  it('drops comment lines from headers and body, like REST Client', () => {
    const { headers, body } = firstRequest(
      'POST https://api.example.test/items',
      'Content-Type: application/json',
      '# Accept: text/plain',
      '',
      '{',
      '  "name": "streamscope",',
      '  // "debug": true,',
      '  "count": 1',
      '}',
    );

    expect(headers.map((header) => header.name)).toEqual(['Content-Type']);
    expect(body).toEqual([
      expect.objectContaining({
        kind: 'text',
        lines: ['{', '  "name": "streamscope",', '  "count": 1', '}'],
      }),
    ]);
  });

  it('reads file parts', () => {
    const { body } = firstRequest(
      'POST https://api.example.test/upload',
      '',
      '< ./payload.json',
      '<@ ./template.json',
      '<@latin1 ./legacy.txt',
    );

    expect(body).toEqual([
      expect.objectContaining({
        kind: 'file',
        path: './payload.json',
        processVariables: false,
        encoding: undefined,
        pathRange: at(2, 2, 16),
      }),
      expect.objectContaining({
        kind: 'file',
        path: './template.json',
        processVariables: true,
        encoding: undefined,
      }),
      expect.objectContaining({
        kind: 'file',
        path: './legacy.txt',
        processVariables: true,
        encoding: 'latin1',
      }),
    ]);
  });

  it('mixes text and file parts in order', () => {
    const { body } = firstRequest(
      'POST https://api.example.test/upload',
      '',
      'first line',
      '< ./middle.bin',
      'last line',
    );

    expect(body.map((part) => part.kind)).toEqual(['text', 'file', 'text']);
  });

  it('reports references inside body file paths', () => {
    const { variableReferences } = firstRequest(
      'POST https://api.example.test/upload',
      '',
      '< ./{{dir}}/payload.json',
    );

    expect(variableReferences).toEqual([{ expression: 'dir', range: at(2, 4, 11) }]);
  });

  it('has no body without a blank line after the headers', () => {
    const { headers, body } = firstRequest(
      'GET https://api.example.test/me',
      'Accept: application/json',
    );

    expect(headers).toHaveLength(1);
    expect(body).toEqual([]);
  });
});
