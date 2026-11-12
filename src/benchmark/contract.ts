import type { LatencySummary } from './latency';

export const benchmarkCommands = {
  stream: 'streamscope.benchmark.stream',
  walkthrough: 'streamscope.benchmark.walkthrough',
} as const;

export const benchmarkEnvironment = {
  enabled: 'STREAMSCOPE_BENCHMARK',
  mode: 'STREAMSCOPE_BENCH_MODE',
  url: 'STREAMSCOPE_BENCH_URL',
  surface: 'STREAMSCOPE_BENCH_SURFACE',
  control: 'STREAMSCOPE_BENCH_CONTROL',
  out: 'STREAMSCOPE_BENCH_OUT',
} as const;

export interface StreamBenchmarkRequest {
  url: string;
  surface: string;
}

export interface StreamBenchmarkResult {
  surface: string;
  events: number;
  visible: number;
  latency: LatencySummary;
  endedBy: 'completed' | 'failed' | 'cancelled';
}

export interface WalkthroughRequest {
  url: string;
  surface: string;
  controlUrl: string;
}

export const walkthroughSteps = [
  'events-live',
  'reply-live',
  'raw-live',
  'headers',
  'detail',
  'capture-entry',
  'stopped',
  'checks',
] as const;

export type WalkthroughStep = (typeof walkthroughSteps)[number];

export function screenshotUrl(controlUrl: string, name: string): string {
  return `${controlUrl}/screenshot?name=${encodeURIComponent(name)}`;
}
