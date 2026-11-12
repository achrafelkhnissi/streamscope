import { describe, expect, it, vi } from 'vitest';
import { RunHistory } from '../../../src/runs/history';
import type { RunHandle, RunSnapshot } from '../../../src/runs/run';

interface FakeRun extends RunHandle {
  release: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

function fakeRun(id: number): FakeRun {
  return {
    id,
    done: new Promise<RunSnapshot>(() => undefined),
    snapshot: () => {
      throw new Error('not used');
    },
    cancel: () => undefined,
    onUpdate: () => () => undefined,
    release: vi.fn(() => Promise.resolve()),
    compact: () => undefined,
  };
}

describe('RunHistory', () => {
  it('keeps the newest runs, newest first', () => {
    const history = new RunHistory(5);
    const runs = [1, 2, 3].map(fakeRun);
    for (const run of runs) {
      history.add(run);
    }

    expect(history.list()).toEqual([runs[2], runs[1], runs[0]]);
    expect(history.find(2)).toBe(runs[1]);
    expect(history.find(4)).toBeUndefined();
  });

  it('releases the oldest run when the limit is passed', () => {
    const history = new RunHistory(2);
    const [first, second, third] = [1, 2, 3].map(fakeRun);
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('Missing runs');
    }

    history.add(first);
    history.add(second);

    expect(first.release).not.toHaveBeenCalled();

    history.add(third);

    expect(first.release).toHaveBeenCalledTimes(1);
    expect(second.release).not.toHaveBeenCalled();
    expect(third.release).not.toHaveBeenCalled();
    expect(history.list()).toEqual([third, second]);
    expect(history.find(first.id)).toBeUndefined();
  });

  it('never holds more than its limit', () => {
    const history = new RunHistory(50);
    const runs = Array.from({ length: 100 }, (_unused, index) => fakeRun(index + 1));
    for (const run of runs) {
      history.add(run);
      expect(history.list().length).toBeLessThanOrEqual(50);
    }

    expect(history.list()).toHaveLength(50);
    expect(history.list()[0]).toBe(runs[99]);
    expect(history.list()[49]).toBe(runs[50]);
    expect(runs.slice(0, 50).every((run) => run.release.mock.calls.length === 1)).toBe(true);
    expect(runs.slice(50).every((run) => run.release.mock.calls.length === 0)).toBe(true);
  });

  it('does not duplicate a run that is already held', () => {
    const history = new RunHistory(2);
    const [first, second, third] = [1, 2, 3].map(fakeRun);
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('Missing runs');
    }

    history.add(first);
    history.add(second);
    history.add(second);
    history.add(first);

    expect(history.list()).toEqual([second, first]);
    expect(first.release).not.toHaveBeenCalled();
    expect(second.release).not.toHaveBeenCalled();

    history.add(third);

    expect(history.list()).toEqual([third, second]);
    expect(first.release).toHaveBeenCalledTimes(1);
  });

  it('keeps the list it returned unchanged by later adds', () => {
    const history = new RunHistory(3);
    history.add(fakeRun(1));
    const before = history.list();

    history.add(fakeRun(2));

    expect(before).toHaveLength(1);
    expect(history.list()).toHaveLength(2);
  });

  it('releases every run it holds on dispose and then holds none', async () => {
    const history = new RunHistory(5);
    const runs = [1, 2, 3].map(fakeRun);
    for (const run of runs) {
      history.add(run);
    }

    await history.dispose();

    expect(runs.every((run) => run.release.mock.calls.length === 1)).toBe(true);
    expect(history.list()).toEqual([]);
    expect(history.find(1)).toBeUndefined();
  });

  it('waits for every release on dispose', async () => {
    const history = new RunHistory(5);
    let finished = 0;
    for (const id of [1, 2]) {
      const run = fakeRun(id);
      run.release.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        finished += 1;
      });
      history.add(run);
    }

    await history.dispose();

    expect(finished).toBe(2);
  });
});
