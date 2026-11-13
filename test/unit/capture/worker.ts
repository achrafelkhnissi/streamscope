import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll } from 'vitest';

export const missingWorker = path.join(tmpdir(), 'streamscope-missing', 'capture-worker.js');

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
