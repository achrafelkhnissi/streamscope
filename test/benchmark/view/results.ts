import type { StreamBenchmarkResult } from '../../../src/benchmark/contract';
import type { LatencySummary } from '../../../src/benchmark/latency';
import type { LongTaskSummary } from './long-tasks';
import type { ProcessSummary } from './processes';

export interface ExtensionHostResult {
  longTasks: LongTaskSummary;
  cpuPercent: number;
  baselineHeapBytes: number;
  maxHeapBytes: number;
  maxArrayBuffersBytes: number;
  baselineRssBytes: number;
  maxRssBytes: number;
}

export interface DriverResult {
  mode: 'stream' | 'walkthrough';
  vscodeVersion: string;
  surface: StreamBenchmarkResult | undefined;
  extensionHost: ExtensionHostResult | undefined;
  typing: LatencySummary | undefined;
  error: string | undefined;
}

export interface ViewBenchmarkResult extends DriverResult {
  surfaceName: string;
  rate: number;
  seconds: number;
  eventBytes: number;
  processes: ProcessSummary;
  screenshots: string[];
}

function failed(mode: DriverResult['mode'], error: string): DriverResult {
  return {
    mode,
    vscodeVersion: '',
    surface: undefined,
    extensionHost: undefined,
    typing: undefined,
    error,
  };
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function readDriverResult(
  text: string | undefined,
  mode: DriverResult['mode'],
): DriverResult {
  if (text === undefined) {
    return failed(mode, 'The benchmark driver wrote no result.');
  }
  const value = parsed(text);
  if (typeof value !== 'object' || value === null || !('mode' in value)) {
    return failed(mode, 'The benchmark driver wrote an unreadable result.');
  }
  return value as DriverResult;
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${count === 1 ? noun : `${noun}s`}`;
}

export function expectedEvents(rate: number, seconds: number): number {
  return Math.floor(rate * seconds) + 2;
}

export function checkSurfaceResult(
  result: StreamBenchmarkResult | undefined,
  expected: number,
): string | undefined {
  if (result === undefined) {
    return 'The surface returned no result.';
  }
  if (result.endedBy !== 'completed') {
    return `The stream ended ${result.endedBy} instead of completed.`;
  }
  if (result.events !== expected) {
    return `Expected ${String(expected)} events, got ${String(result.events)}.`;
  }
  if (result.visible < result.events) {
    return `${plural(result.events - result.visible, 'event')} never became visible.`;
  }
  if (result.latency.count < result.visible) {
    return `${plural(result.visible - result.latency.count, 'visible event')} have no latency.`;
  }
  return undefined;
}
