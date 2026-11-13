import { describe, expect, it } from 'vitest';
import { hostBudget, TaskBudget, taskBudgetMs } from '../../../src/capture/task-budget';

const hostWork = 'the capture needs too much work for this stream';

describe('TaskBudget', () => {
  it('lasts 30 ms', () => {
    expect(taskBudgetMs).toBe(30);
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
