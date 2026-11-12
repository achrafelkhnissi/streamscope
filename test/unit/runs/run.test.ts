import { chmodSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpillFile } from '../../../src/events/spill';
import { parseHttpFile } from '../../../src/http-file/parse';
import { requestKey, requestKeyDocument, startRun, type RunStatus } from '../../../src/runs/run';
import type { Transport } from '../../../src/transport/model';
import { createSelfSignedCertificate } from '../../support/certificate';
import { startHttpServer, startHttpsServer, type LocalServer } from '../../support/servers';
import { startStreamServer } from '../../support/stream-server';
import { waitFor } from '../transport/harness';
import { dependencies, runInput, useSpillArea } from './support';

const servers: LocalServer[] = [];
const spillArea = useSpillArea();

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
      '`{{missing}}` is not defined in this file or `$shared` (no environment selected).',
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
      const folder = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'streamscope-run-')));
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

describe('startRun with sources and trust', () => {
  async function selfSigned(): Promise<LocalServer> {
    return track(
      startHttpsServer(createSelfSignedCertificate(['localhost', '127.0.0.1']), (_q, response) => {
        response.end('secure');
      }),
    );
  }

  it('turns off TLS verification for an insecure environment only when trusted', async () => {
    const server = await selfSigned();
    const lines = [`GET ${server.url}/a`];

    const trusted = await startRun(
      runInput(lines, { settings: { insecureEnvironment: true } }),
      dependencies,
    ).done;
    const restricted = await startRun(
      runInput(lines, { settings: { insecureEnvironment: true }, restricted: true }),
      dependencies,
    ).done;

    expect(trusted.status).toBe('completed');
    expect(restricted.failure?.kind).toBe('tls');
  });

  it('ignores # @insecure in a restricted workspace', async () => {
    const server = await selfSigned();

    const snapshot = await startRun(
      runInput(['# @insecure', `GET ${server.url}/a`], { restricted: true }),
      dependencies,
    ).done;

    expect(snapshot.failure?.kind).toBe('tls');
  });

  it('asks before sending and cancels without connecting when declined', async () => {
    const server = await track(startHttpServer((_request, response) => response.end('ok')));
    const asked: string[] = [];

    const declined = await startRun(
      runInput([`GET ${server.url}`], {
        confirmSend: () => {
          asked.push('declined');
          return Promise.resolve(false);
        },
      }),
      dependencies,
    ).done;
    expect(declined.status).toBe('cancelled');
    expect(server.sockets.opened).toBe(0);

    const accepted = await startRun(
      runInput([`GET ${server.url}`], {
        confirmSend: () => {
          asked.push('accepted');
          return Promise.resolve(true);
        },
      }),
      dependencies,
    ).done;
    expect(accepted.status).toBe('completed');
    expect(asked).toEqual(['declined', 'accepted']);
  });

  it('does not ask before a request that is blocked anyway', async () => {
    let asked = false;

    const snapshot = await startRun(
      runInput(['GET https://api.example.test/{{missing}}'], {
        confirmSend: () => {
          asked = true;
          return Promise.resolve(true);
        },
      }),
      dependencies,
    ).done;

    expect(snapshot.status).toBe('blocked');
    expect(asked).toBe(false);
  });

  it('resolves from the run variables and records sensitive values', async () => {
    const server = await track(startHttpServer((_request, response) => response.end('ok')));

    const snapshot = await startRun(
      runInput([`GET ${server.url}/{{path}}`, 'Authorization: Bearer {{$secret apiToken}}'], {
        variables: {
          environmentName: 'dev',
          environment: new Map([
            ['path', { value: 'items', origin: 'dev environment (settings)' }],
          ]),
          secrets: new Map([['apiToken', 'synthetic-token']]),
        },
      }),
      dependencies,
    ).done;

    expect(snapshot.status).toBe('completed');
    expect(server.requests[0]?.url).toBe('/items');
    expect(snapshot.sensitiveValues).toEqual(['synthetic-token']);
  });
});

describe('startRun streaming', () => {
  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  it('feeds a stream session while receiving', async () => {
    const server = await track(startStreamServer());
    const rate = 100;
    const seconds = 0.5;
    const total = Math.floor(rate * seconds) + 2;
    const run = startRun(
      runInput([
        `GET ${server.url}/stream?rate=${String(rate)}&seconds=${String(seconds)}&size=256`,
      ]),
      dependencies,
    );
    const seen: { status: RunStatus; count: number }[] = [];
    run.onUpdate(() => {
      const current = run.snapshot();
      seen.push({ status: current.status, count: current.stream?.store.count ?? 0 });
    });

    const snapshot = await run.done;

    expect(snapshot.status).toBe('completed');
    expect(
      seen.some(({ status, count }) => status === 'receiving' && count > 0 && count < total),
    ).toBe(true);
    expect(seen.at(-1)?.status).toBe('completed');
    expect(snapshot.stream?.store.count).toBe(total);
    expect(snapshot.stream?.format?.format).toBe('ndjson');
  });

  it('times each event in milliseconds since the request was sent', async () => {
    const server = await track(startStreamServer());
    const lateClock = { ...dependencies, clock: () => 3_600_000 + performance.now() };

    const snapshot = await startRun(
      runInput([`GET ${server.url}/stream?rate=100&seconds=0.3&size=256`]),
      lateClock,
    ).done;

    const store = snapshot.stream?.store;
    const times = Array.from(
      { length: store?.count ?? 0 },
      (_, at) => store?.summary(at + 1)?.time ?? Number.NaN,
    );
    expect(times.length).toBeGreaterThan(10);
    expect(times[0]).toBeGreaterThanOrEqual(0);
    expect(times[0]).toBeLessThan(5000);
    expect(times.at(-1)).toBeLessThan(5000);
    for (let at = 1; at < times.length; at += 1) {
      expect(times[at]).toBeGreaterThanOrEqual(times[at - 1] ?? Number.POSITIVE_INFINITY);
    }
  });

  it('keeps no body for an NDJSON stream labelled application/json', async () => {
    const server = await track(startStreamServer());

    const snapshot = await startRun(
      runInput([`GET ${server.url}/stream?type=application/json&rate=100&seconds=0.3&size=256`]),
      dependencies,
    ).done;

    expect(snapshot.status).toBe('completed');
    expect(snapshot.stream?.format?.format).toBe('ndjson');
    expect(snapshot.bodyKept).toBe(false);
    expect(snapshot.body.length).toBe(0);
    expect(snapshot.stream?.store.count).toBe(32);
  });

  it('keeps the body of a JSON response', async () => {
    const body = Buffer.from(JSON.stringify({ padding: 'x'.repeat(10 * 1024 - 14) }));
    const server = await track(
      startHttpServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(body);
      }),
    );

    const snapshot = await startRun(runInput([`GET ${server.url}`]), dependencies).done;

    expect(body.length).toBe(10 * 1024);
    expect(snapshot.status).toBe('completed');
    expect(snapshot.bodyKept).toBe(true);
    expect(Buffer.from(snapshot.body).equals(body)).toBe(true);
    expect(snapshot.stream?.format?.format).toBe('json');
    expect(snapshot.stream?.store.count).toBe(0);
  });

  it('keeps the events received before Stop', async () => {
    const server = await track(startStreamServer());
    const run = startRun(
      runInput([`GET ${server.url}/stream?rate=50&seconds=30&size=256`]),
      dependencies,
    );

    await waitFor(() => (run.snapshot().stream?.store.count ?? 0) >= 5, 3000);
    run.cancel();
    const snapshot = await run.done;
    const count = snapshot.stream?.store.count ?? 0;
    await delay(200);

    expect(snapshot.status).toBe('cancelled');
    expect(count).toBeGreaterThanOrEqual(5);
    expect(run.snapshot().stream?.store.count).toBe(count);
    await run.release();
  });

  it('a compacted run reads its events from the spill file', async () => {
    const server = await track(startStreamServer());
    const run = startRun(
      runInput([`GET ${server.url}/stream?rate=100&seconds=0.3&size=256`]),
      dependencies,
    );
    const snapshot = await run.done;
    const store = snapshot.stream?.store;
    const before = await store?.read(2);

    run.compact();

    expect(store?.count).toBe(32);
    expect(store?.inMemory(2)).toBeUndefined();
    expect(store?.inMemory(32)).toBeUndefined();
    expect(before?.value).toBeDefined();
    expect(await store?.read(2)).toEqual(before);
    expect((await store?.read(32))?.label).toBe('RUN_FINISHED');
    await run.release();
  });

  it('compacting a run that has no session yet does nothing', async () => {
    const server = await track(startStreamServer());
    const run = startRun(
      runInput([`GET ${server.url}/stream?rate=100&seconds=0.3&size=256`]),
      dependencies,
    );

    run.compact();
    const snapshot = await run.done;

    expect(snapshot.status).toBe('completed');
    expect(snapshot.stream?.store.count).toBe(32);
    expect(snapshot.stream?.store.inMemory(32)).toBeDefined();
    await run.release();
  });

  it('keeps holding new events of a run compacted while it streams', async () => {
    const server = await track(startStreamServer());
    const run = startRun(
      runInput([`GET ${server.url}/stream?rate=50&seconds=30&size=256`]),
      dependencies,
    );
    await waitFor(() => (run.snapshot().stream?.store.count ?? 0) >= 2, 3000);

    run.compact();
    const compactedAt = run.snapshot().stream?.store.count ?? 0;
    await waitFor(() => (run.snapshot().stream?.store.count ?? 0) > compactedAt + 1, 3000);
    const store = run.snapshot().stream?.store;
    const newest = store?.count ?? 0;

    expect(store?.inMemory(compactedAt)).toBeUndefined();
    expect(store?.inMemory(newest)).toBeDefined();
    await run.release();
  });

  it('deletes the spill file of a run that never got headers', async () => {
    const server = await startHttpServer((_request, response) => response.end());
    await server.close();
    const area = spillArea();
    const create = vi.spyOn(area, 'create');

    const snapshot = await startRun(runInput([`GET ${server.url}/gone`]), dependencies).done;

    expect(snapshot.status).toBe('failed');
    expect(snapshot.failure?.kind).toBe('refused');
    expect(snapshot.stream).toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
    expect(readdirSync(area.directory)).toEqual([]);
  });

  it('pauses the transport while the spill file is behind', async () => {
    const server = await track(startStreamServer());
    const area = spillArea();
    const create = area.create.bind(area);
    vi.spyOn(area, 'create').mockImplementation(async () => {
      const file = await create();
      const listeners = new Set<() => void>();
      vi.spyOn(file, 'onDrain').mockImplementation((listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      });
      vi.spyOn(file, 'append').mockImplementation(() => {
        setTimeout(() => {
          for (const listener of [...listeners]) {
            listener();
          }
        }, 100);
        return false;
      });
      return file;
    });
    const returned: unknown[] = [];
    const transport: Transport = {
      send: (request, options, sink, signal) =>
        dependencies.transport.send(
          request,
          options,
          {
            onRequest: (sent) => {
              sink.onRequest(sent);
            },
            onHead: (head, sent) => {
              sink.onHead(head, sent);
            },
            onData: (chunk) => {
              const result = sink.onData(chunk);
              returned.push(result);
              return result;
            },
          },
          signal,
        ),
    };

    const snapshot = await startRun(
      runInput([`GET ${server.url}/stream?rate=20&seconds=0.5&size=256`]),
      { ...dependencies, transport },
    ).done;

    expect(snapshot.status).toBe('completed');
    expect(returned.length).toBeGreaterThan(0);
    expect(returned.every((result) => result instanceof Promise)).toBe(true);
    expect(snapshot.stream?.store.count).toBe(12);
  });

  it('sends without a spill file when it cannot be created', async () => {
    const server = await track(startStreamServer());
    vi.spyOn(spillArea(), 'create').mockRejectedValue(new Error('synthetic disk full'));

    const snapshot = await startRun(
      runInput([`GET ${server.url}/stream?rate=100&seconds=0.2&size=256`]),
      dependencies,
    ).done;

    expect(snapshot.status).toBe('completed');
    expect(snapshot.stream?.store.count).toBe(22);
  });

  it('streams without a spill area', async () => {
    const server = await track(startStreamServer());
    const statuses: RunStatus[] = [];
    const run = startRun(
      {
        ...runInput([`GET ${server.url}/stream?rate=100&seconds=0.2&size=256`]),
        spill: undefined,
      },
      dependencies,
    );
    run.onUpdate(() => statuses.push(run.snapshot().status));

    const snapshot = await run.done;

    expect(snapshot.status).toBe('completed');
    expect(statuses.at(-1)).toBe('completed');
    expect(snapshot.stream?.format?.format).toBe('ndjson');
    expect(snapshot.stream?.store.count).toBe(22);
    expect(snapshot.stream?.store.inMemory(1)?.label).toBe('RUN_STARTED');
    expect(snapshot.stream?.store.inMemory(22)?.label).toBe('RUN_FINISHED');
    await expect(run.release()).resolves.toBeUndefined();
  });

  it('reaches its terminal state when the spill file cannot be removed', async () => {
    const server = await startHttpServer((_request, response) => response.end());
    await server.close();
    const area = spillArea();
    const create = area.create.bind(area);
    vi.spyOn(area, 'create').mockImplementation(async () => {
      const file = await create();
      const remove = file.delete.bind(file);
      vi.spyOn(file, 'delete').mockImplementation(async () => {
        await remove();
        throw new Error('synthetic EBUSY');
      });
      return file;
    });

    const run = startRun(runInput([`GET ${server.url}/gone`]), dependencies);
    const snapshot = await run.done;

    expect(snapshot.status).toBe('failed');
    expect(snapshot.failure?.kind).toBe('refused');
    expect(run.snapshot().status).toBe('failed');
    await expect(run.release()).resolves.toBeUndefined();
  });

  it('releases a streaming run when the spill file cannot be removed', async () => {
    const server = await track(startStreamServer());
    const area = spillArea();
    const create = area.create.bind(area);
    vi.spyOn(area, 'create').mockImplementation(async () => {
      const file = await create();
      const remove = file.delete.bind(file);
      vi.spyOn(file, 'delete').mockImplementation(async () => {
        await remove();
        throw new Error('synthetic EBUSY');
      });
      return file;
    });
    const run = startRun(
      runInput([`GET ${server.url}/stream?rate=50&seconds=30&size=256`]),
      dependencies,
    );
    await waitFor(() => (run.snapshot().stream?.store.count ?? 0) >= 2, 3000);

    await expect(run.release()).resolves.toBeUndefined();

    expect((await run.done).status).toBe('cancelled');
  });

  it('counts the response bytes received while they arrive', async () => {
    const server = await track(startStreamServer());
    const run = startRun(
      runInput([`GET ${server.url}/stream?rate=100&seconds=0.3&size=256`]),
      dependencies,
    );
    const seen: number[] = [];
    run.onUpdate(() => seen.push(run.snapshot().receivedBytes));

    const snapshot = await run.done;

    expect(snapshot.receivedBytes).toBe(32 * 256);
    expect(seen.some((bytes) => bytes > 0 && bytes < 32 * 256)).toBe(true);
  });

  it('says whether the raw data of a run is saved', async () => {
    const server = await track(startStreamServer());
    const url = `GET ${server.url}/stream?rate=100&seconds=0.1&size=256`;
    const area = spillArea();
    const create = area.create.bind(area);

    const saved = await startRun(runInput([url]), dependencies).done;
    const unsaved = await startRun({ ...runInput([url]), spill: undefined }, dependencies).done;
    const spy = vi.spyOn(area, 'create');
    spy.mockImplementationOnce(async () => {
      const file = await create();
      vi.spyOn(file, 'capped', 'get').mockReturnValue(true);
      return file;
    });
    const stopped = await startRun(runInput([url]), dependencies).done;
    spy.mockImplementationOnce(async () => {
      const file = await create();
      vi.spyOn(file, 'evicted', 'get').mockReturnValue(true);
      return file;
    });
    const removed = await startRun(runInput([url]), dependencies).done;

    expect(saved.rawData).toBe('saved');
    expect(unsaved.rawData).toBe('unsaved');
    expect(stopped.rawData).toBe('stopped');
    expect(removed.rawData).toBe('removed');
  });

  it('keeps a bounded raw tail of a long stream', async () => {
    const server = await track(startStreamServer());

    const snapshot = await startRun(
      runInput([`GET ${server.url}/stream?rate=80&seconds=1&size=65536`]),
      dependencies,
    ).done;

    expect(snapshot.status).toBe('completed');
    expect(snapshot.stream?.store.count).toBe(82);
    expect(snapshot.raw.trimmed).toBe(true);
    expect(snapshot.raw.text.length).toBeLessThanOrEqual(2_097_152);
    expect(snapshot.raw.text.startsWith('{"type":')).toBe(true);
    expect(snapshot.raw.text.endsWith('\n')).toBe(true);
    expect(snapshot.raw.text).toContain('"type":"RUN_FINISHED"');
  });

  it('release() stops the run, disposes the session and deletes the spill file', async () => {
    const server = await track(startStreamServer());
    const area = spillArea();
    const files: SpillFile[] = [];
    const create = area.create.bind(area);
    vi.spyOn(area, 'create').mockImplementation(async () => {
      const file = await create();
      files.push(file);
      return file;
    });
    const run = startRun(
      runInput([`GET ${server.url}/stream?rate=50&seconds=30&size=256`]),
      dependencies,
    );
    await waitFor(() => (run.snapshot().stream?.store.count ?? 0) >= 2, 3000);

    await run.release();
    await run.release();
    const snapshot = await run.done;

    const count = snapshot.stream?.store.count;

    expect(snapshot.status).toBe('cancelled');
    expect(files).toHaveLength(1);
    expect(readdirSync(area.directory)).toEqual([]);
    expect(snapshot.stream?.write(new TextEncoder().encode('{"type":"LATE"}\n'))).toBe(true);
    expect(snapshot.stream?.store.count).toBe(count);
  });
});

describe('release', () => {
  it('drops the events the store holds in memory', async () => {
    const server = await track(startStreamServer());
    const run = startRun(
      runInput([`GET ${server.url}/stream?rate=100&seconds=0.3&size=256`]),
      dependencies,
    );
    const store = (await run.done).stream?.store;
    expect(store?.inMemory(1)).toBeDefined();
    expect(store?.inMemory(32)).toBeDefined();

    await run.release();

    expect(store?.count).toBe(32);
    expect(store?.inMemory(1)).toBeUndefined();
    expect(store?.inMemory(32)).toBeUndefined();
  });

  it('marks the run released and its raw data removed', async () => {
    const server = await track(startStreamServer());
    const run = startRun(
      runInput([`GET ${server.url}/stream?rate=100&seconds=0.3&size=256`]),
      dependencies,
    );
    const before = await run.done;
    expect(before.released).toBe(false);
    expect(before.rawData).toBe('saved');

    await run.release();

    expect(run.snapshot().released).toBe(true);
    expect(run.snapshot().rawData).toBe('removed');
    expect(run.snapshot().status).toBe('completed');
  });

  it('keeps saying the raw data was never saved when there was no spill file', async () => {
    const server = await track(startStreamServer());
    const run = startRun(
      { ...runInput([`GET ${server.url}/stream?rate=100&seconds=0.1&size=256`]), spill: undefined },
      dependencies,
    );
    await run.done;

    await run.release();

    expect(run.snapshot().released).toBe(true);
    expect(run.snapshot().rawData).toBe('unsaved');
  });
});

describe('wall-clock start', () => {
  it('records the time of day the run started, not the monotonic clock', async () => {
    const snapshot = await startRun(
      runInput(['GET https://api.example.test/{{missing}}']),
      dependencies,
    ).done;

    expect(snapshot.wallStartedAt).toBe(new Date('2026-11-11T10:20:30.456Z').getTime());
    expect(snapshot.startedAt).not.toBe(snapshot.wallStartedAt);
  });
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

  it('gives back the document a key was made from', () => {
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
    const document = 'file:///my%20folder/a.http';

    expect(requestKeyDocument(requestKey(document, login, 0))).toBe(document);
    expect(requestKeyDocument(requestKey(document, me, 1))).toBe(document);
    expect(requestKeyDocument('untitled:Untitled-1\n@x')).toBe('untitled:Untitled-1');
  });
});
