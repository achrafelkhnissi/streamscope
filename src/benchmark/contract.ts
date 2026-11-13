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

const loopbackUrl = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/\S*$/;
const refusedUrlMessage = 'The benchmark commands accept only http://127.0.0.1:<port>/… URLs.';

export function benchmarkEnabled(
  environment: Readonly<Record<string, string | undefined>>,
  production: boolean,
): boolean {
  return !production && environment[benchmarkEnvironment.enabled] === '1';
}

export function checkBenchmarkUrl(url: string): string | undefined {
  const port = Number(loopbackUrl.exec(url)?.[1]);
  return port >= 1 && port <= 65_535 ? undefined : refusedUrlMessage;
}

export interface StreamBenchmarkRequest {
  url: string;
  surface: string;
}

export interface StreamBenchmarkResult {
  surface: string;
  events: number;
  visible: number;
  latency: LatencySummary;
  longestTaskMs: number;
  tasksOverBudget: number;
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
  'stopped',
  'checks',
] as const;

export type WalkthroughStep = (typeof walkthroughSteps)[number];

export function screenshotUrl(controlUrl: string, name: string): string {
  return `${controlUrl}/screenshot?name=${encodeURIComponent(name)}`;
}
