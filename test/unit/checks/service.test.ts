import { describe, expect, it } from 'vitest';
import { CheckRegistry } from '../../../src/checks/registry';
import { CheckService } from '../../../src/checks/service';
import { parseHttpFile } from '../../../src/http-file/parse';
import { missingWorker } from '../capture/worker';

function request(lines: readonly string[]) {
  const found = parseHttpFile(lines.join('\n')).requests[0];
  if (found === undefined) {
    throw new Error('no request');
  }
  return found;
}

const head = { httpVersion: '1.1', status: 201, statusText: 'Created', headers: [] };
const access = {
  spillPath: () => Promise.resolve(undefined),
  signal: new AbortController().signal,
};
const run = { id: 3, label: 'make', wallStartedAt: 0, sensitiveValues: [] };

describe('CheckService', () => {
  it("builds definitions from the request's expects, skipping ones with syntax errors", () => {
    const registry = new CheckRegistry();
    const service = new CheckService({
      registry,
      request: request([
        '# @expect status == 201',
        '# @expect status ==',
        '# @expect status != 500',
        'POST https://example.test/make',
      ]),
      workerFile: missingWorker,
    });

    service.begin({ id: 3, key: 'k', startedAt: 0 });

    expect(registry.forRequest('k').map(({ text, line }) => [text, line])).toEqual([
      ['status == 201', 0],
      ['status != 500', 2],
    ]);
  });

  it('reports results into the registry', () => {
    const registry = new CheckRegistry();
    const service = new CheckService({
      registry,
      request: request(['# @expect status == 200', 'POST https://example.test/make']),
      workerFile: missingWorker,
    });
    service.begin({ id: 3, key: 'k', startedAt: 0 });

    service.observer(run)?.head(head, access);

    expect(registry.forRequest('k')[0]?.result).toEqual({
      state: 'failed',
      detail: 'got 201',
      settledAt: undefined,
    });
  });

  it('has no observer for a request without checks', () => {
    const service = new CheckService({
      registry: new CheckRegistry(),
      request: request(['GET https://example.test/a']),
      workerFile: missingWorker,
    });
    expect(service.observer(run)).toBeUndefined();
  });
});
