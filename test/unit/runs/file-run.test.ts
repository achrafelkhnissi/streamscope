import { describe, expect, it } from 'vitest';
import type { CheckEntry } from '../../../src/checks/registry';
import type { ResolutionProblem } from '../../../src/variables/resolve';
import {
  requestVerdict,
  runFile,
  withoutControls,
  type FileRunHooks,
  type FileRunStep,
  type RequestVerdict,
  type StepStart,
} from '../../../src/runs/file-run';
import type { RunSnapshot } from '../../../src/runs/run';
import { snapshot } from '../response/fixtures';

const range = { start: { line: 3, character: 0 }, end: { line: 3, character: 4 } };

function problem(message: string, producerRun?: number): ResolutionProblem {
  return producerRun === undefined ? { message, range } : { message, range, producerRun };
}

function entry(index: number, result: CheckEntry['result']): CheckEntry {
  return { runId: 1, text: `check ${String(index)}`, line: index, result };
}

const passed = { state: 'passed', settledAt: undefined } as const;

function failedCheck(detail: string): CheckEntry['result'] {
  return { state: 'failed', detail, settledAt: undefined };
}

interface FakeRun {
  id: number;
  done: Promise<RunSnapshot>;
  cancelled: boolean;
  cancel(): void;
  end(changes: Partial<RunSnapshot>): void;
}

function fakeRun(id: number): FakeRun {
  let finish: (value: RunSnapshot) => void = () => undefined;
  const done = new Promise<RunSnapshot>((resolve) => {
    finish = resolve;
  });
  const run: FakeRun = {
    id,
    done,
    cancelled: false,
    cancel: () => {
      run.cancelled = true;
      finish(snapshot({ id, status: 'cancelled' }));
    },
    end: (changes) => {
      finish(snapshot({ id, ...changes }));
    },
  };
  return run;
}

interface Recorded {
  log: string[];
  reports: [string, RequestVerdict][];
}

function recorder(
  start: (step: FileRunStep, id: number) => Promise<StepStart>,
  checks: (step: FileRunStep, runId: number) => Promise<readonly CheckEntry[] | undefined> = () =>
    Promise.resolve([]),
  onReport: (step: FileRunStep) => void = () => undefined,
): { hooks: FileRunHooks<FileRunStep>; recorded: Recorded } {
  const recorded: Recorded = { log: [], reports: [] };
  let next = 100;
  return {
    recorded,
    hooks: {
      begin: (step) => {
        recorded.log.push(`begin ${step.key}`);
      },
      start: (step) => {
        recorded.log.push(`start ${step.key}`);
        next += 1;
        return start(step, next);
      },
      checks: (step, runId) => {
        recorded.log.push(`checks ${step.key} ${String(runId)}`);
        return checks(step, runId);
      },
      secrets: () => Promise.resolve([]),
      report: (step, verdict) => {
        recorded.log.push(`report ${step.key} ${verdict.kind}`);
        recorded.reports.push([step.key, verdict]);
        onReport(step);
      },
    },
  };
}

function steps(...keys: string[]): FileRunStep[] {
  return keys.map((key) => ({ key, label: key }));
}

function started(run: FakeRun): Promise<StepStart> {
  return Promise.resolve({ kind: 'started', run });
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('requestVerdict', () => {
  it('passes a completed request whose checks passed, and one with a 500 and no checks', () => {
    expect(
      requestVerdict(snapshot({ elapsedMs: 120 }), [entry(0, passed)], new Set(), false),
    ).toEqual({ kind: 'passed', durationMs: 120 });

    const serverError = snapshot({
      elapsedMs: 80,
      head: { httpVersion: '1.1', status: 500, statusText: 'Internal Server Error', headers: [] },
    });
    expect(requestVerdict(serverError, [], new Set(), false)).toEqual({
      kind: 'passed',
      durationMs: 80,
    });
  });

  it('fails a completed request with one entry per failed check, in check order', () => {
    const verdict = requestVerdict(
      snapshot({ elapsedMs: 90 }),
      [entry(0, passed), entry(1, failedCheck('got 500')), entry(2, failedCheck('got 2'))],
      new Set(),
      false,
    );

    expect(verdict).toEqual({
      kind: 'failed',
      durationMs: 90,
      checks: [
        { index: 1, text: 'check 1', line: 1, detail: 'got 500' },
        { index: 2, text: 'check 2', line: 2, detail: 'got 2' },
      ],
    });
  });

  it('errors a failed request with its failure message, and a blocked request with its problems', () => {
    const failed = snapshot({
      status: 'failed',
      elapsedMs: 200,
      failure: {
        kind: 'total-timeout',
        message: 'The request did not finish within its # @timeout of 200 ms.',
      },
    });
    expect(requestVerdict(failed, undefined, new Set(), false)).toEqual({
      kind: 'errored',
      durationMs: 200,
      message: 'The request did not finish within its # @timeout of 200 ms.',
    });

    const blocked = snapshot({
      status: 'blocked',
      problems: [problem('First problem.'), problem('Second problem.')],
    });
    expect(requestVerdict(blocked, undefined, new Set(), false)).toEqual({
      kind: 'errored',
      durationMs: undefined,
      message: 'First problem. Second problem.',
    });
  });

  it('skips a request blocked by a producer run of this file run, with the problem as the reason', () => {
    const blocked = snapshot({
      status: 'blocked',
      problems: [problem('startRun › threadId failed: no event matched.', 7)],
    });

    expect(requestVerdict(blocked, undefined, new Set([7]), false)).toEqual({
      kind: 'skipped',
      reason: 'startRun › threadId failed: no event matched.',
    });
  });

  it('errors a request blocked by a producer run from before the file run', () => {
    const blocked = snapshot({
      status: 'blocked',
      problems: [problem('startRun › threadId failed: no event matched.', 3)],
    });

    expect(requestVerdict(blocked, undefined, new Set([7]), false)).toEqual({
      kind: 'errored',
      durationMs: undefined,
      message: 'startRun › threadId failed: no event matched.',
    });
  });

  it('errors a request whose check results were replaced', () => {
    expect(requestVerdict(snapshot({ elapsedMs: 50 }), undefined, new Set(), false)).toEqual({
      kind: 'errored',
      durationMs: 50,
      message: 'A newer run of this request replaced its check results.',
    });
  });
});

describe('runFile', () => {
  it('runs steps one at a time in order, each after the previous one and its checks settle', async () => {
    const runs = new Map<string, FakeRun>();
    let releaseChecks: (entries: readonly CheckEntry[]) => void = () => undefined;
    const { hooks, recorded } = recorder(
      (step, id) => {
        const run = fakeRun(id);
        runs.set(step.key, run);
        return started(run);
      },
      () =>
        new Promise((resolve) => {
          releaseChecks = resolve;
        }),
    );

    const running = runFile(steps('a', 'b'), hooks, new AbortController().signal);
    await settle();
    expect(recorded.log).toEqual(['begin a', 'start a']);

    runs.get('a')?.end({});
    await settle();
    expect(recorded.log).toEqual(['begin a', 'start a', 'checks a 101']);

    releaseChecks([entry(0, passed)]);
    await settle();
    expect(recorded.log).toEqual([
      'begin a',
      'start a',
      'checks a 101',
      'report a passed',
      'begin b',
      'start b',
    ]);

    runs.get('b')?.end({});
    await settle();
    releaseChecks([]);
    await running;
    expect(recorded.log.slice(-2)).toEqual(['checks b 102', 'report b passed']);
  });

  it('skips through a chain of dependants', async () => {
    const ids: number[] = [];
    const { hooks, recorded } = recorder((step, id) => {
      const run = fakeRun(id);
      const previous = ids.at(-1);
      ids.push(id);
      if (step.key === 'a') {
        run.end({
          status: 'failed',
          failure: { kind: 'refused', message: 'The connection was refused.' },
        });
      } else {
        run.end({
          status: 'blocked',
          problems: [problem(`${step.key} needs the one before it.`, previous)],
        });
      }
      return started(run);
    });

    await runFile(steps('a', 'b', 'c'), hooks, new AbortController().signal);

    expect(recorded.reports).toEqual([
      ['a', { kind: 'errored', durationMs: 120, message: 'The connection was refused.' }],
      ['b', { kind: 'skipped', reason: 'b needs the one before it.' }],
      ['c', { kind: 'skipped', reason: 'c needs the one before it.' }],
    ]);
    expect(recorded.log.filter((line) => line.startsWith('checks'))).toEqual([]);
  });

  it('errors a step that could not start', async () => {
    const { hooks, recorded } = recorder((step, id) => {
      if (step.key === 'a') {
        return Promise.resolve({
          kind: 'not-started',
          message: 'A secret was not entered, so a was not sent.',
        });
      }
      const run = fakeRun(id);
      run.end({});
      return started(run);
    });

    await runFile(steps('a', 'b'), hooks, new AbortController().signal);

    expect(recorded.reports).toEqual([
      [
        'a',
        {
          kind: 'errored',
          durationMs: undefined,
          message: 'A secret was not entered, so a was not sent.',
        },
      ],
      ['b', { kind: 'passed', durationMs: 120 }],
    ]);
  });

  it('on stop, cancels the active request, reports it stopped and starts nothing more', async () => {
    const active: FakeRun[] = [];
    const whileActive = recorder((_step, id) => {
      const run = fakeRun(id);
      active.push(run);
      return started(run);
    });
    const controller = new AbortController();
    const running = runFile(steps('a', 'b'), whileActive.hooks, controller.signal);
    await settle();
    controller.abort();
    controller.abort();
    await running;
    expect(active.map((run) => run.cancelled)).toEqual([true]);
    expect(whileActive.recorded.reports).toEqual([
      ['a', { kind: 'skipped', reason: 'The file run was stopped.' }],
    ]);
    expect(whileActive.recorded.log).not.toContain('begin b');

    const between = new AbortController();
    const betweenSteps = recorder(
      (_step, id) => {
        const run = fakeRun(id);
        run.end({});
        return started(run);
      },
      undefined,
      () => {
        between.abort();
      },
    );
    await runFile(steps('a', 'b'), betweenSteps.hooks, between.signal);
    expect(betweenSteps.recorded.log).toEqual([
      'begin a',
      'start a',
      'checks a 101',
      'report a passed',
    ]);

    const before = new AbortController();
    before.abort();
    const beforeFirst = recorder((_step, id) => started(fakeRun(id)));
    await runFile(steps('a'), beforeFirst.hooks, before.signal);
    expect(beforeFirst.recorded.log).toEqual([]);

    const duringStart = new AbortController();
    const startedLate: FakeRun[] = [];
    const whileStarting = recorder((_step, id) => {
      duringStart.abort();
      const run = fakeRun(id);
      startedLate.push(run);
      return started(run);
    });
    await runFile(steps('a', 'b'), whileStarting.hooks, duringStart.signal);
    expect(startedLate.map((run) => run.cancelled)).toEqual([true]);
    expect(whileStarting.recorded.reports).toEqual([
      ['a', { kind: 'skipped', reason: 'The file run was stopped.' }],
    ]);
  });

  it('reports a request stopped from elsewhere as skipped and goes on', async () => {
    const { hooks, recorded } = recorder((step, id) => {
      const run = fakeRun(id);
      if (step.key === 'a') {
        run.cancel();
      } else {
        run.end({});
      }
      return started(run);
    });

    await runFile(steps('a', 'b'), hooks, new AbortController().signal);

    expect(recorded.reports).toEqual([
      ['a', { kind: 'skipped', reason: 'The request was stopped.' }],
      ['b', { kind: 'passed', durationMs: 120 }],
    ]);
  });
});

describe('runFile after the review', () => {
  it("masks the run's secret captures, sensitive values and URL user info in every reported text", async () => {
    const secret = 'sk-late-secret-123';
    const reports: RequestVerdict[] = [];
    const masked: string[] = [];
    let next = 0;
    const hooks: FileRunHooks<FileRunStep> = {
      begin: () => undefined,
      start: (step) => {
        next += 1;
        const run = fakeRun(next);
        if (step.key === 'checked') {
          run.end({});
        } else if (step.key === 'failed') {
          run.end({
            status: 'failed',
            sensitiveValues: ['synthetic-header-token'],
            failure: {
              kind: 'refused',
              message: `https://user:pass@api.example.test/ refused synthetic-header-token and ${secret}`,
            },
          });
        } else {
          run.end({ status: 'blocked', problems: [problem(`needs ${secret}`, 1)] });
        }
        return started(run);
      },
      checks: () => Promise.resolve([entry(0, failedCheck(`got "${secret}"`))]),
      secrets: () => Promise.resolve([secret]),
      report: (_step, verdict, _run, mask) => {
        reports.push(verdict);
        masked.push(mask(`outcome ${secret}`));
      },
    };

    await runFile(steps('checked', 'failed', 'blocked'), hooks, new AbortController().signal);

    expect(JSON.stringify(reports)).not.toContain(secret);
    expect(JSON.stringify(reports)).not.toContain('synthetic-header-token');
    expect(JSON.stringify(reports)).not.toContain('user:pass');
    expect(masked.some((text) => text.includes(secret))).toBe(false);
    expect(reports.map(({ kind }) => kind)).toEqual(['failed', 'errored', 'skipped']);
  });

  it("waits for the run's captures before reporting", async () => {
    const log: string[] = [];
    let releaseSecrets: (values: readonly string[]) => void = () => undefined;
    const hooks: FileRunHooks<FileRunStep> = {
      begin: () => undefined,
      start: () => {
        const run = fakeRun(1);
        run.end({});
        return started(run);
      },
      checks: () => Promise.resolve([]),
      secrets: () => {
        log.push('secrets');
        return new Promise((resolve) => {
          releaseSecrets = resolve;
        });
      },
      report: () => {
        log.push('report');
      },
    };

    const running = runFile(steps('a'), hooks, new AbortController().signal);
    await settle();
    expect(log).toEqual(['secrets']);
    releaseSecrets([]);
    await running;
    expect(log).toEqual(['secrets', 'report']);
  });

  it('withoutControls strips terminal control characters but keeps line breaks and tabs', () => {
    expect(withoutControls('a\u001b[31mred\u0007\tb\nc\u009bd\u007f')).toBe('a[31mred\tb\ncd');
  });
});
