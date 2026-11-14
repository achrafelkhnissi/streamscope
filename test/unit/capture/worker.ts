import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll } from 'vitest';
import { TaskBudget } from '../../../src/capture/task-budget';
import type { WorkBudget } from '../../../src/expressions/work';

export const missingWorker = path.join(tmpdir(), 'streamscope-missing', 'capture-worker.js');

export async function expectNoChild(): Promise<void> {
  const deadline = performance.now() + 2000;
  while (process.getActiveResourcesInfo().includes('ProcessWrap')) {
    if (performance.now() > deadline) {
      throw new Error('a child process is still running');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function longestStall<T>(
  work: () => Promise<T>,
): Promise<{ result: T; stallMs: number }> {
  let longest = 0;
  let last = performance.now();
  const ticker = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last - 2);
    last = now;
  }, 2);
  try {
    const started = performance.now();
    const pending = work();
    const synchronous = performance.now() - started;
    const result = await pending;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { result, stallMs: Math.max(longest, synchronous) };
  } finally {
    clearInterval(ticker);
  }
}

export interface WorkerFiles {
  worker: string;
  script(name: string, source: string): string;
}

export function useCaptureWorker(): () => WorkerFiles {
  let folder: string | undefined;
  let files: WorkerFiles | undefined;
  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'streamscope-capture-'));
    folder = root;
    const worker = path.join(root, 'capture-worker.js');
    await esbuild.build({
      entryPoints: ['src/capture/body-worker.ts'],
      outfile: worker,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'node22',
      logLevel: 'silent',
    });
    files = {
      worker,
      script(name, source) {
        const file = path.join(root, `${name}.js`);
        writeFileSync(file, source);
        return file;
      },
    };
  });
  afterAll(() => {
    if (folder !== undefined) {
      rmSync(folder, { recursive: true, force: true });
    }
  });
  return () => {
    if (files === undefined) {
      throw new Error('the capture worker is not built yet');
    }
    return files;
  };
}

export class CountedBudget extends TaskBudget {
  entries = 0;
  units = 0;
  private counted: WorkBudget | undefined;

  override enter(): WorkBudget {
    this.entries += 1;
    const work = super.enter();
    if (this.counted !== work) {
      this.counted = work;
      const spend = work.spend.bind(work);
      work.spend = (units: number): void => {
        this.units += units;
        spend(units);
      };
    }
    return work;
  }
}

export interface ChildRequest {
  kind: string;
  path: string | null;
  query: string | null;
  bytes: number | null;
  jobs: string[];
}

export function recordingWorker(
  files: WorkerFiles,
  name: string,
): { file: string; requests: () => ChildRequest[] } {
  const log = files.script(`${name}-requests`, '');
  const file = files.script(
    name,
    [
      "const { appendFileSync } = require('node:fs');",
      "process.once('message', ({ subject, jobs }) => {",
      '  const request = {',
      '    kind: subject.kind,',
      '    path: subject.path ?? null,',
      '    query: subject.query?.kind ?? null,',
      '    bytes: subject.bytes?.length ?? null,',
      '    jobs: jobs.map((job) => job.name),',
      '  };',
      `  appendFileSync(${JSON.stringify(log)}, JSON.stringify(request) + '\\n');`,
      '});',
      `require(${JSON.stringify(files.worker)});`,
    ].join('\n'),
  );
  return {
    file,
    requests: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as ChildRequest),
  };
}
