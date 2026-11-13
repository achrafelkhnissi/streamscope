import { describe, expect, it } from 'vitest';
import { hostBudget, TaskBudget, taskBudgetMs } from '../../../src/capture/task-budget';

const hostWork = 'the capture needs too much work for this stream';

describe('TaskBudget', () => {
  it('lasts 30 ms', () => {
    expect(taskBudgetMs).toBe(30);
  });

  it('gives every caller in one task the same budget, and a new one in the next task', () => {
    const tasks: (() => void)[] = [];
    const budget = new TaskBudget({
      now: () => 0,
      nextTask: (callback) => {
        tasks.push(callback);
      },
    });

    const first = budget.current();
    expect(budget.current()).toBe(first);
    expect(tasks).toHaveLength(1);
    tasks.shift()?.();
    const second = budget.current();

    expect(second).not.toBe(first);
    expect(tasks).toHaveLength(1);
  });

  it('expires 30 ms after its first use in the task, with the host reason', () => {
    let time = 1_000;
    const budget = new TaskBudget({ now: () => time, nextTask: () => undefined });
    const work = budget.current();

    time = 1_030;
    work.spend(1_024);
    time = 1_030.5;

    expect(() => {
      work.spend(1_024);
    }).toThrow();
    expect(work.exhausted).toBe(true);
    expect(work.reason).toBe(hostWork);
  });

  it('starts a new budget after a real setImmediate', async () => {
    const first = hostBudget.current();
    expect(hostBudget.current()).toBe(first);

    await new Promise((resolve) => setImmediate(resolve));

    expect(hostBudget.current()).not.toBe(first);
  });
});
