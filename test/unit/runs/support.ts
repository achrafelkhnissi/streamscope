import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import { CaptureRegistry } from '../../../src/capture/registry';
import { CaptureService } from '../../../src/capture/service';
import { SpillArea } from '../../../src/events/spill';
import { parseHttpFile } from '../../../src/http-file/parse';
import type { RunCaptures, RunObserver } from '../../../src/runs/observer';
import type { RequestSettings, RunDependencies, RunInput } from '../../../src/runs/run';
import { defaultStreamLimits } from '../../../src/streaming/limits';
import type { VariableSources } from '../../../src/variables/sources';
import { NodeTransport } from '../../../src/transport/node-transport';
import { missingWorker } from '../capture/worker';

let currentSpillArea: SpillArea | undefined;

export function useSpillArea(): () => SpillArea {
  let root = '';
  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'streamscope-runs-'));
    currentSpillArea = await SpillArea.open(root);
  });
  afterEach(async () => {
    await currentSpillArea?.dispose();
    currentSpillArea = undefined;
    rmSync(root, { recursive: true, force: true });
  });
  return spillArea;
}

function spillArea(): SpillArea {
  if (currentSpillArea === undefined) {
    throw new Error('call useSpillArea() in the test file first');
  }
  return currentSpillArea;
}

export const defaultSettings: RequestSettings = {
  connectTimeoutMs: 5000,
  headersTimeoutMs: 5000,
  followRedirects: true,
  maxRedirects: 10,
  ca: undefined,
  maxBodyBytes: 268_435_456,
  insecureEnvironment: false,
};

export const emptyVariables: Omit<VariableSources, 'system' | 'restricted' | 'captures'> = {
  environmentName: undefined,
  environment: new Map(),
  shared: new Map(),
  secrets: new Map(),
  dotenv: { kind: 'missing' },
  processEnv: {},
};

export const dependencies: RunDependencies = {
  transport: new NodeTransport(),
  system: {
    now: () => new Date('2026-11-11T10:20:30.456Z'),
    uuid: () => '00000000-0000-4000-8000-000000000001',
    randomInt: (minInclusive) => minInclusive,
  },
  clock: () => performance.now(),
};

export function runInput(
  lines: string[],
  options: {
    index?: number;
    key?: string;
    settings?: Partial<RequestSettings>;
    variables?: Partial<RunInput['variables']>;
    restricted?: boolean;
    confirmSend?: () => Promise<boolean>;
  } = {},
): RunInput {
  const file = parseHttpFile(lines.join('\n'));
  const index = options.index ?? 0;
  const request = file.requests[index];
  if (!request) {
    throw new Error(`expected request ${String(index)}`);
  }
  return {
    key: options.key ?? `file:///requests.http\n#${String(index)}`,
    label: `request ${String(index)}`,
    file,
    request,
    bodyFiles: { documentDir: undefined, containmentRoot: undefined },
    settings: { ...defaultSettings, ...options.settings },
    variables: { ...emptyVariables, ...options.variables },
    restricted: options.restricted ?? false,
    confirmSend: options.confirmSend,
    spill: spillArea(),
    limits: defaultStreamLimits,
    captures: new CaptureService({
      registry: new CaptureRegistry(),
      documentUri: 'file:///requests.http',
      file,
      request,
      workerFile: missingWorker,
      runs: () => undefined,
    }),
    waitTimeoutMs: 30_000,
  };
}

export function withObserver(input: RunInput, observer: RunObserver): RunInput {
  const captures: RunCaptures = input.captures;
  return {
    ...input,
    captures: {
      lookup: captures.lookup,
      begin: (run) => {
        captures.begin(run);
      },
      settle: (waits, runId, signal) => captures.settle(waits, runId, signal),
      wait: (waits, runId, options) => captures.wait(waits, runId, options),
      observer: (run) => {
        if (captures.observer(run) !== undefined) {
          throw new Error('withObserver takes a request without # @capture lines');
        }
        return observer;
      },
    },
  };
}
