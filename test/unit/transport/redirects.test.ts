import { afterEach, describe, expect, it } from 'vitest';
import type { OutgoingRequest } from '../../../src/transport/model';
import { redirectStatuses, redirectTarget } from '../../../src/transport/redirects';
import { startHttpServer, type LocalServer } from '../../support/servers';
import { bytes, headerPairs, send } from './harness';

function request(overrides: Partial<OutgoingRequest> = {}): OutgoingRequest {
  return {
    method: 'POST',
    url: new URL('http://api.example.test/start'),
    headers: [
      ['Authorization', 'Bearer synthetic'],
      ['Proxy-Authorization', 'Basic synthetic'],
      ['Cookie', 'session=synthetic'],
      ['Host', 'api.example.test'],
      ['Content-Type', 'application/json'],
      ['Content-Length', '2'],
      ['Content-Encoding', 'identity'],
      ['Content-Language', 'en'],
      ['Content-Location', '/start'],
      ['Transfer-Encoding', 'chunked'],
      ['X-Trace', '1'],
    ],
    body: [bytes('{}')],
    ...overrides,
  };
}

function target(status: number, location: string, base: OutgoingRequest = request()) {
  const result = redirectTarget(base, status, location);
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.request;
}

function names(next: OutgoingRequest): string[] {
  return next.headers.map(([name]) => name);
}

describe('redirectTarget', () => {
  it('knows the redirect statuses', () => {
    expect([...redirectStatuses].sort()).toEqual([301, 302, 303, 307, 308]);
  });

  it('turns 301, 302 and 303 into GET without a body or body headers', () => {
    for (const status of [301, 302, 303]) {
      const next = target(status, '/next');

      expect(next.method).toBe('GET');
      expect(next.body).toEqual([]);
      expect(names(next)).toEqual([
        'Authorization',
        'Proxy-Authorization',
        'Cookie',
        'Host',
        'X-Trace',
      ]);
    }
  });

  it('keeps HEAD for 301 to 303', () => {
    for (const status of [301, 302, 303]) {
      expect(target(status, '/next', request({ method: 'HEAD', body: [] })).method).toBe('HEAD');
    }
  });

  it('replays method and body for 307 and 308', () => {
    for (const status of [307, 308]) {
      const base = request();
      const next = target(status, '/next', base);

      expect(next.method).toBe('POST');
      expect(next.body).toBe(base.body);
      expect(next.headers).toEqual(base.headers);
    }
  });

  it('resolves relative locations against the current url', () => {
    expect(target(307, 'next?page=2').url.href).toBe('http://api.example.test/next?page=2');
    expect(target(307, '//other.example.test/x').url.href).toBe('http://other.example.test/x');
  });

  it('drops Authorization, Proxy-Authorization, Cookie and a user Host across origins', () => {
    for (const location of [
      'https://api.example.test/start',
      'http://api.example.test:8080/start',
      'http://other.example.test/start',
    ]) {
      expect(names(target(307, location))).toEqual([
        'Content-Type',
        'Content-Length',
        'Content-Encoding',
        'Content-Language',
        'Content-Location',
        'Transfer-Encoding',
        'X-Trace',
      ]);
    }
  });

  it('keeps them within the same origin', () => {
    expect(names(target(307, 'http://api.example.test/other'))).toContain('Authorization');
    expect(names(target(307, 'http://api.example.test/other'))).toContain('Cookie');
  });

  it('rejects locations that are not http or https', () => {
    const result = redirectTarget(request(), 302, 'ftp://files.example.test/a');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('ftp://files.example.test/a');
  });

  it('rejects locations that are not URLs', () => {
    expect(redirectTarget(request(), 302, 'http://[bad').ok).toBe(false);
  });
});

const servers: LocalServer[] = [];

async function server(handler: Parameters<typeof startHttpServer>[0]): Promise<LocalServer> {
  const started = await startHttpServer(handler);
  servers.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((started) => started.close()));
});

describe('NodeTransport redirects', () => {
  it('follows 307 then 302 and records both hops', async () => {
    const local = await server((incoming, response) => {
      const next: Record<string, [number, string]> = {
        '/a': [307, '/b'],
        '/b': [302, '/c'],
      };
      const redirect = next[incoming.url ?? ''];
      if (redirect) {
        response.writeHead(redirect[0], { Location: redirect[1] });
        response.end('ignored redirect body');
        return;
      }
      response.end('final');
    });

    const { outcome, sink } = await send({
      url: `${local.url}/a`,
      method: 'POST',
      body: [bytes('payload')],
    });

    expect(outcome.kind).toBe('completed');
    expect(
      local.requests.map((recorded) => [recorded.method, recorded.url, recorded.body.toString()]),
    ).toEqual([
      ['POST', '/a', 'payload'],
      ['POST', '/b', 'payload'],
      ['GET', '/c', ''],
    ]);
    expect(outcome.hops.map((hop) => [hop.request.method, hop.status, hop.location])).toEqual([
      ['POST', 307, '/b'],
      ['POST', 302, '/c'],
    ]);
    expect(sink.head?.status).toBe(200);
    expect(sink.sent?.url).toBe(`${local.url}/c`);
    expect(sink.body()).toBe('final');
    expect(outcome.wireBytes).toBe(5);
  });

  it('never sends Authorization to another origin', async () => {
    const other = await server((_incoming, response) => {
      response.end('other');
    });
    const first = await server((_incoming, response) => {
      response.writeHead(302, {
        Location: `${other.url.replace('127.0.0.1', 'localhost')}/landing`,
      });
      response.end();
    });

    const { outcome } = await send({
      url: `${first.url}/start`,
      headers: [
        ['Authorization', 'Bearer synthetic'],
        ['Cookie', 'session=synthetic'],
      ],
    });

    expect(outcome.kind).toBe('completed');
    const landed = headerPairs(other.requests[0]?.rawHeaders ?? []).map(([name]) =>
      name.toLowerCase(),
    );
    expect(landed).not.toContain('authorization');
    expect(landed).not.toContain('cookie');
  });

  it('fails with redirect after maxRedirects', async () => {
    const loop = await server((_incoming, response) => {
      response.writeHead(302, { Location: '/again' });
      response.end();
    });

    const { outcome, sink } = await send({ url: loop.url }, { maxRedirects: 3 });

    expect(outcome.kind === 'failed' && outcome.failure.kind).toBe('redirect');
    expect(outcome.kind === 'failed' && outcome.failure.message).toContain('3');
    expect(outcome.hops).toHaveLength(3);
    expect(sink.head).toBeUndefined();
  });

  it('returns the 3xx itself when following is off', async () => {
    const local = await server((_incoming, response) => {
      response.writeHead(302, { Location: '/elsewhere' });
      response.end('moved');
    });

    const { outcome, sink } = await send({ url: local.url }, { followRedirects: false });

    expect(outcome.kind).toBe('completed');
    expect(outcome.hops).toEqual([]);
    expect(sink.head?.status).toBe(302);
    expect(sink.body()).toBe('moved');
  });

  it('treats a 3xx without Location as the response', async () => {
    const local = await server((_incoming, response) => {
      response.writeHead(302);
      response.end('no location');
    });

    const { outcome, sink } = await send({ url: local.url });

    expect(outcome.kind).toBe('completed');
    expect(sink.head?.status).toBe(302);
  });

  it('fails with redirect for a location that is not http or https', async () => {
    const local = await server((_incoming, response) => {
      response.writeHead(302, { Location: 'ftp://files.example.test/a' });
      response.end();
    });

    const { outcome } = await send({ url: local.url });

    expect(outcome.kind === 'failed' && outcome.failure.kind).toBe('redirect');
    expect(outcome.hops).toHaveLength(1);
  });
});
