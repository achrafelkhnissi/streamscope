import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
  writeSync,
} from 'node:fs';
import type * as http from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { benchmarkEnvironment } from '../../../src/benchmark/contract';
import { startHttpServer, type LocalServer } from '../../support/servers';
import { startStreamServer } from '../../support/stream-server';
import { captureScreenshot } from './devtools';
import {
  checkSurfaceName,
  devToolsPort,
  screenshotName,
  vscodeArguments,
  vscodeEnvironment,
} from './launch';
import { sampleProcesses, summariseProcessSamples, type ProcessSample } from './processes';
import {
  checkSurfaceResult,
  expectedEvents,
  readDriverResult,
  type ViewBenchmarkResult,
} from './results';

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

function screenshotHandler(
  token: string,
  port: () => number | undefined,
  directory: string,
  saved: string[],
): http.RequestListener {
  return (request, response) => {
    const name = screenshotName(request.url, token);
    if (name === undefined) {
      response.writeHead(400).end('Expected /<token>/screenshot?name=<lowercase-name>.');
      return;
    }
    const devTools = port();
    if (devTools === undefined) {
      response.writeHead(503).end('VS Code has not reported its DevTools port yet.');
      return;
    }
    const file = path.join(directory, `${name}.jpeg`);
    const relative = path.relative(process.cwd(), file);
    captureScreenshot(devTools, file).then(
      () => {
        saved.push(relative);
        response.writeHead(200).end(relative);
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
  const surfaceError = checkSurfaceName(options.surface);
  if (surfaceError !== undefined) {
    throw new Error(surfaceError);
  }
  const root = process.cwd();
  const stream = options.walkthrough
    ? walkthroughStream
    : { rate: options.rate, seconds: options.seconds, eventBytes: options.eventBytes };
  const timeoutSeconds = options.walkthrough
    ? walkthroughTimeoutSeconds
    : options.seconds + extraSeconds;
  const outDirectory = path.join(root, 'out', 'benchmark');
  const screenshotDirectory = path.join(outDirectory, 'screenshots');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const samples: ProcessSample[] = [];
  const screenshots: string[] = [];
  const token = randomBytes(16).toString('hex');
  let sandbox: string | undefined;
  let child: ChildProcess | undefined;
  let log: number | undefined;
  let streamServer: LocalServer | undefined;
  let controlServer: LocalServer | undefined;
  let devTools: number | undefined;
  let timeoutError: string | undefined;
  const stopNow = (): void => {
    if (child?.pid !== undefined) {
      killGroup(child.pid);
    }
    if (sandbox !== undefined) {
      rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    stopNow();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    mkdirSync(screenshotDirectory, { recursive: true });
    sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), 'ssv-')));
    const userDataDir = path.join(sandbox, 'ud');
    const extensionsDir = path.join(sandbox, 'ext');
    const workspace = path.join(sandbox, 'ws');
    const driverOut = path.join(sandbox, 'driver.json');
    for (const directory of [path.join(userDataDir, 'User'), extensionsDir, workspace]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(path.join(userDataDir, 'User', 'settings.json'), JSON.stringify(settings));
    log = openSync(path.join(outDirectory, `view-${options.surface}-${stamp}.log`), 'w');
    const logFile = log;
    streamServer = await startStreamServer();
    if (options.walkthrough) {
      controlServer = await startHttpServer(
        screenshotHandler(token, () => devTools, screenshotDirectory, screenshots),
      );
    }
    const executable = await downloadAndUnzipVSCode('stable');
    const args = vscodeArguments({
      walkthrough: options.walkthrough,
      platform: process.platform,
      userDataDir,
      extensionsDir,
      developmentPaths: [root, ...options.extensions.map((folder) => path.resolve(root, folder))],
      driver: path.join(outDirectory, 'view-driver.js'),
      workspace,
    });
    const env = vscodeEnvironment(process.env, {
      [benchmarkEnvironment.enabled]: '1',
      [benchmarkEnvironment.mode]: options.walkthrough ? 'walkthrough' : 'stream',
      [benchmarkEnvironment.url]: `${streamServer.url}/stream?format=ndjson&rate=${String(stream.rate)}&seconds=${String(stream.seconds)}&size=${String(stream.eventBytes)}`,
      [benchmarkEnvironment.surface]: options.surface,
      [benchmarkEnvironment.control]:
        controlServer === undefined ? '' : `${controlServer.url}/${token}`,
      [benchmarkEnvironment.out]: driverOut,
    });
    const started = spawn(executable, args, {
      env,
      detached: true,
      stdio: ['ignore', logFile, 'pipe'],
    });
    child = started;
    const pid = started.pid;
    if (pid === undefined) {
      throw new Error(`VS Code did not start: ${executable}`);
    }
    let stderr = '';
    started.stderr?.on('data', (chunk: Buffer) => {
      writeSync(logFile, chunk);
      if (options.walkthrough && devTools === undefined) {
        stderr += chunk.toString('utf8');
        devTools = devToolsPort(stderr);
      }
    });
    const state = { exited: false };
    const exit = new Promise<void>((resolve, reject) => {
      started.once('error', reject);
      started.once('exit', () => {
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
    const checkError = options.walkthrough
      ? undefined
      : checkSurfaceResult(driver.surface, expectedEvents(stream.rate, stream.seconds));
    const result: ViewBenchmarkResult = {
      ...driver,
      error: timeoutError ?? driver.error ?? checkError,
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
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (log !== undefined) {
      closeSync(log);
    }
    await streamServer?.close();
    await controlServer?.close();
    stopNow();
  }
}
