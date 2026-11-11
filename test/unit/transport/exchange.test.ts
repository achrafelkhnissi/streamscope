import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startHttpServer, startRawServer, type LocalServer } from '../../support/servers';
import { bytes, collector, headerPairs, send, waitFor } from './harness';

const servers: LocalServer[] = [];
let folder = '';

async function http(handler: Parameters<typeof startHttpServer>[0]): Promise<LocalServer> {
  const server = await startHttpServer(handler);
  servers.push(server);
  return server;
}

async function raw(onSocket: Parameters<typeof startRawServer>[0]): Promise<LocalServer> {
  const server = await startRawServer(onSocket);
  servers.push(server);
  return server;
}

const ok = (_request: unknown, response: { end(text: string): void }): void => {
  response.end('ok');
};

beforeEach(() => {
  folder = mkdtempSync(path.join(tmpdir(), 'streamscope-transport-'));
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  rmSync(folder, { recursive: true, force: true });
});

describe('NodeTransport exchange', () => {
  it('sends the method in upper case, headers in written order and casing, and the body', async () => {
    const server = await http(ok);

    const { outcome } = await send({
      url: `${server.url}/items?page=2`,
      method: 'post',
      headers: [
        ['X-First', '1'],
        ['x-second', '2'],
        ['X-Third', '3'],
      ],
      body: [bytes('payload')],
    });

    expect(outcome.kind).toBe('completed');
    const recorded = server.requests[0];
    expect(recorded?.method).toBe('POST');
    expect(recorded?.url).toBe('/items?page=2');
    expect(headerPairs(recorded?.rawHeaders ?? []).slice(0, 3)).toEqual([
      ['X-First', '1'],
      ['x-second', '2'],
      ['X-Third', '3'],
    ]);
    expect(recorded?.body.toString()).toBe('payload');
  });

  it('adds Host, Accept-Encoding and Content-Length only when missing', async () => {
    const server = await http(ok);

    const plain = await send({ url: `${server.url}/a` });
    await send({ url: `${server.url}/b`, headers: [['accept-encoding', 'identity']] });
    await send({
      url: `${server.url}/c`,
      method: 'POST',
      headers: [
        ['Host', 'api.example.test'],
        ['Content-Length', '1'],
      ],
      body: [bytes('abc')],
    });

    const [a, b, c] = server.requests.map((request) => headerPairs(request.rawHeaders));
    expect(a).toEqual(
      expect.arrayContaining([
        ['Host', `127.0.0.1:${String(server.port)}`],
        ['Accept-Encoding', 'gzip, deflate, br, zstd'],
      ]),
    );
    expect(a?.some(([name]) => name.toLowerCase() === 'content-length')).toBe(false);
    expect(b?.filter(([name]) => name.toLowerCase() === 'accept-encoding')).toEqual([
      ['accept-encoding', 'identity'],
    ]);
    expect(c?.filter(([name]) => ['host', 'content-length'].includes(name.toLowerCase()))).toEqual([
      ['Host', 'api.example.test'],
      ['Content-Length', '3'],
    ]);
    expect(server.requests[2]?.body.toString()).toBe('abc');
    expect(plain.sink.sent?.headers).toEqual([
      ['Host', `127.0.0.1:${String(server.port)}`],
      ['Accept-Encoding', 'gzip, deflate, br, zstd'],
    ]);
  });

  it('turns URL credentials into Basic authorization', async () => {
    const server = await http(ok);

    const { sink } = await send({ url: server.url.replace('://', '://user:p%40ss@') + '/me' });

    const expected = `Basic ${Buffer.from('user:p@ss').toString('base64')}`;
    expect(headerPairs(server.requests[0]?.rawHeaders ?? [])).toContainEqual([
      'Authorization',
      expected,
    ]);
    expect(sink.sent?.headers).toContainEqual(['Authorization', expected]);
    expect(sink.sent?.url).toBe(`${server.url}/me`);
  });

  it('sends body parts in order, streaming file parts', async () => {
    const server = await http(ok);
    const file = path.join(folder, 'part.txt');
    writeFileSync(file, 'file-content');

    await send({
      url: server.url,
      method: 'POST',
      body: [bytes('a-'), { kind: 'file', path: file, size: 12 }, bytes('-z')],
    });

    const recorded = server.requests[0];
    expect(recorded?.body.toString()).toBe('a-file-content-z');
    expect(headerPairs(recorded?.rawHeaders ?? [])).toContainEqual(['Content-Length', '16']);
  });

  it('delivers the head with duplicate raw headers and every body chunk', async () => {
    const server = await http((_request, response) => {
      response.setHeader('Set-Cookie', ['a=1', 'b=2']);
      response.write('one');
      setTimeout(() => {
        response.end('two');
      }, 20);
    });

    const { outcome, sink } = await send({ url: server.url });

    expect(outcome.kind).toBe('completed');
    expect(sink.head?.httpVersion).toBe('1.1');
    expect(sink.head?.status).toBe(200);
    expect(sink.head?.statusText).toBe('OK');
    expect(sink.head?.headers.filter(([name]) => name === 'Set-Cookie')).toEqual([
      ['Set-Cookie', 'a=1'],
      ['Set-Cookie', 'b=2'],
    ]);
    expect(sink.chunks.length).toBeGreaterThanOrEqual(2);
    expect(sink.body()).toBe('onetwo');
    expect(outcome.wireBytes).toBe(6);
    expect(outcome.decodedBytes).toBe(6);
  });

  it('records connect, first-byte and total timing', async () => {
    const server = await http(ok);

    const { outcome } = await send({ url: server.url });

    expect(outcome.timing.connectMs).toBeGreaterThanOrEqual(0);
    expect(outcome.timing.firstByteMs).toBeGreaterThanOrEqual(0);
    expect(outcome.timing.totalMs).toBeGreaterThanOrEqual(outcome.timing.firstByteMs ?? 0);
    expect(outcome.hops).toEqual([]);
  });

  it('fails with refused when nothing listens', async () => {
    const server = await http(ok);
    await server.close();
    servers.pop();

    const { outcome } = await send({ url: server.url });

    expect(outcome.kind).toBe('failed');
    expect(outcome.kind === 'failed' && outcome.failure.kind).toBe('refused');
    expect(outcome.kind === 'failed' && outcome.failure.message).toContain(
      `127.0.0.1:${String(server.port)}`,
    );
  });

  it('fails with dns for an unresolvable host', async () => {
    const { outcome } = await send({ url: 'http://streamscope.invalid/' });

    expect(outcome.kind === 'failed' && outcome.failure.kind).toBe('dns');
    expect(outcome.kind === 'failed' && outcome.failure.message).toContain('streamscope.invalid');
  });

  it('fails with premature-close when the connection drops mid-body', async () => {
    const server = await raw((socket) => {
      socket.once('data', () => {
        socket.write('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n0123456789');
        setTimeout(() => socket.destroy(), 20);
      });
    });

    const { outcome, sink } = await send({ url: server.url });

    expect(outcome.kind === 'failed' && outcome.failure.kind).toBe('premature-close');
    expect(sink.body()).toBe('0123456789');
    expect(outcome.decodedBytes).toBe(10);
  });

  it('fails with protocol for invalid chunked encoding', async () => {
    const server = await raw((socket) => {
      socket.once('data', () => {
        socket.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n');
      });
    });

    const { outcome } = await send({ url: server.url });

    expect(outcome.kind === 'failed' && outcome.failure.kind).toBe('protocol');
  });

  it('parses a response whose CRLFs arrive split across packets', async () => {
    const response = Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello');
    const server = await raw((socket) => {
      socket.setNoDelay(true);
      socket.once('data', () => {
        let index = 0;
        const timer = setInterval(() => {
          if (index >= response.length || socket.destroyed) {
            clearInterval(timer);
            return;
          }
          socket.write(response.subarray(index, index + 1));
          index += 1;
        }, 2);
      });
    });

    const { outcome, sink } = await send({ url: server.url });

    expect(outcome.kind).toBe('completed');
    expect(sink.body()).toBe('hello');
  });

  it('fails with headers-timeout when the server never answers', async () => {
    const server = await raw((socket) => socket.resume());

    const { outcome } = await send({ url: server.url }, { headersTimeoutMs: 200 });

    expect(outcome.kind === 'failed' && outcome.failure.kind).toBe('headers-timeout');
    await waitFor(() => server.sockets.closed === server.sockets.opened);
  });

  it('fails with total-timeout during a slow body', async () => {
    const timers: NodeJS.Timeout[] = [];
    const server = await http((_request, response) => {
      response.writeHead(200);
      timers.push(
        setInterval(() => {
          if (!response.destroyed) {
            response.write('tick');
          }
        }, 100),
      );
    });

    const { outcome, sink } = await send({ url: server.url }, { totalTimeoutMs: 300 });
    timers.forEach(clearInterval);

    expect(outcome.kind === 'failed' && outcome.failure.kind).toBe('total-timeout');
    expect(sink.head?.status).toBe(200);
    await waitFor(() => server.sockets.closed === server.sockets.opened);
  });

  it('cancels before the response and closes the socket', async () => {
    const server = await raw((socket) => socket.resume());
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 100);

    const { outcome } = await send({ url: server.url }, {}, collector(), controller.signal);

    expect(outcome.kind).toBe('cancelled');
    await waitFor(() => server.sockets.opened === 1 && server.sockets.closed === 1);
  });

  it('cancels during the body and closes the socket', async () => {
    const server = await http((_request, response) => {
      response.writeHead(200);
      response.write('partial');
    });
    const controller = new AbortController();

    const { outcome, sink } = await send(
      { url: server.url },
      {},
      collector(() => {
        controller.abort();
      }),
      controller.signal,
    );

    expect(outcome.kind).toBe('cancelled');
    expect(sink.body()).toBe('partial');
    await waitFor(() => server.sockets.opened === 1 && server.sockets.closed === 1);
  });

  it('returns cancelled at once for a signal that is already aborted', async () => {
    const server = await http(ok);
    const controller = new AbortController();
    controller.abort();

    const { outcome } = await send({ url: server.url }, {}, collector(), controller.signal);

    expect(outcome.kind).toBe('cancelled');
    expect(server.sockets.opened).toBe(0);
  });

  it('fails with invalid-request for an invalid header name without connecting', async () => {
    const server = await http(ok);

    const { outcome } = await send({ url: server.url, headers: [['Bad Header', 'x']] });

    expect(outcome.kind === 'failed' && outcome.failure.kind).toBe('invalid-request');
    expect(server.sockets.opened).toBe(0);
  });

  it('fails with body-file when a file part has disappeared', async () => {
    const server = await http(ok);

    const { outcome } = await send({
      url: server.url,
      method: 'POST',
      body: [{ kind: 'file', path: path.join(folder, 'gone.json'), size: 5 }],
    });

    expect(outcome.kind === 'failed' && outcome.failure.kind).toBe('body-file');
    expect(outcome.kind === 'failed' && outcome.failure.message).toContain('gone.json');
    expect(server.sockets.opened).toBe(0);
  });

  it('fails with body-file when a file part shrank after it was measured', async () => {
    const server = await http(ok);
    const file = path.join(folder, 'short.txt');
    writeFileSync(file, 'abc');

    const { outcome } = await send({
      url: server.url,
      method: 'POST',
      body: [{ kind: 'file', path: file, size: 10 }],
    });

    expect(outcome.kind === 'failed' && outcome.failure.kind).toBe('body-file');
    await waitFor(() => server.sockets.closed === server.sockets.opened);
  });
});
