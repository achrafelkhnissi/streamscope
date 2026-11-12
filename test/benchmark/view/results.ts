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

export function checkSurfaceResult(result: StreamBenchmarkResult): string | undefined {
  const missing = result.events - result.visible;
  if (missing <= 0) {
    return undefined;
  }
  return `${String(missing)} ${missing === 1 ? 'event' : 'events'} never became visible.`;
}
