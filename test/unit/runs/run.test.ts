import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptureRegistry } from '../../../src/capture/registry';
import { CaptureService } from '../../../src/capture/service';
import type { CaptureResult } from '../../../src/capture/tracker';
import type { SpillFile } from '../../../src/events/spill';
import { parseHttpFile } from '../../../src/http-file/parse';
import { describeOutcome, formatBytes, requestLabel } from '../../../src/response/labels';
import type { RunAccess, RunEnd, RunObserver } from '../../../src/runs/observer';
import {
  requestKey,
  requestKeyDocument,
  startRun,
  type RunInput,
  type RunSnapshot,
  type RunStatus,
} from '../../../src/runs/run';
import type { Transport } from '../../../src/transport/model';
import { createSelfSignedCertificate } from '../../support/certificate';
import { startHttpServer, startHttpsServer, type LocalServer } from '../../support/servers';
import { startStreamServer } from '../../support/stream-server';
import { collect } from '../../support/memory';
import { missingWorker } from '../capture/worker';
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

  it('requires every observer to say how it holds back the stream', () => {
    // @ts-expect-error an observer without backpressure could queue events without bound
    const unpaced: RunObserver = {
      head: () => undefined,
      event: () => undefined,
      end: () => undefined,
    };

    expect(unpaced).not.toHaveProperty('backpressure');
  });

  it('stops reading the socket while the observer is congested, until it drains', async () => {
    const line = `${JSON.stringify({ type: 'TICK', pad: 'x'.repeat(200) })}\n`;
    const body = line.repeat(Math.ceil((4 * 1_048_576) / line.length));
    const server = await track(
      startHttpServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        response.end(body);
      }),
    );
    const listeners = new Set<() => void>();
    let events = 0;
    const observer: RunObserver = {
      head: () => undefined,
      event: () => {
        events += 1;
      },
      end: () => undefined,
      backpressure: {
        congested: true,
        onDrain(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
    };

    const run = startRun(
      { ...runInput([`GET ${server.url}/paced`]), spill: undefined, observer },
      dependencies,
    );
    await waitFor(() => run.snapshot().receivedBytes > 0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const held = run.snapshot().receivedBytes;
    const heldEvents = events;
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(run.snapshot().receivedBytes).toBe(held);
    expect(events).toBe(heldEvents);
    expect(held).toBeLessThan(body.length / 4);
    expect(run.snapshot().status).toBe('receiving');
    expect(listeners.size).toBe(1);

    Object.assign(observer.backpressure, { congested: false });
    for (const listener of [...listeners]) {
      listener();
    }
    const snapshot = await run.done;

    expect(snapshot.status).toBe('completed');
    expect(snapshot.receivedBytes).toBe(body.length);
    expect(events).toBe(body.length / line.length);
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

describe('compact and the body', () => {
  const json = JSON.stringify({ items: Array.from({ length: 200 }, (_unused, id) => ({ id })) });

  async function jsonServer(): Promise<LocalServer> {
    return track(
      startHttpServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(json);
      }),
    );
  }

  it('drops the body bytes of a finished run and keeps that it has a body', async () => {
    const server = await jsonServer();
    const run = startRun(runInput([`GET ${server.url}`]), dependencies);
    const finished = await run.done;
    expect(finished.body.length).toBe(json.length);
    expect(finished.bodyLength).toBe(json.length);
    expect(finished.bodySource).toBe('memory');

    run.compact();
    const compacted = run.snapshot();

    expect(compacted.body.length).toBe(0);
    expect(compacted.bodyKept).toBe(true);
    expect(compacted.bodyLength).toBe(json.length);
    expect(compacted.bodySource).toBe('spill');
    expect(compacted.status).toBe('completed');
    expect(compacted.receivedBytes).toBe(json.length);
    await run.release();
  });

  it('reads the dropped body back from its spill file, whole or its first bytes', async () => {
    const server = await jsonServer();
    const run = startRun(runInput([`GET ${server.url}`]), dependencies);
    await run.done;
    run.compact();

    const whole = await run.readBody(json.length);
    const first = await run.readBody(20);

    expect(Buffer.from(whole ?? []).toString()).toBe(json);
    expect(Buffer.from(first ?? []).toString()).toBe(json.slice(0, 20));
    await run.release();
  });

  it('reads a body that was never dropped from memory', async () => {
    const server = await jsonServer();
    const run = startRun(runInput([`GET ${server.url}`]), dependencies);
    await run.done;

    expect(Buffer.from((await run.readBody(json.length)) ?? []).toString()).toBe(json);
    expect(Buffer.from((await run.readBody(5)) ?? []).toString()).toBe(json.slice(0, 5));
    await run.release();
  });

  it('compacting twice changes nothing more', async () => {
    const server = await jsonServer();
    const run = startRun(runInput([`GET ${server.url}`]), dependencies);
    await run.done;

    run.compact();
    run.compact();

    expect(run.snapshot().bodyLength).toBe(json.length);
    expect(Buffer.from((await run.readBody(json.length)) ?? []).toString()).toBe(json);
    await run.release();
  });

  it('does not drop the body of a run that is still receiving it', async () => {
    const server = await track(
      startHttpServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write(json.slice(0, 50));
        setTimeout(() => response.end(json.slice(50)), 200);
      }),
    );
    const run = startRun(runInput([`GET ${server.url}`]), dependencies);
    await waitFor(() => run.snapshot().status === 'receiving', 3000);

    run.compact();
    const finished = await run.done;

    expect(Buffer.from(finished.body).toString()).toBe(json);
    expect(finished.bodySource).toBe('memory');
    await run.release();
  });

  it('keeps an empty body as it is', async () => {
    const server = await track(startHttpServer((_request, response) => response.end()));
    const run = startRun(runInput([`GET ${server.url}`]), dependencies);
    await run.done;

    run.compact();

    expect(run.snapshot().bodyLength).toBe(0);
    expect(run.snapshot().bodySource).toBe('memory');
    expect((await run.readBody(10))?.length).toBe(0);
    await run.release();
  });

  it('says the body is gone when the run has no spill file', async () => {
    const server = await jsonServer();
    const run = startRun({ ...runInput([`GET ${server.url}`]), spill: undefined }, dependencies);
    await run.done;

    run.compact();

    expect(run.snapshot().body.length).toBe(0);
    expect(run.snapshot().bodyLength).toBe(json.length);
    expect(run.snapshot().bodySource).toBe('gone');
    expect(await run.readBody(json.length)).toBeUndefined();
  });

  it('says the body is gone once its spill file was evicted or the run released', async () => {
    const server = await jsonServer();
    const area = spillArea();
    const files: SpillFile[] = [];
    const create = area.create.bind(area);
    vi.spyOn(area, 'create').mockImplementation(async () => {
      const file = await create();
      files.push(file);
      return file;
    });
    const evicted = startRun(runInput([`GET ${server.url}`]), dependencies);
    await evicted.done;
    evicted.compact();
    files[0]?.evict();
    const released = startRun(runInput([`GET ${server.url}`]), dependencies);
    await released.done;
    released.compact();

    await released.release();

    expect(evicted.snapshot().bodySource).toBe('gone');
    expect(await evicted.readBody(json.length)).toBeUndefined();
    expect(released.snapshot().bodySource).toBe('gone');
    expect(await released.readBody(json.length)).toBeUndefined();
  });

  it('keeps the size of the body in the outcome after the bytes are dropped', async () => {
    const server = await jsonServer();
    const run = startRun(runInput([`GET ${server.url}`]), dependencies);
    await run.done;
    const before = describeOutcome(run.snapshot());

    run.compact();

    expect(describeOutcome(run.snapshot())).toBe(before);
    expect(before).toContain(formatBytes(json.length));
    await run.release();
  });

  it('does not touch a run whose events are the response', async () => {
    const server = await track(startStreamServer());
    const run = startRun(
      runInput([`GET ${server.url}/stream?rate=100&seconds=0.2&size=128`]),
      dependencies,
    );
    await run.done;

    run.compact();

    expect(run.snapshot().bodyKept).toBe(false);
    expect(run.snapshot().bodyLength).toBe(0);
    expect(run.snapshot().body.length).toBe(0);
    await run.release();
  });
});

describe('compact and the raw tail and the reply', () => {
  const stream = (server: LocalServer, query = 'rate=100&seconds=0.3&size=256'): string =>
    `GET ${server.url}/stream?${query}`;

  it('drops the raw tail and the reply of a finished run and keeps what they said', async () => {
    const server = await track(startStreamServer());
    const run = startRun(runInput([stream(server)]), dependencies);
    const finished = await run.done;
    const reply = finished.stream?.reply;
    const rawTotal = finished.raw.total;
    const replySize = reply?.size ?? 0;
    expect(finished.raw.text.length).toBeGreaterThan(0);
    expect(reply?.text().length).toBeGreaterThan(0);
    expect(finished.rawSource).toBe('memory');
    expect(finished.replySource).toBe('memory');

    run.compact();
    const compacted = run.snapshot();

    expect(compacted.raw.text).toBe('');
    expect(compacted.raw.total).toBe(rawTotal);
    expect(reply?.text()).toBe('');
    expect(reply?.size).toBe(replySize);
    expect(reply?.adapter).toBe('ag-ui');
    expect(compacted.rawSource).toBe('spill');
    expect(compacted.replySource).toBe('spill');
    expect(compacted.status).toBe('completed');
    await run.release();
  });

  it('reads the raw tail and the reply back as they were', async () => {
    const server = await track(startStreamServer());
    const run = startRun(runInput([stream(server)]), dependencies);
    const finished = await run.done;
    const liveRaw = finished.raw.text;
    const liveReply = finished.stream?.reply.text() ?? '';
    expect(liveReply.length).toBeGreaterThan(0);

    run.compact();

    expect(await run.readRaw()).toBe(liveRaw);
    expect(await run.readReply()).toBe(liveReply);
    await run.release();
  });

  it('reads them from memory while they are held', async () => {
    const server = await track(startStreamServer());
    const run = startRun(runInput([stream(server)]), dependencies);
    const finished = await run.done;

    expect(await run.readRaw()).toBe(finished.raw.text);
    expect(await run.readReply()).toBe(finished.stream?.reply.text());
    await run.release();
  });

  it('keeps the reply in a side file of the spill file until the run is released', async () => {
    const server = await track(startStreamServer());
    const area = spillArea();
    const run = startRun(runInput([stream(server)]), dependencies);
    await run.done;
    expect(readdirSync(area.directory)).toHaveLength(1);

    run.compact();
    await run.readReply();

    const names = readdirSync(area.directory).sort();
    expect(names).toHaveLength(2);
    expect(names[1]).toBe(`${names[0] ?? ''}.side`);
    await run.release();
    expect(readdirSync(area.directory)).toEqual([]);
  });

  it('frees the memory of the raw tail and the reply', async () => {
    const server = await track(startStreamServer());
    const run = startRun(runInput([stream(server, 'rate=80&seconds=1&size=65536')]), dependencies);
    const finished = await run.done;
    finished.stream?.store.release();
    expect(finished.raw.text.length).toBeGreaterThan(1_000_000);
    expect(finished.stream?.reply.size).toBe(1_048_576);
    collect();
    const before = process.memoryUsage().heapUsed;

    run.compact();
    await run.readReply();
    collect();
    const freed = before - process.memoryUsage().heapUsed;

    expect(freed).toBeGreaterThan(1_500_000);
    await run.release();
  });

  it('does not drop them while the run is still streaming', async () => {
    const server = await track(startStreamServer());
    const run = startRun(runInput([stream(server, 'rate=50&seconds=30&size=256')]), dependencies);
    await waitFor(() => (run.snapshot().stream?.reply.size ?? 0) > 0, 3000);

    run.compact();

    expect(run.snapshot().raw.text.length).toBeGreaterThan(0);
    expect(run.snapshot().stream?.reply.size).toBeGreaterThan(0);
    expect(run.snapshot().rawSource).toBe('memory');
    expect(run.snapshot().replySource).toBe('memory');
    expect((run.snapshot().stream?.reply.text() ?? '').length).toBeGreaterThan(0);
    await run.release();
  });

  it('drops the raw tail of a response that is a body too', async () => {
    const body = JSON.stringify({ items: Array.from({ length: 50 }, (_unused, id) => ({ id })) });
    const server = await track(
      startHttpServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(body);
      }),
    );
    const run = startRun(runInput([`GET ${server.url}`]), dependencies);
    await run.done;

    run.compact();

    expect(run.snapshot().raw.text).toBe('');
    expect(run.snapshot().rawSource).toBe('spill');
    expect(run.snapshot().replySource).toBe('memory');
    expect(await run.readRaw()).toBe(body);
    expect(await run.readReply()).toBe('');
    expect(readdirSync(spillArea().directory)).toHaveLength(1);
    await run.release();
  });

  it('says they are gone when the run has no spill file', async () => {
    const server = await track(startStreamServer());
    const run = startRun({ ...runInput([stream(server)]), spill: undefined }, dependencies);
    await run.done;

    run.compact();

    expect(run.snapshot().raw.text).toBe('');
    expect(run.snapshot().rawSource).toBe('gone');
    expect(run.snapshot().replySource).toBe('gone');
    expect(await run.readRaw()).toBeUndefined();
    expect(await run.readReply()).toBeUndefined();
    expect(run.snapshot().stream?.reply.adapter).toBe('ag-ui');
  });

  it('says they are gone once the spill file was evicted or the run released', async () => {
    const server = await track(startStreamServer());
    const area = spillArea();
    const files: SpillFile[] = [];
    const create = area.create.bind(area);
    vi.spyOn(area, 'create').mockImplementation(async () => {
      const file = await create();
      files.push(file);
      return file;
    });
    const evicted = startRun(runInput([stream(server)]), dependencies);
    await evicted.done;
    evicted.compact();
    await evicted.readReply();
    files[0]?.evict();
    const released = startRun(runInput([stream(server)]), dependencies);
    await released.done;
    released.compact();

    await released.release();

    for (const run of [evicted, released]) {
      expect(run.snapshot().rawSource).toBe('gone');
      expect(run.snapshot().replySource).toBe('gone');
      expect(await run.readRaw()).toBeUndefined();
      expect(await run.readReply()).toBeUndefined();
    }
  });

  it('says the reply is gone when its side file could not be written', async () => {
    const server = await track(startStreamServer());
    const area = spillArea();
    const create = area.create.bind(area);
    vi.spyOn(area, 'create').mockImplementation(async () => {
      const file = await create();
      vi.spyOn(file, 'writeSide').mockResolvedValue(false);
      return file;
    });
    const run = startRun(runInput([stream(server)]), dependencies);
    await run.done;

    run.compact();

    expect(await run.readReply()).toBeUndefined();
    expect(run.snapshot().replySource).toBe('gone');
    expect(run.snapshot().rawSource).toBe('spill');
    await run.release();
  });

  it('compacting twice changes nothing more', async () => {
    const server = await track(startStreamServer());
    const run = startRun(runInput([stream(server)]), dependencies);
    const finished = await run.done;
    const liveRaw = finished.raw.text;
    const liveReply = finished.stream?.reply.text() ?? '';

    run.compact();
    run.compact();

    expect(await run.readReply()).toBe(liveReply);
    expect(await run.readRaw()).toBe(liveRaw);
    expect(readdirSync(spillArea().directory)).toHaveLength(2);
    await run.release();
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

  it('drops the index of its events, so nothing can be read back', async () => {
    const server = await track(startStreamServer());
    const run = startRun(
      runInput([`GET ${server.url}/stream?rate=100&seconds=0.3&size=256`]),
      dependencies,
    );
    const store = (await run.done).stream?.store;
    run.compact();
    expect(run.indexBytes()).toBe(1024 * 27);
    expect(store?.summary(32)?.label).toBe('RUN_FINISHED');

    await run.release();

    expect(run.indexBytes()).toBe(0);
    expect(store?.indexBytes).toBe(0);
    expect(store?.summary(1)).toBeUndefined();
    expect(await store?.read(32)).toBeUndefined();
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

describe('headArrived', () => {
  it('settles when the head arrives, and when the run ends without one', async () => {
    const server = await track(
      startHttpServer((_request, response) => {
        response.writeHead(200);
        response.write('partial');
      }),
    );
    const receiving = startRun(runInput([`GET ${server.url}/hold`]), dependencies);
    await receiving.headArrived;
    expect(receiving.snapshot().head?.status).toBe(200);
    receiving.cancel();
    await receiving.done;

    const blocked = startRun(runInput(['GET https://api.example.test/{{missing}}']), dependencies);
    await blocked.done;
    await blocked.headArrived;
    expect(blocked.snapshot().head).toBeUndefined();
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

describe('the observer sees head, events and exactly one end on every exit path', () => {
  interface Recording {
    observer: RunObserver;
    heads: number[];
    accesses: RunAccess[];
    events: number[];
    ends: RunEnd[];
  }

  function recording(): Recording {
    const recorded: Recording = {
      observer: {
        head: (head, runAccess) => {
          recorded.heads.push(head.status);
          recorded.accesses.push(runAccess);
        },
        event: (event) => {
          recorded.events.push(event.index);
        },
        end: (end) => {
          recorded.ends.push(end);
        },
        backpressure: { congested: false, onDrain: () => () => undefined },
      },
      heads: [],
      accesses: [],
      events: [],
      ends: [],
    };
    return recorded;
  }

  function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 20));
  }

  async function observed(
    recorded: Recording,
    input: RunInput,
    transport?: Transport,
  ): Promise<{ snapshot: RunSnapshot; run: ReturnType<typeof startRun> }> {
    const run = startRun(
      { ...input, observer: recorded.observer },
      transport === undefined ? dependencies : { ...dependencies, transport },
    );
    const snapshot = await run.done;
    expect(recorded.ends).toHaveLength(1);
    await settle();
    expect(recorded.ends).toHaveLength(1);
    return { snapshot, run };
  }

  it('completed: an event stream, with its format, content type, body and reply', async () => {
    const server = await track(startStreamServer());
    const recorded = recording();

    const { snapshot, run } = await observed(
      recorded,
      runInput([`GET ${server.url}/stream?rate=100&seconds=0.2&size=256`]),
    );

    expect(snapshot.status).toBe('completed');
    expect(recorded.heads).toEqual([200]);
    const count = snapshot.stream?.store.count ?? 0;
    expect(count).toBeGreaterThan(2);
    expect(recorded.events).toEqual(Array.from({ length: count }, (_, at) => at + 1));
    const end = recorded.ends[0];
    if (end?.kind !== 'completed') {
      throw new Error(`expected a completed end, got ${String(end?.kind)}`);
    }
    expect(end.format).toBe('ndjson');
    expect(end.contentType).toBe('application/x-ndjson');
    expect(await end.readReply()).toBe(await run.readReply());
    expect((await end.readBody(1024))?.length).toBe(0);
    expect(end.reply).toEqual({ recognised: true, truncated: false });
    const runAccess = recorded.accesses[0];
    expect(runAccess?.signal).toBe(end.signal);
    expect(await runAccess?.spillPath(1)).toMatch(/\.spill$/);
    expect(await runAccess?.spillPath(Number.MAX_SAFE_INTEGER)).toBeUndefined();
  });

  it('completed: a JSON body that readBody returns whole or cut', async () => {
    const server = await track(
      startHttpServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end('{"token":"token-1"}');
      }),
    );
    const recorded = recording();

    await observed(recorded, runInput([`GET ${server.url}`]));

    expect(recorded.heads).toEqual([200]);
    expect(recorded.events).toEqual([]);
    const end = recorded.ends[0];
    if (end?.kind !== 'completed') {
      throw new Error(`expected a completed end, got ${String(end?.kind)}`);
    }
    expect(end.format).toBe('json');
    expect(end.contentType).toBe('application/json; charset=utf-8');
    expect(Buffer.from((await end.readBody(Number.MAX_SAFE_INTEGER)) ?? []).toString()).toBe(
      '{"token":"token-1"}',
    );
    expect(Buffer.from((await end.readBody(4)) ?? []).toString()).toBe('{"to');
    expect(end.bodyLength).toBe(19);
    expect(end.reply).toEqual({ recognised: false, truncated: false });
  });

  it('completed: names the spill file while it holds the bytes asked for', async () => {
    const body = Buffer.from(JSON.stringify({ padding: 'x'.repeat(2 * 1_048_576) }));
    const server = await track(
      startHttpServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(body);
      }),
    );
    const spilled = recording();
    const unspilled = recording();

    const { run } = await observed(spilled, runInput([`GET ${server.url}`]));
    await observed(unspilled, { ...runInput([`GET ${server.url}`]), spill: undefined });

    const end = spilled.ends[0];
    const without = unspilled.ends[0];
    if (end?.kind !== 'completed' || without?.kind !== 'completed') {
      throw new Error('expected completed ends');
    }
    expect(end.bodyLength).toBe(body.length);
    const file = await end.spillPath(body.length);
    expect(readFileSync(file ?? '').equals(body)).toBe(true);
    expect(await end.spillPath(body.length + 1)).toBeUndefined();
    expect(await without.spillPath(body.length)).toBeUndefined();
    expect(end.signal.aborted).toBe(false);
    await run.release();
    expect(end.signal.aborted).toBe(true);
    expect(await end.spillPath(body.length)).toBeUndefined();
  });

  it('failed: a run that never reached headers', async () => {
    const server = await startHttpServer((_request, response) => response.end());
    await server.close();
    const recorded = recording();

    const { snapshot } = await observed(recorded, runInput([`GET ${server.url}/gone`]));

    expect(snapshot.status).toBe('failed');
    expect(recorded.heads).toEqual([]);
    expect(recorded.events).toEqual([]);
    expect(recorded.ends).toEqual([{ kind: 'failed', message: snapshot.failure?.message }]);
  });

  it('failed: a transport that rejects', async () => {
    const recorded = recording();

    await observed(recorded, runInput(['GET https://api.example.test/items']), {
      send: () => Promise.reject(new Error('synthetic transport failure')),
    });

    expect(recorded.ends).toEqual([
      { kind: 'failed', message: 'The request could not be sent: synthetic transport failure.' },
    ]);
  });

  it('failed: a body too large', async () => {
    const server = await track(
      startHttpServer((_request, response) => {
        response.end(Buffer.alloc(4096, 'x'));
      }),
    );
    const recorded = recording();

    const { snapshot } = await observed(
      recorded,
      runInput([`GET ${server.url}`], { settings: { maxBodyBytes: 1024 } }),
    );

    expect(snapshot.failure?.kind).toBe('body-too-large');
    expect(recorded.heads).toEqual([200]);
    expect(recorded.ends).toEqual([{ kind: 'failed', message: snapshot.failure?.message }]);
  });

  it('cancelled: while receiving', async () => {
    const server = await track(
      startHttpServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        response.write('{"type":"RUN_STARTED","threadId":"thread-1"}\n');
      }),
    );
    const recorded = recording();
    const run = startRun(
      { ...runInput([`GET ${server.url}`]), observer: recorded.observer },
      dependencies,
    );
    await waitFor(() => recorded.events.length === 1, 2000);

    run.cancel();
    await run.done;
    await settle();

    expect(recorded.heads).toEqual([200]);
    expect(recorded.events).toEqual([1]);
    expect(recorded.ends).toEqual([{ kind: 'cancelled' }]);
  });

  it('cancelled: before sending', async () => {
    const server = await track(startHttpServer((_request, response) => response.end()));
    const recorded = recording();
    const run = startRun(
      { ...runInput([`GET ${server.url}`]), observer: recorded.observer },
      dependencies,
    );

    run.cancel();
    await run.done;
    await settle();

    expect(recorded.heads).toEqual([]);
    expect(recorded.ends).toEqual([{ kind: 'cancelled' }]);
  });

  it('cancelled: a send the user declined', async () => {
    const recorded = recording();

    await observed(
      recorded,
      runInput(['GET https://api.example.test/items'], {
        confirmSend: () => Promise.resolve(false),
      }),
    );

    expect(recorded.ends).toEqual([{ kind: 'cancelled' }]);
  });

  it('blocked: with the problems that stopped it', async () => {
    const recorded = recording();

    const { snapshot } = await observed(
      recorded,
      runInput(['GET https://api.example.test/{{missing}}/{{other}}']),
    );

    expect(snapshot.status).toBe('blocked');
    expect(recorded.heads).toEqual([]);
    expect(recorded.ends).toEqual([
      {
        kind: 'blocked',
        message: snapshot.problems.map((problem) => problem.message).join(' '),
      },
    ]);
    expect(snapshot.problems).toHaveLength(2);
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

describe('waiting for captured values', () => {
  const documentUri = 'file:///requests.http';
  const threadId = [{ name: 'threadId', secret: false }];
  const followUp = [
    '# @name startRun',
    '# @capture threadId = first(type == "RUN_STARTED").threadId',
    'POST https://api.example.test/agent/run',
    '',
    '###',
    '# @name continue',
    'GET https://api.example.test/threads/{{startRun.threadId}}',
  ];
  const startKey = `${documentUri}\n@startRun`;
  const folders: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const folder of folders.splice(0)) {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  function capturing(registry: CaptureRegistry, lines: string[], index: number): RunInput {
    const input = runInput(lines, { index });
    return {
      ...input,
      key: requestKey(documentUri, input.request, index),
      label: requestLabel(input.request),
      captures: new CaptureService({
        registry,
        documentUri,
        file: input.file,
        request: input.request,
        workerFile: missingWorker,
        runs: () => undefined,
      }),
    };
  }

  function resolved(text: string, runId: number): CaptureResult {
    return {
      state: 'resolved',
      text,
      secret: false,
      provenance: { runId, event: 1, path: 'threadId', time: 0 },
    };
  }

  function pendingProducer(registry: CaptureRegistry, id: number): void {
    registry.begin({ id, key: startKey, label: 'startRun', startedAt: -id }, threadId);
  }

  function at(line: number, start: number, end: number) {
    return { start: { line, character: start }, end: { line, character: end } };
  }

  function bodyFolder(name: string, contents: string): string {
    const folder = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'streamscope-wait-')));
    folders.push(folder);
    writeFileSync(path.join(folder, name), contents);
    return folder;
  }

  it('a request waits for a pending capture, then sends with its value', async () => {
    const streams = await track(startStreamServer());
    const api = await track(
      startHttpServer((_request, response) => {
        response.end('ok');
      }),
    );
    const registry = new CaptureRegistry();
    const lines = [
      '# @name startRun',
      '# @capture threadId = first(type == "RUN_STARTED").threadId',
      `GET ${streams.url}/stream?delayMs=300&seconds=0`,
      '',
      '###',
      '# @name continue',
      `GET ${api.url}/threads/{{startRun.threadId}}`,
    ];

    const producer = startRun(capturing(registry, lines, 0), dependencies);
    const consumer = startRun(capturing(registry, lines, 1), dependencies);
    await waitFor(() => consumer.snapshot().status === 'waiting');

    expect(consumer.snapshot().waitingFor).toBe('startRun › threadId');
    expect(api.requests).toEqual([]);
    const sent = await consumer.done;
    expect(sent.status).toBe('completed');
    expect(sent.waitingFor).toBeUndefined();
    expect(api.requests.map((request) => request.url)).toEqual(['/threads/thread-1']);
    expect(registry.waitCount).toBe(0);
    expect((await producer.done).status).toBe('completed');
  });

  it('the wait times out and blocks with the decision 10 message', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const registry = new CaptureRegistry();
    pendingProducer(registry, -1);

    const consumer = startRun(capturing(registry, followUp, 1), dependencies);
    await vi.advanceTimersByTimeAsync(30_000);
    const blocked = await consumer.done;

    expect(blocked.status).toBe('blocked');
    expect(blocked.problems).toEqual([
      { message: 'startRun › threadId did not arrive within 30 s.', range: at(6, 37, 58) },
    ]);
    expect(blocked.sent).toBeUndefined();
    expect(registry.waitCount).toBe(0);
  });

  it('cancelling a waiting run ends it cancelled and releases the wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const registry = new CaptureRegistry();
    pendingProducer(registry, -1);

    const consumer = startRun(capturing(registry, followUp, 1), dependencies);
    await vi.advanceTimersByTimeAsync(0);
    expect(consumer.snapshot().status).toBe('waiting');
    expect(registry.waitCount).toBe(1);
    consumer.cancel();
    const cancelled = await consumer.done;

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.waitingFor).toBeUndefined();
    expect(registry.waitCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a producer never run blocks at once with a producer name on the problem', async () => {
    const registry = new CaptureRegistry();
    const lines = [...followUp, 'X-Thread: {{threadId}}'];

    const blocked = await startRun(capturing(registry, lines, 1), dependencies).done;

    expect(blocked.status).toBe('blocked');
    expect(blocked.problems).toEqual([
      {
        message: '`{{startRun.threadId}}` comes from startRun, which has not run in this session.',
        range: at(6, 37, 58),
        producer: 'startRun',
      },
      {
        message: '`{{threadId}}` comes from startRun, which has not run in this session.',
        range: at(7, 10, 22),
        producer: 'startRun',
      },
    ]);
    expect(registry.waitCount).toBe(0);
  });

  it("begin resets the producer's captures before it resolves", async () => {
    const registry = new CaptureRegistry();
    pendingProducer(registry, -1);
    registry.update(-1, 'threadId', resolved('thread-0', -1));
    const changes: string[] = [];
    registry.onDidChange((entry) => {
      changes.push(`${String(entry.runId)} ${entry.result.state}`);
    });
    const lines = [
      '# @name startRun',
      '# @capture threadId = first(type == "RUN_STARTED").threadId',
      'POST https://api.example.test/{{missing}}',
    ];

    const producer = startRun(capturing(registry, lines, 0), dependencies);
    expect((await producer.done).status).toBe('blocked');
    await waitFor(() => registry.get(startKey, 'threadId')?.result.state === 'failed');

    expect(changes).toEqual([`${String(producer.id)} pending`, `${String(producer.id)} failed`]);
    expect(registry.get(startKey, 'threadId')?.result).toEqual({
      state: 'failed',
      reason:
        'startRun was not sent: `{{missing}}` is not defined in this file or `$shared` (no environment selected)',
    });
  });

  it('a request that re-captures the name it consumes sends its previous value', async () => {
    const api = await track(
      startHttpServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"next":"cursor-2"}');
      }),
    );
    const registry = new CaptureRegistry();
    const itemsKey = `${documentUri}\n@items`;
    registry.begin({ id: -1, key: itemsKey, label: 'items', startedAt: 0 }, [
      { name: 'nextCursor', secret: false },
    ]);
    registry.update(-1, 'nextCursor', resolved('cursor-1', -1));
    const lines = [
      '# @name items',
      '# @capture nextCursor = body.next',
      `GET ${api.url}/items?cursor={{nextCursor}}`,
    ];

    const sent = await startRun(capturing(registry, lines, 0), dependencies).done;
    await waitFor(() => registry.get(itemsKey, 'nextCursor')?.result.state === 'resolved');

    expect(sent.status).toBe('completed');
    expect(api.requests.map((request) => request.url)).toEqual(['/items?cursor=cursor-1']);
    expect(registry.get(itemsKey, 'nextCursor')?.result).toMatchObject({
      state: 'resolved',
      text: 'cursor-2',
    });
  });

  it('a request that consumes its own capture with no previous value is refused at once', async () => {
    const lines = [
      '# @name items',
      '# @capture nextCursor = body.next',
      'GET https://api.example.test/items?cursor={{nextCursor}}',
    ];

    const blocked = await startRun(capturing(new CaptureRegistry(), lines, 0), dependencies).done;

    expect(blocked.status).toBe('blocked');
    expect(blocked.problems).toEqual([
      { message: 'items cannot use its own capture nextCursor.', range: at(2, 42, 56) },
    ]);
  });

  it('a request whose capture, expect or until line has an expression error is blocked with it', async () => {
    const server = await track(startHttpServer((_request, response) => response.end()));
    const lines = [
      '# @name startRun',
      '# @capture threadId = first(type = "RUN_STARTED").threadId',
      '# @capture runId = first(type == "RUN_STARTED").runId',
      '# @capture runId = first(type == "RUN_STARTED").runId',
      '# @expect status = 201',
      '# @until type = "RUN_FINISHED"',
      `POST ${server.url}/agent/run`,
    ];
    const blocking = ['invalid-expression', 'duplicate-capture', 'too-many-captures'];
    const diagnostics = parseHttpFile(lines.join('\n')).diagnostics.filter((diagnostic) =>
      blocking.includes(diagnostic.code),
    );
    const expected = diagnostics.map(({ message, range }) => ({ message, range }));

    const blocked = await startRun(capturing(new CaptureRegistry(), lines, 0), dependencies).done;

    expect(diagnostics.map((diagnostic) => diagnostic.range.start.line)).toEqual([1, 3, 4, 5]);
    expect(blocked.status).toBe('blocked');
    expect(blocked.problems).toEqual(expected);
    expect(server.sockets.opened).toBe(0);
  });

  it('a capture used only inside a <@ body file waits like one in the request', async () => {
    const api = await track(
      startHttpServer((_request, response) => {
        response.end('ok');
      }),
    );
    const registry = new CaptureRegistry();
    pendingProducer(registry, -1);
    const folder = bodyFolder('template.json', '{"thread":"{{startRun.threadId}}"}');
    const lines = [
      ...followUp.slice(0, 6),
      `POST ${api.url}/continue`,
      'Content-Type: application/json',
      '',
      '<@ ./template.json',
    ];

    const consumer = startRun(
      {
        ...capturing(registry, lines, 1),
        bodyFiles: { documentDir: folder, containmentRoot: folder },
      },
      dependencies,
    );
    await waitFor(() => consumer.snapshot().status === 'waiting');
    expect(consumer.snapshot().waitingFor).toBe('startRun › threadId');
    registry.update(-1, 'threadId', resolved('thread-1', -1));
    const sent = await consumer.done;

    expect(sent.status).toBe('completed');
    expect(api.requests.map((request) => request.body.toString())).toEqual([
      '{"thread":"thread-1"}\n',
    ]);
  });

  it('a producer never run, used inside a <@ body file, blocks with its producer', async () => {
    const folder = bodyFolder('template.json', '{"thread":"{{startRun.threadId}}"}');
    const lines = [
      ...followUp.slice(0, 6),
      'POST https://api.example.test/continue',
      'Content-Type: application/json',
      '',
      '<@ ./template.json',
    ];

    const blocked = await startRun(
      {
        ...capturing(new CaptureRegistry(), lines, 1),
        bodyFiles: { documentDir: folder, containmentRoot: folder },
      },
      dependencies,
    ).done;

    expect(blocked.status).toBe('blocked');
    expect(blocked.problems).toEqual([
      {
        message: '`{{startRun.threadId}}` comes from startRun, which has not run in this session.',
        range: at(9, 3, 18),
        producer: 'startRun',
      },
    ]);
  });

  it('a fifth wait blocks with The captured values kept changing while continue waited.', async () => {
    const registry = new CaptureRegistry();
    pendingProducer(registry, -1);

    const consumer = startRun(capturing(registry, followUp, 1), dependencies);
    for (let round = 1; round <= 4; round += 1) {
      await waitFor(() => registry.waitCount === 1);
      expect(consumer.snapshot().status).toBe('waiting');
      registry.update(-round, 'threadId', resolved(`thread-${String(round)}`, -round));
      pendingProducer(registry, -round - 1);
    }
    const blocked = await consumer.done;

    expect(blocked.status).toBe('blocked');
    expect(blocked.problems).toEqual([
      {
        message: 'The captured values kept changing while continue waited.',
        range: at(6, 0, 58),
      },
    ]);
    expect(registry.waitCount).toBe(0);
  });
});
