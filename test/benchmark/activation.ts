import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { benchmarkEnvironment } from '../../src/benchmark/contract';
import { copyExtension } from './view/extension-copy';
import { profileSettings, vscodeArguments, vscodeEnvironment } from './view/launch';

export interface ActivationSummary {
  runsMs: number[];
  medianMs: number;
  maxMs: number;
}

export interface ActivationBenchmarkResult extends ActivationSummary {
  files: number;
  vscodeVersion: string;
}

export interface WorkspaceFile {
  name: string;
  content: string;
}

const runs = 5;
const launchTimeoutMs = 120_000;

export function summariseActivation(values: readonly number[]): ActivationSummary {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const medianMs =
    sorted.length % 2 === 1
      ? (sorted[middle] ?? Number.NaN)
      : ((sorted[middle - 1] ?? Number.NaN) + (sorted[middle] ?? Number.NaN)) / 2;
  return { runsMs: [...values], medianMs, maxMs: sorted.at(-1) ?? Number.NaN };
}

export function activationWorkspace(count: number): WorkspaceFile[] {
  return Array.from({ length: count }, (_, index) => {
    const item = index + 1;
    return {
      name: `requests/request-${String(item).padStart(3, '0')}.http`,
      content: `### Item ${String(item)}\nGET https://api.example.test/items/${String(item)}\n`,
    };
  });
}

export function readActivationResult(text: string | undefined): number {
  if (text === undefined) {
    throw new Error('The benchmark driver wrote no result.');
  }
  const value = JSON.parse(text) as { activationMs?: unknown; error?: unknown };
  if (typeof value.error === 'string') {
    throw new Error(value.error);
  }
  if (typeof value.activationMs !== 'number') {
    throw new Error('The benchmark driver wrote no activation time.');
  }
  return value.activationMs;
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
}

async function launchOnce(executable: string, files: readonly WorkspaceFile[]): Promise<number> {
  const root = process.cwd();
  const sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), 'ssa-')));
  try {
    const userDataDir = path.join(sandbox, 'ud');
    const extensionsDir = path.join(sandbox, 'ext');
    const workspace = path.join(sandbox, 'ws');
    const driverOut = path.join(sandbox, 'driver.json');
    for (const directory of [path.join(userDataDir, 'User'), extensionsDir, workspace]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(
      path.join(userDataDir, 'User', 'settings.json'),
      JSON.stringify(profileSettings()),
    );
    for (const file of files) {
      const target = path.join(workspace, file.name);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.content);
    }
    const extensionFolder = path.join(sandbox, 'streamscope');
    copyExtension(root, extensionFolder);
    const args = vscodeArguments({
      walkthrough: false,
      platform: process.platform,
      userDataDir,
      extensionsDir,
      developmentPaths: [extensionFolder],
      driver: path.join(root, 'out', 'benchmark', 'view-driver.js'),
      workspace,
    });
    const env = vscodeEnvironment(process.env, {
      [benchmarkEnvironment.enabled]: '1',
      [benchmarkEnvironment.mode]: 'activation',
      [benchmarkEnvironment.out]: driverOut,
    });
    const child = spawn(executable, args, { env, detached: true, stdio: 'ignore' });
    const pid = child.pid;
    if (pid === undefined) {
      throw new Error(`VS Code did not start: ${executable}`);
    }
    const timer = setTimeout(() => {
      killGroup(pid);
    }, launchTimeoutMs);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', () => {
          resolve();
        });
      });
    } finally {
      clearTimeout(timer);
      killGroup(pid);
    }
    return readActivationResult(
      existsSync(driverOut) ? readFileSync(driverOut, 'utf8') : undefined,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

export async function runActivationBenchmark(files: number): Promise<ActivationBenchmarkResult> {
  const executable = await downloadAndUnzipVSCode('stable');
  const workspaceFiles = activationWorkspace(files);
  const values: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    values.push(await launchOnce(executable, workspaceFiles));
  }
  const version = /(\d+\.\d+\.\d+)/.exec(executable)?.[1] ?? 'stable';
  return { files, vscodeVersion: version, ...summariseActivation(values) };
}
