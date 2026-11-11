import { describe, expect, it } from 'vitest';
import type { HttpFile } from '../../../src/http-file/model';
import { parseHttpFile } from '../../../src/http-file/parse';

interface ExpectedRequest {
  name?: string;
  method: string;
  url: string;
  httpVersion?: string;
  headers?: [string, string][];
  body?: string[];
}

interface CorpusCase {
  title: string;
  file: string[];
  requests: ExpectedRequest[];
}

function summarize(file: HttpFile): ExpectedRequest[] {
  return file.requests.map((request) => ({
    ...(request.name === undefined ? {} : { name: request.name }),
    method: request.requestLine.method,
    url: request.requestLine.url,
    ...(request.requestLine.httpVersion === undefined
      ? {}
      : { httpVersion: request.requestLine.httpVersion }),
    headers: request.headers.map((header): [string, string] => [header.name, header.value]),
    body: request.body.map((part) =>
      part.kind === 'text' ? part.lines.join('\n') : `< ${part.path}`,
    ),
  }));
}

function withDefaults(request: ExpectedRequest): ExpectedRequest {
  return { headers: [], body: [], ...request };
}

const corpus: CorpusCase[] = [
  {
    title: 'a single request needs no separator',
    file: ['GET https://api.example.test/items'],
    requests: [{ method: 'GET', url: 'https://api.example.test/items' }],
  },
  {
    title: 'comment lines are ignored in every section',
    file: [
      '# leading comment',
      '// another one',
      'POST https://api.example.test/items',
      '# between request line and headers',
      'Content-Type: application/json',
      '// between headers',
      '',
      '{',
      '# inside the body',
      '  "a": 1',
      '}',
    ],
    requests: [
      {
        method: 'POST',
        url: 'https://api.example.test/items',
        headers: [['Content-Type', 'application/json']],
        body: ['{\n  "a": 1\n}'],
      },
    ],
  },
  {
    title: 'file variable lines before the request line are skipped',
    file: ['@host = api.example.test', 'GET https://{{host}}/items'],
    requests: [{ method: 'GET', url: 'https://{{host}}/items' }],
  },
  {
    title: 'query continuation lines join the url and the version is stripped',
    file: ['GET https://api.example.test/search', '  ?q=stream', '  &limit=10 HTTP/1.1'],
    requests: [
      {
        method: 'GET',
        url: 'https://api.example.test/search?q=stream&limit=10',
        httpVersion: 'HTTP/1.1',
      },
    ],
  },
  {
    title: 'the method keeps its spelling and defaults to GET',
    file: ['patch https://api.example.test/a', '', '###', 'https://api.example.test/b'],
    requests: [
      { method: 'patch', url: 'https://api.example.test/a' },
      { method: 'GET', url: 'https://api.example.test/b' },
    ],
  },
  {
    title: 'a header without a colon has an empty value',
    file: ['GET https://api.example.test/a', 'X-Flag', 'X-Time: 12:30'],
    requests: [
      {
        method: 'GET',
        url: 'https://api.example.test/a',
        headers: [
          ['X-Flag', ''],
          ['X-Time', '12:30'],
        ],
      },
    ],
  },
  {
    title: 'a blank line right after the request line starts the body',
    file: ['POST https://api.example.test/a', '', 'raw body'],
    requests: [{ method: 'POST', url: 'https://api.example.test/a', body: ['raw body'] }],
  },
  {
    title: 'trailing blank lines are not part of the body',
    file: ['POST https://api.example.test/a', '', 'line one', '', 'line three', '', ''],
    requests: [
      { method: 'POST', url: 'https://api.example.test/a', body: ['line one\n\nline three'] },
    ],
  },
  {
    title: 'body file references keep their order with text',
    file: ['POST https://api.example.test/a', '', 'intro', '< ./part.bin', 'outro'],
    requests: [
      {
        method: 'POST',
        url: 'https://api.example.test/a',
        body: ['intro', '< ./part.bin', 'outro'],
      },
    ],
  },
  {
    title: 'the last # @name wins',
    file: ['# @name first', '# @name second', 'GET https://api.example.test/a'],
    requests: [{ name: 'second', method: 'GET', url: 'https://api.example.test/a' }],
  },
  {
    title: 'a block that starts with a response status line is not a request',
    file: [
      'GET https://api.example.test/a',
      '',
      '###',
      'HTTP/1.1 200 OK',
      'Content-Type: application/json',
      '',
      '{"a": 1}',
    ],
    requests: [{ method: 'GET', url: 'https://api.example.test/a' }],
  },
];

describe('REST Client compatibility corpus', () => {
  for (const { title, file, requests } of corpus) {
    it(title, () => {
      expect(summarize(parseHttpFile(file.join('\n')))).toEqual(requests.map(withDefaults));
    });
  }
});
