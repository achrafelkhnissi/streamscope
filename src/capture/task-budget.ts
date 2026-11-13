import { WorkBudget } from '../expressions/work';
import { hostWorkReason } from './messages';

export interface TaskClock {
  now(): number;
  nextTask(callback: () => void): void;
}

export const taskBudgetMs = 30;

const realClock: TaskClock = {
  now: () => performance.now(),
  nextTask: (callback) => {
    setImmediate(callback);
  },
};

export class TaskBudget {
  private budget: WorkBudget | undefined;

  constructor(private readonly clock: TaskClock = realClock) {}

  current(): WorkBudget {
    if (this.budget !== undefined) {
      return this.budget;
    }
    const { clock } = this;
    const deadline = clock.now() + taskBudgetMs;
    const budget = new WorkBudget({
      expired: () => clock.now() > deadline,
      reason: hostWorkReason,
    });
    this.budget = budget;
    clock.nextTask(() => {
      this.budget = undefined;
    });
    return budget;
  }
}

export const hostBudget = new TaskBudget();
