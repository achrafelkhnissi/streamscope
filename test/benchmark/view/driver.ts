import { writeFileSync } from 'node:fs';
import * as http from 'node:http';
import * as vscode from 'vscode';
import {
  benchmarkCommands,
  benchmarkEnvironment,
  screenshotUrl,
  type StreamBenchmarkRequest,
  type StreamBenchmarkResult,
  type WalkthroughRequest,
} from '../../../src/benchmark/contract';
import { LatencyHistogram } from '../../../src/benchmark/latency';
import { LongTaskRecorder } from './long-tasks';
import type { DriverResult, ExtensionHostResult } from './results';

const commandWaitMs = 15_000;
const lineLength = 80;

function setting(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set.`);
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function get(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          if (response.statusCode === 200) {
            resolve();
          } else {
            reject(new Error(Buffer.concat(chunks).toString('utf8')));
          }
        });
        response.on('error', reject);
      })
      .on('error', reject);
  });
}

async function activateStreamscope(): Promise<void> {
  await Promise.all(
    vscode.extensions.all
      .filter((extension) => extension.id.startsWith('achrafelkhnissi.'))
      .map((extension) => extension.activate()),
  );
}

async function waitForCommand(command: string): Promise<void> {
  const deadline = performance.now() + commandWaitMs;
  while (!(await vscode.commands.getCommands(true)).includes(command)) {
    if (performance.now() > deadline) {
      throw new Error(
        `No response surface registered ${command}. Pass --extension <path> to load one.`,
      );
    }
    await delay(250);
  }
}

async function streamMode(
  url: string,
  surface: string,
): Promise<Pick<DriverResult, 'surface' | 'extensionHost' | 'typing'>> {
  const document = await vscode.workspace.openTextDocument({ content: '' });
  const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
  const longTasks = new LongTaskRecorder({ thresholdMs: 50, intervalMs: 10 });
  const ticker = setInterval(() => {
    longTasks.tick(performance.now());
  }, 10);
  const typing = new LatencyHistogram();
  let typed = 0;
  let typingBusy = false;
  const typist = setInterval(() => {
    if (typingBusy) {
      return;
    }
    typingBusy = true;
    const text = typed % lineLength === lineLength - 1 ? '\n' : 'x';
    typed += 1;
    const started = performance.now();
    const end = editor.document.lineAt(editor.document.lineCount - 1).range.end;
    editor
      .edit((builder) => {
        builder.insert(end, text);
      })
      .then(() => {
        typing.record(performance.now() - started);
        typingBusy = false;
      });
  }, 100);
  const baseline = process.memoryUsage();
  const memory = {
    heap: baseline.heapUsed,
    arrayBuffers: baseline.arrayBuffers,
    rss: baseline.rss,
  };
  const sampler = setInterval(() => {
    const usage = process.memoryUsage();
    memory.heap = Math.max(memory.heap, usage.heapUsed);
    memory.arrayBuffers = Math.max(memory.arrayBuffers, usage.arrayBuffers);
    memory.rss = Math.max(memory.rss, usage.rss);
  }, 1000);
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  const request: StreamBenchmarkRequest = { url, surface };
  try {
    const result = await vscode.commands.executeCommand<StreamBenchmarkResult>(
      benchmarkCommands.stream,
      request,
    );
    const cpu = process.cpuUsage(cpuStart);
    const extensionHost: ExtensionHostResult = {
      longTasks: longTasks.summary(),
      cpuPercent: ((cpu.user + cpu.system) / 1000 / (performance.now() - wallStart)) * 100,
      baselineHeapBytes: baseline.heapUsed,
      maxHeapBytes: memory.heap,
      maxArrayBuffersBytes: memory.arrayBuffers,
      baselineRssBytes: baseline.rss,
      maxRssBytes: memory.rss,
    };
    return { surface: result, extensionHost, typing: typing.summary() };
  } finally {
    clearInterval(ticker);
    clearInterval(typist);
    clearInterval(sampler);
  }
}

async function walkthroughMode(url: string, surface: string, controlUrl: string): Promise<void> {
  await waitForCommand(benchmarkCommands.walkthrough);
  const request: WalkthroughRequest = { url, surface, controlUrl };
  await vscode.commands.executeCommand(benchmarkCommands.walkthrough, request);
}

export async function run(): Promise<void> {
  const mode = process.env[benchmarkEnvironment.mode] === 'walkthrough' ? 'walkthrough' : 'stream';
  const out = setting(benchmarkEnvironment.out);
  let result: DriverResult = {
    mode,
    vscodeVersion: vscode.version,
    surface: undefined,
    extensionHost: undefined,
    typing: undefined,
    error: undefined,
  };
  try {
    const url = setting(benchmarkEnvironment.url);
    const surface = setting(benchmarkEnvironment.surface);
    await activateStreamscope();
    if (mode === 'walkthrough') {
      const controlUrl = setting(benchmarkEnvironment.control);
      await delay(2000);
      await get(screenshotUrl(controlUrl, `${surface}-startup`));
      await walkthroughMode(url, surface, controlUrl);
    } else {
      await waitForCommand(benchmarkCommands.stream);
      result = { ...result, ...(await streamMode(url, surface)) };
    }
  } catch (error) {
    result = { ...result, error: error instanceof Error ? error.message : String(error) };
  }
  writeFileSync(out, JSON.stringify(result));
}
