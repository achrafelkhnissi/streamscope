import type * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { CaptureRegistry } from '../../../src/capture/registry';
import { CaptureService } from '../../../src/capture/service';
import { CheckRegistry } from '../../../src/checks/registry';
import { CheckService } from '../../../src/checks/service';
import { startRun, type RunSnapshot } from '../../../src/runs/run';
import { startHttpServer, type LocalServer } from '../../support/servers';
import { missingWorker } from '../capture/worker';
import { dependencies, runInput, useSpillArea } from './support';

const servers: LocalServer[] = [];
useSpillArea();

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function line(n: number, type = 'STEP'): string {
  return `${JSON.stringify({ type, n })}\n`;
}

function streamEvery(
  intervalMs: number,
  typeOf: (n: number) => string,
): (request: http.IncomingMessage, response: http.ServerResponse) => void {
  return (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      response.write(line(n, typeOf(n)));
    }, intervalMs);
    response.on('close', () => {
      clearInterval(timer);
    });
  };
}

async function serve(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
): Promise<LocalServer> {
  const server = await startHttpServer(handler);
  servers.push(server);
  return server;
}

async function closedWithin(server: LocalServer, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (server.sockets.closed === 0) {
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

async function runLines(lines: string[]): Promise<RunSnapshot> {
  const run = startRun(runInput(lines), dependencies);
  const snapshot = await run.done;
  await run.release();
  return snapshot;
}

describe('startRun with # @until', () => {
  it('completes at the first matching event and closes the connection', async () => {
    const server = await serve(streamEvery(50, (n) => (n === 3 ? 'RUN_FINISHED' : 'STEP')));
    const started = Date.now();

    const run = startRun(
      runInput(['# @until type == "RUN_FINISHED"', `GET ${server.url}/stream`]),
      dependencies,
    );
    const snapshot = await run.done;

    expect(snapshot.status).toBe('completed');
    expect(snapshot.failure).toBeUndefined();
    expect(snapshot.untilEvent).toBe(3);
    expect(snapshot.stream?.store.count).toBe(3);
    expect(await closedWithin(server, 1_000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    await run.release();
  });

  it('ends at the matching event when it shares a chunk with later events', async () => {
    const server = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      response.write([1, 2, 3, 4, 5, 6].map((n) => line(n, n === 3 ? 'DONE' : 'STEP')).join(''));
    });

    const snapshot = await runLines(['# @until type == "DONE"', `GET ${server.url}/stream`]);

    expect(snapshot.status).toBe('completed');
    expect(snapshot.untilEvent).toBe(3);
    expect(snapshot.stream?.store.count).toBe(3);
  });

  it('lets captures and checks see the matching event and nothing after it', async () => {
    const server = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      response.write(
        [1, 2, 3, 4, 5, 6].map((n) => line(n, n === 3 ? 'RUN_FINISHED' : 'STEP')).join(''),
      );
    });
    const input = runInput([
      '# @capture lastN = last().n',
      '# @expect count() == 3',
      '# @until type == "RUN_FINISHED"',
      `GET ${server.url}/stream`,
    ]);
    const captures = new CaptureRegistry();
    const checks = new CheckRegistry();
    const run = startRun(
      {
        ...input,
        captures: new CaptureService({
          registry: captures,
          documentUri: 'file:///requests.http',
          file: input.file,
          request: input.request,
          workerFile: missingWorker,
          runs: () => undefined,
        }),
        checks: new CheckService({
          registry: checks,
          request: input.request,
          workerFile: missingWorker,
        }),
      },
      dependencies,
    );

    const snapshot = await run.done;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(snapshot.status).toBe('completed');
    expect(captures.get(input.key, 'lastN')?.result).toMatchObject({
      state: 'resolved',
      text: '3',
    });
    expect(checks.forRequest(input.key).map(({ result }) => result.state)).toEqual(['passed']);
    await run.release();
  });

  it('fails a run whose # @until needs too much work', async () => {
    const sevens = Array<string>(1_300).fill('7').join(',');
    const server = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      response.write(
        `${JSON.stringify({ type: 'A', items: [...Array<number>(400).fill(0), 7] })}\n`,
      );
    });

    const snapshot = await runLines([
      `# @until items[?@ in [${sevens}]]`,
      `GET ${server.url}/stream`,
    ]);

    expect(snapshot.status).toBe('failed');
    expect(snapshot.failure).toEqual({
      kind: 'until-work',
      message: '# @until needs too much work for event 1, so Streamscope stopped the request.',
    });
    expect(snapshot.untilEvent).toBeUndefined();
  });

  it('blocks a request with an empty # @until', async () => {
    const server = await serve((_request, response) => {
      response.end('ok');
    });

    const snapshot = await runLines(['# @until', `GET ${server.url}/stream`]);

    expect(snapshot.status).toBe('blocked');
    expect(snapshot.problems.map(({ message }) => message)).toEqual([
      'Expected an event condition after "# @until".',
    ]);
    expect(server.requests).toHaveLength(0);
  });

  it('has no effect on a JSON body', async () => {
    const server = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ type: 'RUN_FINISHED', items: [1, 2] }, null, 2));
    });

    const snapshot = await runLines([
      '# @until type == "RUN_FINISHED"',
      `GET ${server.url}/stream`,
    ]);

    expect(snapshot.status).toBe('completed');
    expect(snapshot.untilEvent).toBeUndefined();
    expect(snapshot.bodyLength).toBeGreaterThan(0);
  });
});
