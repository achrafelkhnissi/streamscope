import { describe, expect, it } from 'vitest';
import {
  evaluationAllowanceMs,
  hostBudget,
  TaskBudget,
  taskBudgetMs,
  taskEvaluationCapMs,
} from '../../../src/capture/task-budget';
import type { WorkBudget } from '../../../src/expressions/work';

const hostWork = 'the capture needs too much work for this stream';

function checked(work: WorkBudget): boolean {
  try {
    work.spend(1_024);
    return true;
  } catch {
    return false;
  }
}

describe('TaskBudget', () => {
  it('lasts 30 ms, frees 5 µs per evaluation and caps a task at 200 ms', () => {
    expect(taskBudgetMs).toBe(30);
    expect(evaluationAllowanceMs).toBe(0.005);
    expect(taskEvaluationCapMs).toBe(200);
  });

  it("an evaluation's first 5 µs never counts", () => {
    let time = 0;
    const budget = new TaskBudget({ now: () => time, nextTask: () => undefined });

    let passed = 0;
    for (let evaluation = 0; evaluation < 20_000; evaluation += 1) {
      const work = budget.enter();
      time += 0.0049;
      passed += checked(work) ? 1 : 0;
      budget.leave();
      time += 1;
    }
    expect(passed).toBe(20_000);

    const work = budget.enter();
    time += 30.004;
    expect(checked(work)).toBe(true);
    time += 0.002;
    expect(checked(work)).toBe(false);
    expect(work.reason).toBe(hostWork);
  });

  it('a pause inside an evaluation that reaches no clock check counts only toward the 200 ms cap', () => {
    let time = 0;
    const budget = new TaskBudget({ now: () => time, nextTask: () => undefined });

    budget.enter();
    time += 50;
    budget.leave();
    const next = budget.enter();
    time += 0.001;
    expect(checked(next)).toBe(true);
    budget.leave();

    for (let pause = 0; pause < 3; pause += 1) {
      budget.enter();
      time += 50;
      budget.leave();
    }
    const last = budget.enter();
    time += 0.001;
    expect(checked(last)).toBe(false);
    expect(last.reason).toBe(hostWork);
  });

  it('a task stops at 200 ms of capture evaluation even when every evaluation stays under 5 µs plus a little', () => {
    let time = 0;
    const budget = new TaskBudget({ now: () => time, nextTask: () => undefined });

    let evaluations = 0;
    let stopped = false;
    while (!stopped && evaluations < 100_000) {
      const work = budget.enter();
      time += 0.0055;
      stopped = !checked(work);
      budget.leave();
      time += 1;
      evaluations += 1;
    }

    expect(stopped).toBe(true);
    expect(evaluations * 0.0055).toBeGreaterThan(200);
    expect(evaluations * 0.0055).toBeLessThan(200.1);
    expect(evaluations * 0.0005).toBeLessThan(taskBudgetMs);
  });

  it('gives every evaluation in one task the same budget, and a new one in the next task', () => {
    const tasks: (() => void)[] = [];
    const budget = new TaskBudget({
      now: () => 0,
      nextTask: (callback) => {
        tasks.push(callback);
      },
    });

    const first = budget.enter();
    budget.leave();
    expect(budget.enter()).toBe(first);
    budget.leave();
    expect(tasks).toHaveLength(1);
    tasks.shift()?.();
    const second = budget.enter();
    budget.leave();

    expect(second).not.toBe(first);
    expect(tasks).toHaveLength(1);
  });

  it('expires once 30 ms have been spent inside evaluations, with the host reason', () => {
    let time = 1_000;
    const budget = new TaskBudget({ now: () => time, nextTask: () => undefined });
    const work = budget.enter();

    time = 1_030;
    work.spend(1_024);
    time = 1_030.5;

    expect(() => {
      work.spend(1_024);
    }).toThrow();
    expect(work.exhausted).toBe(true);
    expect(work.reason).toBe(hostWork);
  });

  it('does not count the time between evaluations', () => {
    let time = 0;
    const budget = new TaskBudget({ now: () => time, nextTask: () => undefined });

    for (let evaluation = 0; evaluation < 10; evaluation += 1) {
      const work = budget.enter();
      time += 2;
      work.spend(1_024);
      time += 0.5;
      budget.leave();
      time += 100;
    }

    const work = budget.enter();
    time += 0.5;
    expect(() => {
      work.spend(1_024);
    }).not.toThrow();
    time += 0.5;
    budget.leave();
    time += 1_000;

    const last = budget.enter();
    time += 4.5;
    expect(() => {
      last.spend(1_024);
    }).toThrow();
    expect(last.reason).toBe(hostWork);
  });

  it('adds the time up to each check and to the end of each evaluation', () => {
    let time = 0;
    const budget = new TaskBudget({ now: () => time, nextTask: () => undefined });
    const work = budget.enter();

    time = 10;
    work.spend(1_024);
    time = 20;
    work.spend(1_024);
    time = 29;
    budget.leave();
    time = 500;
    budget.enter();
    time = 501.5;

    expect(() => {
      work.spend(1_024);
    }).toThrow();
  });

  it('starts a new budget after a real setImmediate', async () => {
    const first = hostBudget.enter();
    hostBudget.leave();
    expect(hostBudget.enter()).toBe(first);
    hostBudget.leave();

    await new Promise((resolve) => setImmediate(resolve));

    expect(hostBudget.enter()).not.toBe(first);
    hostBudget.leave();
  });
});
