import * as http from 'node:http';
import * as vscode from 'vscode';
import { screenshotUrl, type StreamBenchmarkResult } from '../../src/benchmark/contract';
import { LatencyHistogram, sentAtOf } from '../../src/benchmark/latency';
import type { ViewName } from './format';
import type { SpikeStream } from './stream';

export interface SurfaceResponse {
  readonly stream: SpikeStream;
  onVisible(listener: (newest: number) => void): vscode.Disposable;
  showView(view: ViewName): Promise<void>;
  showDetail(index: number): Promise<void>;
  showCaptureEntry(): Promise<void>;
  showOlder(): Promise<void>;
  close(): Promise<void>;
}

export interface Surface {
  open(url: string, column: vscode.ViewColumn): Promise<SurfaceResponse>;
  responseFor(uri: vscode.Uri | undefined): SurfaceResponse | undefined;
}

const finishWaitMs = 10_000;
const firstShotMs = 5000;
const stepMs = 2000;

export function delay(ms: number): Promise<void> {
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

export async function benchmark(
  response: SurfaceResponse,
  surface: string,
): Promise<StreamBenchmarkResult> {
  const histogram = new LatencyHistogram();
  let visible = 0;
  const subscription = response.onVisible((newest) => {
    const now = performance.timeOrigin + performance.now();
    const store = response.stream.session?.store;
    for (let index = visible + 1; index <= newest; index += 1) {
      const sentAt = sentAtOf(store?.inMemory(index)?.value);
      if (sentAt !== undefined) {
        histogram.record(now - sentAt);
      }
    }
    visible = Math.max(visible, newest);
  });
  const status = await response.stream.done;
  const deadline = performance.now() + finishWaitMs;
  while (visible < (response.stream.session?.store.count ?? 0) && performance.now() < deadline) {
    await delay(50);
  }
  subscription.dispose();
  const events = response.stream.session?.store.count ?? 0;
  await response.close();
  return {
    surface,
    events,
    visible,
    latency: histogram.summary(),
    endedBy: status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'cancelled',
  };
}

export async function walkthrough(
  response: SurfaceResponse,
  surface: string,
  controlUrl: string,
): Promise<void> {
  const step = async (name: string, action: () => Promise<void>): Promise<void> => {
    await vscode.commands.executeCommand('notifications.clearAll');
    await action();
    await delay(stepMs);
    await get(screenshotUrl(controlUrl, `${surface}-${name}`));
  };
  await delay(firstShotMs);
  await step('events-live', () => Promise.resolve());
  await step('reply-live', () => response.showView('reply'));
  await step('raw-live', () => response.showView('raw'));
  await step('headers', () => response.showView('headers'));
  await step('detail', async () => {
    await response.showView('events');
    await response.showDetail(1);
  });
  await step('capture-entry', () => response.showCaptureEntry());
  await step('stopped', async () => {
    response.stream.stop();
    await response.stream.done;
    await response.showView('events');
  });
  await step('checks', () => response.showView('checks'));
  await response.close();
}
