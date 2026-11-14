import { afterEach, describe, expect, it } from 'vitest';
import { CaptureRegistry } from '../../../src/capture/registry';
import { CaptureService } from '../../../src/capture/service';
import { CheckRegistry } from '../../../src/checks/registry';
import { CheckService } from '../../../src/checks/service';
import { startRun } from '../../../src/runs/run';
import { startHttpServer, type LocalServer } from '../../support/servers';
import { missingWorker } from '../capture/worker';
import { dependencies, runInput, useSpillArea } from './support';

const servers: LocalServer[] = [];
useSpillArea();

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('startRun with checks', () => {
  it('runs captures and checks of the same request side by side', async () => {
    const server = await startHttpServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      response.end(
        [
          '{"type":"RUN_STARTED","threadId":"t-1"}',
          '{"type":"TEXT","delta":"a"}',
          '{"type":"TEXT","delta":"b"}',
          '{"type":"RUN_FINISHED"}',
          '',
        ].join('\n'),
      );
    });
    servers.push(server);
    const lines = [
      '# @capture threadId = first(type == "RUN_STARTED").threadId',
      '# @expect count(type == "TEXT") > 1',
      '# @expect status == 201',
      `GET ${server.url}/stream`,
    ];
    const input = runInput(lines);
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
    expect(snapshot.stream?.store.count).toBe(4);
    expect(captures.get(input.key, 'threadId')?.result).toMatchObject({
      state: 'resolved',
      text: 't-1',
    });
    expect(checks.forRequest(input.key).map(({ result }) => result)).toEqual([
      { state: 'passed', settledAt: 3 },
      { state: 'failed', detail: 'got 200', settledAt: undefined },
    ]);
    await run.release();
  });
});
