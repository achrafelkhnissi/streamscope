import { maskValues } from '../masking/masking';
import type { RunSnapshot } from '../runs/run';
import { describeOutcome, eventCount, formatDuration } from './labels';

export interface RunPickItem {
  label: string;
  description: string;
  key: string;
}

function maskedLabel(run: RunSnapshot): string {
  return maskValues(run.label, run.sensitiveValues);
}

export function describeRunning(run: RunSnapshot): string {
  return `${maskedLabel(run)} · ${eventCount(run) ?? formatDuration(run.elapsedMs)}`;
}

export function runStatusText(runs: readonly RunSnapshot[]): string | undefined {
  const [only] = runs;
  if (only === undefined) {
    return undefined;
  }
  return runs.length === 1
    ? `$(debug-stop) ${describeRunning(only)}`
    : `$(debug-stop) ${String(runs.length)} running`;
}

export function runStatusTooltip(runs: readonly RunSnapshot[]): string | undefined {
  const [only] = runs;
  if (only === undefined) {
    return undefined;
  }
  return runs.length === 1
    ? `Stop ${maskedLabel(only)} (${describeOutcome(only)})`
    : `Stop one of the ${String(runs.length)} running requests`;
}

export function runPickItems(runs: readonly RunSnapshot[]): RunPickItem[] {
  return runs.map((run) => ({
    label: maskedLabel(run),
    description: describeOutcome(run),
    key: run.key,
  }));
}
