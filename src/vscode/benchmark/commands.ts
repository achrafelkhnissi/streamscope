import * as http from 'node:http';
import * as vscode from 'vscode';
import {
  benchmarkCommands,
  checkBenchmarkUrl,
  screenshotUrl,
  type StreamBenchmarkRequest,
  type StreamBenchmarkResult,
  type WalkthroughRequest,
} from '../../benchmark/contract';
import { sentAtOf } from '../../benchmark/latency';
import { RenderTracker } from '../../benchmark/render-tracker';
import { TaskTimer } from '../../benchmark/task-timer';
import type { EventStore } from '../../events/store';
import type { RunHandle } from '../../runs/run';
import type { PanelBenchmark, ResponsePanels } from '../response/panels';

export type SendRequest = (
  uri: vscode.Uri,
  line: number,
  started: (handle: RunHandle) => void,
) => Promise<void>;

export class PanelProbe implements PanelBenchmark {
  readonly timer = new TaskTimer();
  private observer: ((run: number, newest: number) => void) | undefined;

  rendered(run: number, newest: number): void {
    this.observer?.(run, newest);
  }

  observe(observer: (run: number, newest: number) => void): () => void {
    this.observer = observer;
    return () => {
      this.observer = undefined;
    };
  }
}

interface BenchmarkServices {
  probe: PanelProbe;
  panels: ResponsePanels;
  send: SendRequest;
}

interface StartedRun<T> {
  handle: RunHandle;
  finished: Promise<void>;
  observed: T;
}

const catchUpMs = 10_000;
const firstEventsMs = 20_000;
const firstEvents = 40;
const stepMs = 2000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function refuse(url: string): void {
  const refusal = checkBenchmarkUrl(url);
  if (refusal !== undefined) {
    throw new Error(refusal);
  }
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

function openRequest(url: string): Thenable<vscode.TextDocument> {
  return vscode.workspace.openTextDocument({ language: 'http', content: `GET ${url}\n` });
}

function sendRequest<T>(
  send: SendRequest,
  document: vscode.TextDocument,
  onStart: (handle: RunHandle) => T,
): Promise<StartedRun<T>> {
  return new Promise((resolve, reject) => {
    const finished = send(document.uri, 0, (handle) => {
      resolve({ handle, finished, observed: onStart(handle) });
    });
    finished.then(() => {
      reject(new Error('The benchmark request did not start.'));
    }, reject);
  });
}

async function streamBenchmark(
  { probe, send }: BenchmarkServices,
  request: StreamBenchmarkRequest,
): Promise<StreamBenchmarkResult> {
  refuse(request.url);
  const document = await openRequest(request.url);
  probe.timer.reset();
  const { handle, finished, observed } = await sendRequest(send, document, (started) => {
    let store: EventStore | undefined;
    const tracker = new RenderTracker((index) => {
      store ??= started.snapshot().stream?.store;
      return sentAtOf(store?.inMemory(index)?.value);
    });
    const stop = probe.observe((run, newest) => {
      if (run === started.id) {
        tracker.rendered(newest, performance.timeOrigin + performance.now());
      }
    });
    return { tracker, stop };
  });
  const { tracker, stop } = observed;
  const run = await handle.done;
  if (run.status === 'blocked') {
    stop();
    throw new Error(`The benchmark request was not sent: ${run.problems[0]?.message ?? 'blocked'}`);
  }
  const events = run.stream?.store.count ?? 0;
  const deadline = performance.now() + catchUpMs;
  while (tracker.visible < events && performance.now() < deadline) {
    await delay(50);
  }
  stop();
  const result: StreamBenchmarkResult = {
    surface: request.surface,
    events,
    visible: tracker.visible,
    latency: tracker.latency(),
    ...probe.timer.summary(),
    endedBy:
      run.status === 'completed' ? 'completed' : run.status === 'failed' ? 'failed' : 'cancelled',
  };
  await finished;
  return result;
}

async function untilRendered(panels: ResponsePanels, key: string, events: number): Promise<void> {
  const deadline = performance.now() + firstEventsMs;
  while ((panels.state(key)?.rendered ?? 0) < events) {
    if (performance.now() > deadline) {
      throw new Error(
        `The panel did not show ${String(events)} events within ${String(firstEventsMs)} ms.`,
      );
    }
    await delay(50);
  }
}

async function walkthrough(
  { panels, send }: BenchmarkServices,
  request: WalkthroughRequest,
): Promise<void> {
  refuse(request.url);
  refuse(request.controlUrl);
  const document = await openRequest(request.url);
  await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
  const { handle, finished } = await sendRequest(send, document, () => undefined);
  const { key } = handle.snapshot();
  await untilRendered(panels, key, firstEvents);
  const step = async (name: string, action: () => void | Promise<void>): Promise<void> => {
    await vscode.commands.executeCommand('notifications.clearAll');
    await action();
    await delay(stepMs);
    await get(screenshotUrl(request.controlUrl, `${request.surface}-${name}`));
  };
  await step('events-live', () => undefined);
  await step('reply-live', () => {
    panels.selectView(key, 'reply');
  });
  await step('raw-live', () => {
    panels.selectView(key, 'raw');
  });
  await step('headers', () => {
    panels.selectView(key, 'headers');
  });
  await step('detail', () => {
    panels.expand(key, 1);
  });
  await step('stopped', async () => {
    handle.cancel();
    await handle.done;
    panels.selectView(key, 'events');
  });
  await step('checks', () => {
    panels.selectView(key, 'checks');
  });
  await finished;
}

export function registerBenchmarkCommands(
  context: vscode.ExtensionContext,
  services: BenchmarkServices,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(benchmarkCommands.stream, (request: StreamBenchmarkRequest) =>
      streamBenchmark(services, request),
    ),
    vscode.commands.registerCommand(benchmarkCommands.walkthrough, (request: WalkthroughRequest) =>
      walkthrough(services, request),
    ),
  );
}
