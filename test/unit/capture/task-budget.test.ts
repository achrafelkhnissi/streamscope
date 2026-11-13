import { describe, expect, it } from 'vitest';
import {
  captureSliceMs,
  hostBudget,
  hostEvaluationUnits,
  TaskBudget,
} from '../../../src/capture/task-budget';
import type { WorkBudget } from '../../../src/expressions/work';

const hostWork = 'the capture needs too much work for this stream';

function spend(work: WorkBudget, units: number): boolean {
  try {
    work.spend(units);
    return true;
  } catch {
    return false;
  }
}

describe('TaskBudget', () => {
  it('slices 10 ms of capture work per task and allows 2,000,000 units per evaluation', () => {
    expect(captureSliceMs).toBe(10);
    expect(hostEvaluationUnits).toBe(2_000_000);
  });

  it('fails an evaluation past 2,000,000 units however little time passes', () => {
    const budget = new TaskBudget({ now: () => 0, nextTask: () => undefined });

    const work = budget.enter();
    expect(spend(work, 2_000_000)).toBe(true);
    expect(spend(work, 1_024)).toBe(false);
    expect(work.exhausted).toBe(true);
    expect(work.reason).toBe(hostWork);
    budget.leave();
  });

  it('never fails an evaluation for the time it takes', () => {
    let time = 0;
    const budget = new TaskBudget({ now: () => time, nextTask: () => undefined });

    const work = budget.enter();
    for (let step = 0; step < 100; step += 1) {
      time += 1_000;
      expect(spend(work, 1_024)).toBe(true);
    }
    budget.leave();
  });

  it('gives each evaluation its own units', () => {
    const budget = new TaskBudget({ now: () => 0, nextTask: () => undefined });

    const work = budget.enter();
    expect(spend(work, 2_000_000)).toBe(true);
    work.restart();
    expect(spend(work, 2_000_000)).toBe(true);
    budget.leave();
    expect(spend(budget.enter(), 2_000_000)).toBe(true);
    budget.leave();
  });

  it('has room until 10 ms of capture work in a task, and again in the next task', () => {
    let time = 0;
    const tasks: (() => void)[] = [];
    const budget = new TaskBudget({
      now: () => time,
      nextTask: (callback) => {
        tasks.push(callback);
      },
    });

    expect(budget.hasRoom).toBe(true);
    budget.enter();
    time += 6;
    budget.leave();
    time += 100;
    expect(budget.hasRoom).toBe(true);
    budget.enter();
    time += 4;
    budget.leave();
    expect(budget.hasRoom).toBe(false);
    expect(tasks).toHaveLength(1);

    tasks.shift()?.();
    expect(budget.hasRoom).toBe(true);
    budget.enter();
    budget.leave();
    expect(tasks).toHaveLength(1);
  });

  it('tells mid-evaluation whether the slice still has room', () => {
    let time = 0;
    const budget = new TaskBudget({ now: () => time, nextTask: () => undefined });

    budget.enter();
    time += 6;
    budget.leave();
    budget.enter();
    time += 3;
    expect(budget.roomLeft()).toBe(true);
    time += 1;
    expect(budget.roomLeft()).toBe(false);
    budget.leave();
  });

  it('runs a callback in a later task', () => {
    const tasks: (() => void)[] = [];
    const budget = new TaskBudget({
      now: () => 0,
      nextTask: (callback) => {
        tasks.push(callback);
      },
    });
    let ran = false;

    budget.afterTask(() => {
      ran = true;
    });

    expect(ran).toBe(false);
    tasks.shift()?.();
    expect(ran).toBe(true);
  });

  it('opens a new slice after a real setImmediate', async () => {
    hostBudget.enter();
    const start = performance.now();
    while (performance.now() - start < captureSliceMs + 1) {
      continue;
    }
    hostBudget.leave();
    expect(hostBudget.hasRoom).toBe(false);

    await new Promise((resolve) => setImmediate(resolve));

    expect(hostBudget.hasRoom).toBe(true);
  });
});
