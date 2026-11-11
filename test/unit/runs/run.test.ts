import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { parseHttpFile } from '../../../src/http-file/parse';
import { requestKey, startRun } from '../../../src/runs/run';
import { createSelfSignedCertificate } from '../../support/certificate';
import { startHttpServer, startHttpsServer, type LocalServer } from '../../support/servers';
import { waitFor } from '../transport/harness';
import { dependencies, runInput } from './support';

const servers: LocalServer[] = [];

async function track(server: Promise<LocalServer>): Promise<LocalServer> {
  const started = await server;
  servers.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('startRun', () => {
  it('completes with head, body, hops and timing', async () => {
    const server = await track(
      startHttpServer((request, response) => {
        if (request.url === '/a') {
          response.writeHead(302, { Location: '/b' });
          response.end();
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"ok":true}');
      }),
    );

    const run = startRun(runInput([`GET ${server.url}/a`]), dependencies);
    const snapshot = await run.done;

    expect(snapshot.status).toBe('completed');
    expect(snapshot.head?.status).toBe(200);
    expect(Buffer.from(snapshot.body).toString()).toBe('{"ok":true}');
    expect(snapshot.hops.map((hop) => hop.status)).toEqual([302]);
    expect(snapshot.sent?.url).toBe(`${server.url}/b`);
    expect(snapshot.timing?.totalMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.wireBytes).toBe(11);
    expect(snapshot.failure).toBeUndefined();
    expect(snapshot.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(run.snapshot()).toEqual(snapshot);
  });

  it('blocks without contacting the server when a variable is missing', async () => {
    const server = await track(startHttpServer((_request, response) => response.end()));

    const snapshot = await startRun(runInput([`GET ${server.url}/{{missing}}`]), dependencies).done;

    expect(snapshot.status).toBe('blocked');
    expect(snapshot.problems.map((problem) => problem.message)).toEqual([
      '`{{missing}}` is not defined.',
    ]);
    expect(snapshot.sent).toBeUndefined();
    expect(server.sockets.opened).toBe(0);
  });

  it('blocks a request whose # @timeout is not a duration', async () => {
    const snapshot = await startRun(
      runInput(['# @timeout 1h', 'GET https://api.example.test/items']),
      dependencies,
    ).done;

    expect(snapshot.status).toBe('blocked');
    expect(snapshot.problems[0]?.message).toBe('Expected a duration such as 500ms, 30s or 5m.');
  });

  it('turns off TLS verification only for the request marked # @insecure', async () => {
    const server = await track(
      startHttpsServer(createSelfSignedCertificate(['localhost', '127.0.0.1']), (_q, response) => {
        response.end('secure');
      }),
    );
    const lines = ['# @insecure', `GET ${server.url}/a`, '', '###', `GET ${server.url}/b`];

    const insecure = await startRun(runInput(lines, { index: 0 }), dependencies).done;
    const verified = await startRun(runInput(lines, { index: 1 }), dependencies).done;

    expect(insecure.status).toBe('completed');
    expect(verified.status).toBe('failed');
    expect(verified.failure?.kind).toBe('tls');
  });

  it('applies # @timeout as the total limit', async () => {
    const timers: NodeJS.Timeout[] = [];
    const server = await track(
      startHttpServer((_request, response) => {
        response.writeHead(200);
        timers.push(setInterval(() => response.write('tick'), 50));
      }),
    );

    const snapshot = await startRun(
      runInput(['# @timeout 300ms', `GET ${server.url}`]),
      dependencies,
    ).done;
    timers.forEach(clearInterval);

    expect(snapshot.status).toBe('failed');
    expect(snapshot.failure?.kind).toBe('total-timeout');
  });

  it('does not follow redirects for # @no-redirect', async () => {
    const server = await track(
      startHttpServer((_request, response) => {
        response.writeHead(302, { Location: '/elsewhere' });
        response.end();
      }),
    );

    const snapshot = await startRun(runInput(['# @no-redirect', `GET ${server.url}`]), dependencies)
      .done;

    expect(snapshot.status).toBe('completed');
    expect(snapshot.head?.status).toBe(302);
    expect(snapshot.hops).toEqual([]);
  });

  it('fails with body-too-large past maxBodyBytes', async () => {
    const server = await track(
      startHttpServer((_request, response) => {
        response.end(Buffer.alloc(4096, 'x'));
      }),
    );

    const snapshot = await startRun(
      runInput([`GET ${server.url}`], { settings: { maxBodyBytes: 1024 } }),
      dependencies,
    ).done;

    expect(snapshot.status).toBe('failed');
    expect(snapshot.failure?.kind).toBe('body-too-large');
    expect(snapshot.failure?.message).toContain('1.0 KB');
    expect(snapshot.body.length).toBeLessThanOrEqual(1024);
  });

  it('stops a compressed body that expands past maxBodyBytes', async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024));
    const server = await track(
      startHttpServer((_request, response) => {
        response.writeHead(200, { 'Content-Encoding': 'gzip' });
        response.end(bomb);
      }),
    );

    const snapshot = await startRun(
      runInput([`GET ${server.url}`], { settings: { maxBodyBytes: 1_048_576 } }),
      dependencies,
    ).done;

    expect(snapshot.status).toBe('failed');
    expect(snapshot.failure?.kind).toBe('body-too-large');
    expect(snapshot.body.length).toBeLessThanOrEqual(1_048_576);
  });

  it('records the request as sent when the connection fails', async () => {
    const server = await startHttpServer((_request, response) => response.end());
    await server.close();

    const snapshot = await startRun(runInput([`GET ${server.url}/gone`]), dependencies).done;

    expect(snapshot.status).toBe('failed');
    expect(snapshot.failure?.kind).toBe('refused');
    expect(snapshot.sent?.url).toBe(`${server.url}/gone`);
  });

  it('ends failed when the transport rejects', async () => {
    const snapshot = await startRun(runInput(['GET https://api.example.test/items']), {
      ...dependencies,
      transport: { send: () => Promise.reject(new Error('synthetic transport failure')) },
    }).done;

    expect(snapshot.status).toBe('failed');
    expect(snapshot.failure).toEqual({
      kind: 'invalid-request',
      message: 'The request could not be sent: synthetic transport failure.',
    });
  });

  it('cancel() ends in cancelled', async () => {
    const server = await track(
      startHttpServer((_request, response) => {
        response.writeHead(200);
        response.write('partial');
      }),
    );

    const run = startRun(runInput([`GET ${server.url}`]), dependencies);
    await waitFor(() => run.snapshot().status === 'receiving', 2000);
    run.cancel();
    const snapshot = await run.done;

    expect(snapshot.status).toBe('cancelled');
    expect(snapshot.failure).toBeUndefined();
    await waitFor(() => server.sockets.closed === server.sockets.opened);
  });

  it('cancel() before sending ends in cancelled without contacting the server', async () => {
    const server = await track(startHttpServer((_request, response) => response.end()));

    const run = startRun(runInput([`GET ${server.url}`]), dependencies);
    run.cancel();

    expect((await run.done).status).toBe('cancelled');
    expect(server.sockets.opened).toBe(0);
  });

  it.skipIf(process.platform === 'win32')(
    'fails with body-file when a body file cannot be read',
    async () => {
      const folder = realpathSync(mkdtempSync(path.join(tmpdir(), 'streamscope-run-')));
      const file = path.join(folder, 'locked.json');
      writeFileSync(file, '{}');
      chmodSync(file, 0);
      const input = runInput(['POST https://api.example.test/items', '', '<@ ./locked.json']);

      try {
        const snapshot = await startRun(
          { ...input, bodyFiles: { documentDir: folder, containmentRoot: folder } },
          dependencies,
        ).done;

        expect(snapshot.status).toBe('failed');
        expect(snapshot.failure?.kind).toBe('body-file');
      } finally {
        chmodSync(file, 0o600);
        rmSync(folder, { recursive: true, force: true });
      }
    },
  );
});

describe('requestKey', () => {
  it('keys named requests by name and others by position, method and url', () => {
    const file = parseHttpFile(
      [
        '# @name login',
        'POST https://api.example.test/login',
        '',
        '###',
        'get https://api.example.test/me',
      ].join('\n'),
    );
    const [login, me] = file.requests;
    if (!login || !me) {
      throw new Error('expected two requests');
    }

    expect(requestKey('file:///a.http', login, 0)).toBe('file:///a.http\n@login');
    expect(requestKey('file:///a.http', me, 1)).toBe(
      'file:///a.http\n#1 GET https://api.example.test/me',
    );
  });
});
