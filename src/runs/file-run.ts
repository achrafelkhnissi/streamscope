import type { CheckEntry } from '../checks/registry';
import type { RunSnapshot } from './run';

export interface FileRunStep {
  key: string;
  label: string;
}

export interface FailedCheck {
  index: number;
  text: string;
  line: number;
  detail: string;
}

export type RequestVerdict =
  | { kind: 'passed'; durationMs: number }
  | { kind: 'failed'; durationMs: number; checks: readonly FailedCheck[] }
  | { kind: 'errored'; durationMs: number | undefined; message: string }
  | { kind: 'skipped'; reason: string };

export type StepStart =
  | { kind: 'started'; run: { id: number; done: Promise<RunSnapshot>; cancel(): void } }
  | { kind: 'not-started'; message: string };

export interface FileRunHooks<S extends FileRunStep> {
  begin(step: S): void;
  start(step: S): Promise<StepStart>;
  checks(step: S, runId: number): Promise<readonly CheckEntry[] | undefined>;
  report(step: S, verdict: RequestVerdict, run: RunSnapshot | undefined): void;
}

export const fileRunStoppedReason = 'The file run was stopped.';
export const requestStoppedReason = 'The request was stopped.';
export const checksReplacedMessage = 'A newer run of this request replaced its check results.';

function failedChecks(checks: readonly CheckEntry[]): FailedCheck[] {
  const failed: FailedCheck[] = [];
  for (const [index, { text, line, result }] of checks.entries()) {
    if (result.state === 'failed') {
      failed.push({ index, text, line, detail: result.detail });
    }
  }
  return failed;
}

export function requestVerdict(
  run: RunSnapshot,
  checks: readonly CheckEntry[] | undefined,
  fileRunIds: ReadonlySet<number>,
  stopped: boolean,
): RequestVerdict {
  switch (run.status) {
    case 'completed': {
      if (checks === undefined) {
        return { kind: 'errored', durationMs: run.elapsedMs, message: checksReplacedMessage };
      }
      const failed = failedChecks(checks);
      return failed.length === 0
        ? { kind: 'passed', durationMs: run.elapsedMs }
        : { kind: 'failed', durationMs: run.elapsedMs, checks: failed };
    }
    case 'cancelled':
      return { kind: 'skipped', reason: stopped ? fileRunStoppedReason : requestStoppedReason };
    case 'blocked': {
      const message = run.problems.map((problem) => problem.message).join(' ');
      const skipped = run.problems.some(
        ({ producerRun }) => producerRun !== undefined && fileRunIds.has(producerRun),
      );
      return skipped
        ? { kind: 'skipped', reason: message }
        : { kind: 'errored', durationMs: undefined, message };
    }
    default:
      return { kind: 'errored', durationMs: run.elapsedMs, message: run.failure?.message ?? '' };
  }
}

export async function runFile<S extends FileRunStep>(
  steps: readonly S[],
  hooks: FileRunHooks<S>,
  signal: AbortSignal,
): Promise<void> {
  const fileRunIds = new Set<number>();
  const aborted = (): boolean => signal.aborted;
  for (const step of steps) {
    if (aborted()) {
      return;
    }
    hooks.begin(step);
    const start = await hooks.start(step);
    if (start.kind === 'not-started') {
      hooks.report(
        step,
        { kind: 'errored', durationMs: undefined, message: start.message },
        undefined,
      );
      continue;
    }
    const { run } = start;
    fileRunIds.add(run.id);
    const cancel = (): void => {
      run.cancel();
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (aborted()) {
      run.cancel();
    }
    let snapshot: RunSnapshot;
    try {
      snapshot = await run.done;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
    const checks = snapshot.status === 'completed' ? await hooks.checks(step, run.id) : undefined;
    hooks.report(step, requestVerdict(snapshot, checks, fileRunIds, aborted()), snapshot);
  }
}
