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
  private spentMs = 0;
  private since: number | undefined;

  constructor(private readonly clock: TaskClock = realClock) {}

  enter(): WorkBudget {
    this.since = this.clock.now();
    return this.budget ?? this.start();
  }

  leave(): void {
    this.elapsed();
    this.since = undefined;
  }

  private start(): WorkBudget {
    this.spentMs = 0;
    const budget = new WorkBudget({
      expired: () => this.elapsed() > taskBudgetMs,
      reason: hostWorkReason,
    });
    this.budget = budget;
    this.clock.nextTask(() => {
      this.budget = undefined;
    });
    return budget;
  }

  private elapsed(): number {
    if (this.since !== undefined) {
      const now = this.clock.now();
      this.spentMs += now - this.since;
      this.since = now;
    }
    return this.spentMs;
  }
}

export const hostBudget = new TaskBudget();
