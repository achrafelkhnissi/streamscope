import type { CheckEntry } from '../checks/registry';
import type { HttpRequest } from '../http-file/model';
import { maskUrl, maskValues } from '../masking/masking';
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
  secrets(step: S, runId: number): Promise<readonly string[]>;
  report(
    step: S,
    verdict: RequestVerdict,
    run: RunSnapshot | undefined,
    mask: (text: string) => string,
  ): void;
}

export const fileRunStoppedReason = 'The file run was stopped.';
export const requestStoppedReason = 'The request was stopped.';
export const checksReplacedMessage = 'A newer run of this request replaced its check results.';

const stoppedMark = Symbol('stopped');

function whenAborted(signal: AbortSignal): Promise<typeof stoppedMark> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(stoppedMark);
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        resolve(stoppedMark);
      },
      { once: true },
    );
  });
}

export function expectsChecks(request: HttpRequest): boolean {
  return request.expects.some(({ expression }) => expression !== undefined);
}

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

export function withoutControls(text: string): string {
  let kept = '';
  for (const character of text) {
    const code = character.charCodeAt(0);
    const control =
      (code < 0x20 && character !== '\n' && character !== '\t') || (code >= 0x7f && code <= 0x9f);
    if (!control) {
      kept += character;
    }
  }
  return kept;
}

function maskedVerdict(verdict: RequestVerdict, mask: (text: string) => string): RequestVerdict {
  switch (verdict.kind) {
    case 'passed':
      return verdict;
    case 'failed':
      return {
        ...verdict,
        checks: verdict.checks.map((check) => ({
          ...check,
          text: mask(check.text),
          detail: mask(check.detail),
        })),
      };
    case 'errored':
      return { ...verdict, message: mask(verdict.message) };
    case 'skipped':
      return { ...verdict, reason: mask(verdict.reason) };
  }
}

export async function runFile<S extends FileRunStep>(
  steps: readonly S[],
  hooks: FileRunHooks<S>,
  signal: AbortSignal,
): Promise<void> {
  const fileRunIds = new Set<number>();
  const aborted = (): boolean => signal.aborted;
  const stopped = whenAborted(signal);
  for (const step of steps) {
    if (aborted()) {
      return;
    }
    hooks.begin(step);
    const start = await hooks.start(step);
    if (start.kind === 'not-started') {
      hooks.report(
        step,
        { kind: 'errored', durationMs: undefined, message: maskUrl(start.message) },
        undefined,
        maskUrl,
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
    const checks =
      snapshot.status === 'completed'
        ? await Promise.race([hooks.checks(step, run.id), stopped])
        : undefined;
    const secrets =
      checks === stoppedMark
        ? stoppedMark
        : await Promise.race([hooks.secrets(step, run.id), stopped]);
    if (checks === stoppedMark || secrets === stoppedMark) {
      hooks.report(step, { kind: 'skipped', reason: fileRunStoppedReason }, snapshot, (text) =>
        maskUrl(maskValues(text, snapshot.sensitiveValues)),
      );
      return;
    }
    const sensitive = [...snapshot.sensitiveValues, ...secrets];
    const mask = (text: string): string => maskUrl(maskValues(text, sensitive));
    hooks.report(
      step,
      maskedVerdict(requestVerdict(snapshot, checks, fileRunIds, aborted()), mask),
      snapshot,
      mask,
    );
  }
}
