import type * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { CaptureRegistry } from '../../../src/capture/registry';
import { CaptureService } from '../../../src/capture/service';
import { CheckRegistry } from '../../../src/checks/registry';
import { CheckService } from '../../../src/checks/service';
import { startRun, type RunSnapshot } from '../../../src/runs/run';
import { startHttpServer, type LocalServer } from '../../support/servers';
import { missingWorker, useCaptureWorker } from '../capture/worker';
import { dependencies, runInput, useSpillArea } from './support';

const servers: LocalServer[] = [];
useSpillArea();
const workerFiles = useCaptureWorker();

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

describe('startRun with # @until after the review', () => {
  async function untilRun(
    body: string,
    lines: string[],
  ): Promise<{
    snapshot: RunSnapshot;
    captures: CaptureRegistry;
    checks: CheckRegistry;
    key: string;
  }> {
    const server = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      response.write(body);
    });
    const input = runInput([...lines, `GET ${server.url}/stream`]);
    const captures = new CaptureRegistry();
    const checks = new CheckRegistry();
    const worker = workerFiles().worker;
    const run = startRun(
      {
        ...input,
        captures: new CaptureService({
          registry: captures,
          documentUri: 'file:///requests.http',
          file: input.file,
          request: input.request,
          workerFile: worker,
          runs: () => undefined,
        }),
        checks: new CheckService({ registry: checks, request: input.request, workerFile: worker }),
      },
      dependencies,
    );
    const snapshot = await run.done;
    await checks.settled(input.key, snapshot.id);
    await captures.settled(snapshot.id);
    await run.release();
    return { snapshot, captures, checks, key: input.key };
  }

  it('lets all(…) captures and unique(all(…)) checks of a run ended by # @until resolve', async () => {
    const body = [
      { type: 'TOOL_CALL_START', id: 'a' },
      { type: 'TOOL_CALL_START', id: 'b' },
      { type: 'TEXT', n: 3 },
      { type: 'RUN_FINISHED' },
      { type: 'TOOL_CALL_START', id: 'c' },
    ]
      .map((value) => `${JSON.stringify(value)}\n`)
      .join('');

    const { snapshot, captures, checks, key } = await untilRun(body, [
      '# @capture ids = all(type == "TOOL_CALL_START").id',
      '# @expect unique(all(type == "TOOL_CALL_START").id)',
      '# @until type == "RUN_FINISHED"',
    ]);

    expect(snapshot.status).toBe('completed');
    expect(snapshot.untilEvent).toBe(4);
    expect(captures.get(key, 'ids')?.result).toMatchObject({
      state: 'resolved',
      text: '["a","b"]',
    });
    expect(checks.forRequest(key).map(({ result }) => result.state)).toEqual(['passed']);
  }, 30_000);

  it('lets captures and checks of a burst ended by # @until resolve', async () => {
    const lines: string[] = [];
    for (let n = 1; n < 20_000; n += 1) {
      lines.push(line(n));
    }
    lines.push(line(20_000, 'DONE'));
    lines.push(line(20_001));

    const { snapshot, captures, checks, key } = await untilRun(lines.join(''), [
      '# @capture doneN = first(type == "DONE").n',
      '# @capture lastN = last().n',
      '# @expect count(type == "STEP") == 19999',
      '# @until type == "DONE"',
    ]);

    expect(snapshot.status).toBe('completed');
    expect(snapshot.untilEvent).toBe(20_000);
    expect(captures.get(key, 'doneN')?.result).toMatchObject({ state: 'resolved', text: '20000' });
    expect(captures.get(key, 'lastN')?.result).toMatchObject({ state: 'resolved', text: '20000' });
    expect(checks.forRequest(key).map(({ result }) => result.state)).toEqual(['passed']);
  }, 30_000);
});
