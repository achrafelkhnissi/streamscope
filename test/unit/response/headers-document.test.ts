import { describe, expect, it } from 'vitest';
import { renderHeadersDocument } from '../../../src/response/headers-document';
import { snapshot } from './fixtures';

describe('renderHeadersDocument', () => {
  it('renders a completed run with masked request and response headers', () => {
    expect(renderHeadersDocument(snapshot())).toBe(
      [
        'HTTP/1.1 200 OK',
        'Content-Type: application/json',
        'Set-Cookie: ••••••',
        '',
        '### Request',
        'GET https://api.example.test/items',
        'Authorization: ••••••',
        'Host: api.example.test',
        'Accept-Encoding: gzip, deflate, br, zstd',
        '',
        '### Timing',
        'DNS 3 ms · Connect 12 ms · TLS 20 ms · First byte 45 ms · Total 80 ms',
        'Received 1.2 KB (512 B on the wire)',
        '',
      ].join('\n'),
    );
  });

  it('renders redirect hops', () => {
    const run = snapshot({
      hops: [
        {
          request: {
            method: 'POST',
            url: 'https://user:synthetic@api.example.test/a',
            headers: [],
          },
          status: 307,
          statusText: 'Temporary Redirect',
          location: '/b',
        },
        {
          request: { method: 'POST', url: 'https://api.example.test/b', headers: [] },
          status: 302,
          statusText: 'Found',
          location: '/items',
        },
      ],
      timing: { firstByteMs: 4, totalMs: 9 },
    });

    expect(renderHeadersDocument(run).split('\n### ').slice(2).join('\n### ')).toBe(
      [
        'Redirects',
        'POST https://user:••••••@api.example.test/a → 307 Temporary Redirect',
        'POST https://api.example.test/b → 302 Found',
        '',
        '### Timing',
        'First byte 4 ms · Total 9 ms',
        'Received 1.2 KB (512 B on the wire)',
        '',
      ].join('\n'),
    );
  });

  it('renders a failed run', () => {
    const run = snapshot({
      status: 'failed',
      head: undefined,
      failure: {
        kind: 'refused',
        message: 'Connection refused: nothing is listening at 127.0.0.1:9.',
      },
      sent: { method: 'GET', url: 'http://127.0.0.1:9/', headers: [['Host', '127.0.0.1:9']] },
      timing: { totalMs: 3 },
      wireBytes: 0,
      body: new Uint8Array(),
    });

    expect(renderHeadersDocument(run)).toBe(
      [
        '### Failed',
        'Connection refused: nothing is listening at 127.0.0.1:9.',
        '',
        '### Request',
        'GET http://127.0.0.1:9/',
        'Host: 127.0.0.1:9',
        '',
        '### Timing',
        'Total 3 ms',
        'Received 0 B (0 B on the wire)',
        '',
      ].join('\n'),
    );
  });

  it('renders a run that failed after its head with the failure first', () => {
    const rendered = renderHeadersDocument(
      snapshot({
        status: 'failed',
        failure: { kind: 'premature-close', message: 'The connection closed early.' },
      }),
    );

    expect(
      rendered.startsWith(
        '### Failed\nThe connection closed early.\n\nHTTP/1.1 200 OK\nContent-Type: application/json\n',
      ),
    ).toBe(true);
  });

  it('renders a run cancelled after its head', () => {
    const rendered = renderHeadersDocument(snapshot({ status: 'cancelled' }));

    expect(rendered.startsWith('HTTP/1.1 200 OK\nContent-Type: application/json\n')).toBe(true);
    expect(rendered).toContain('\n### Request\n');
  });

  it('renders a run cancelled before its head', () => {
    expect(
      renderHeadersDocument(
        snapshot({
          status: 'cancelled',
          head: undefined,
          elapsedMs: 2100,
          timing: undefined,
          sent: undefined,
          body: new Uint8Array(),
          wireBytes: 0,
        }),
      ),
    ).toBe(['### Cancelled', 'Cancelled after 2.1 s.', ''].join('\n'));
  });

  it('renders a blocked run with its problems and lines', () => {
    expect(
      renderHeadersDocument(
        snapshot({
          status: 'blocked',
          head: undefined,
          sent: undefined,
          timing: undefined,
          problems: [
            {
              message: '`{{host}}` is not defined.',
              range: { start: { line: 4, character: 4 }, end: { line: 4, character: 12 } },
            },
          ],
        }),
      ),
    ).toBe(['### Not sent', '`{{host}}` is not defined. (line 5)', ''].join('\n'));
  });
});
