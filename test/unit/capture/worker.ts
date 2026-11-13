import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll } from 'vitest';

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
