import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type * as http from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { benchmarkEnvironment } from '../../../src/benchmark/contract';
import { startHttpServer } from '../../support/servers';
import { startStreamServer } from '../../support/stream-server';
import { captureScreenshot, freePort } from './devtools';
import { sampleProcesses, summariseProcessSamples, type ProcessSample } from './processes';
import { checkSurfaceResult, readDriverResult, type ViewBenchmarkResult } from './results';

export interface ViewBenchmarkOptions {
  surface: string;
  rate: number;
  seconds: number;
  eventBytes: number;
  walkthrough: boolean;
  extensions: readonly string[];
}

const walkthroughStream = { rate: 20, seconds: 120, eventBytes: 256 };
const walkthroughTimeoutSeconds = 300;
const extraSeconds = 180;
const sampleMs = 5000;
const screenshotName = /^[a-z0-9-]+$/;

const settings = {
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.autoCheckUpdates': false,
  'chat.disableAIFeatures': true,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function screenshotHandler(port: number, directory: string, saved: string[]): http.RequestListener {
  return (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const name = url.searchParams.get('name') ?? '';
    if (url.pathname !== '/screenshot' || !screenshotName.test(name)) {
      response.writeHead(400).end('Expected /screenshot?name=<lowercase-name>.');
      return;
    }
    const file = path.join(directory, `${name}.jpeg`);
    captureScreenshot(port, file).then(
      () => {
        saved.push(path.relative(process.cwd(), file));
        response.writeHead(200).end(file);
      },
      (error: unknown) => {
        response.writeHead(500).end(error instanceof Error ? error.message : String(error));
      },
    );
  };
}

export async function runViewBenchmark(
  options: ViewBenchmarkOptions,
): Promise<ViewBenchmarkResult> {
  const root = process.cwd();
  const stream = options.walkthrough
    ? walkthroughStream
    : { rate: options.rate, seconds: options.seconds, eventBytes: options.eventBytes };
  const timeoutSeconds = options.walkthrough
    ? walkthroughTimeoutSeconds
    : options.seconds + extraSeconds;
  const outDirectory = path.join(root, 'out', 'benchmark');
  const screenshotDirectory = path.join(outDirectory, 'screenshots');
  mkdirSync(screenshotDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), 'ssv-')));
  const userDataDir = path.join(sandbox, 'ud');
  const extensionsDir = path.join(sandbox, 'ext');
  const workspace = path.join(sandbox, 'ws');
  const driverOut = path.join(sandbox, 'driver.json');
  for (const directory of [path.join(userDataDir, 'User'), extensionsDir, workspace]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(path.join(userDataDir, 'User', 'settings.json'), JSON.stringify(settings));
  const port = await freePort();
  const screenshots: string[] = [];
  const streamServer = await startStreamServer();
  const controlServer = await startHttpServer(
    screenshotHandler(port, screenshotDirectory, screenshots),
  );
  const log = openSync(path.join(outDirectory, `view-${options.surface}-${stamp}.log`), 'w');
  const samples: ProcessSample[] = [];
  let timeoutError: string | undefined;
  try {
    const executable = await downloadAndUnzipVSCode('stable');
    const args = [
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--disable-updates',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-extensions',
      '--disable-workspace-trust',
      `--remote-debugging-port=${String(port)}`,
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-background-timer-throttling',
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${extensionsDir}`,
      `--extensionDevelopmentPath=${root}`,
      ...options.extensions.map(
        (extension) => `--extensionDevelopmentPath=${path.resolve(root, extension)}`,
      ),
      `--extensionTestsPath=${path.join(outDirectory, 'view-driver.js')}`,
      workspace,
    ];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      [benchmarkEnvironment.enabled]: '1',
      [benchmarkEnvironment.mode]: options.walkthrough ? 'walkthrough' : 'stream',
      [benchmarkEnvironment.url]: `${streamServer.url}/stream?format=ndjson&rate=${String(stream.rate)}&seconds=${String(stream.seconds)}&size=${String(stream.eventBytes)}`,
      [benchmarkEnvironment.surface]: options.surface,
      [benchmarkEnvironment.control]: controlServer.url,
      [benchmarkEnvironment.out]: driverOut,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, args, { env, detached: true, stdio: ['ignore', log, log] });
    const pid = child.pid;
    if (pid === undefined) {
      throw new Error(`VS Code did not start: ${executable}`);
    }
    const state = { exited: false };
    const exit = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => {
        state.exited = true;
        resolve();
      });
    });
    const timer = setTimeout(() => {
      timeoutError = `VS Code did not finish within ${String(timeoutSeconds)} s.`;
      killGroup(pid);
    }, timeoutSeconds * 1000);
    try {
      while (!state.exited) {
        samples.push(await sampleProcesses(pid, () => performance.now()));
        await Promise.race([delay(sampleMs), exit]);
      }
      await exit;
    } finally {
      clearTimeout(timer);
      killGroup(pid);
    }
    const driver = readDriverResult(
      existsSync(driverOut) ? readFileSync(driverOut, 'utf8') : undefined,
      options.walkthrough ? 'walkthrough' : 'stream',
    );
    const surfaceError =
      driver.surface === undefined ? undefined : checkSurfaceResult(driver.surface);
    const result: ViewBenchmarkResult = {
      ...driver,
      error: timeoutError ?? driver.error ?? surfaceError,
      surfaceName: options.surface,
      rate: stream.rate,
      seconds: stream.seconds,
      eventBytes: stream.eventBytes,
      processes: summariseProcessSamples(samples, pid),
      screenshots,
    };
    writeFileSync(
      path.join(outDirectory, `view-${options.surface}-${stamp}.json`),
      JSON.stringify(result, null, 2),
    );
    return result;
  } finally {
    closeSync(log);
    await streamServer.close();
    await controlServer.close();
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
