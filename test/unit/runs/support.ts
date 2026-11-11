import { parseHttpFile } from '../../../src/http-file/parse';
import type { RequestSettings, RunDependencies, RunInput } from '../../../src/runs/run';
import { NodeTransport } from '../../../src/transport/node-transport';

export const defaultSettings: RequestSettings = {
  connectTimeoutMs: 5000,
  headersTimeoutMs: 5000,
  followRedirects: true,
  maxRedirects: 10,
  ca: undefined,
  maxBodyBytes: 268_435_456,
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
  options: { index?: number; key?: string; settings?: Partial<RequestSettings> } = {},
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
  };
}
