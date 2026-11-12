import { describe, expect, it } from 'vitest';
import { TaskTimer, taskBudgetMs } from '../../../src/benchmark/task-timer';

describe('TaskTimer', () => {
  it('reports no tasks before any is recorded', () => {
    expect(new TaskTimer().summary()).toEqual({ longestTaskMs: 0, tasksOverBudget: 0 });
  });

  it('keeps the longest duration it was given', () => {
    const timer = new TaskTimer();
    for (const ms of [3, 12.5, 7, 1]) {
      timer.record(ms);
    }

    expect(timer.summary().longestTaskMs).toBe(12.5);
  });

  it('counts the tasks that took more than the 50 ms budget', () => {
    const timer = new TaskTimer();
    for (const ms of [10, 49.9, 50, 50.1, 120, 51]) {
      timer.record(ms);
    }

    expect(taskBudgetMs).toBe(50);
    expect(timer.summary()).toEqual({ longestTaskMs: 120, tasksOverBudget: 3 });
  });

  it('starts counting again after a reset', () => {
    const timer = new TaskTimer();
    timer.record(200);
    timer.reset();
    timer.record(4);

    expect(timer.summary()).toEqual({ longestTaskMs: 4, tasksOverBudget: 0 });
  });
});
