import { WorkBudget } from '../expressions/work';
import { hostWorkReason } from './messages';

export interface TaskClock {
  now(): number;
  nextTask(callback: () => void): void;
}

export const taskBudgetMs = 30;
export const evaluationAllowanceMs = 0.005;
export const taskEvaluationCapMs = 200;

const realClock: TaskClock = {
  now: () => performance.now(),
  nextTask: (callback) => {
    setImmediate(callback);
  },
};

export class TaskBudget {
  private budget: WorkBudget | undefined;
  private countedMs = 0;
  private excessMs = 0;
  private freeMs = 0;
  private checked = false;
  private since: number | undefined;

  constructor(private readonly clock: TaskClock = realClock) {}

  enter(evaluations = 1): WorkBudget {
    this.freeMs = evaluationAllowanceMs * evaluations;
    this.checked = false;
    this.since = this.clock.now();
    return this.budget ?? this.start();
  }

  leave(): void {
    this.lap(this.checked);
    this.since = undefined;
  }

  private start(): WorkBudget {
    this.countedMs = 0;
    this.excessMs = 0;
    const budget = new WorkBudget({
      expired: () => {
        this.lap(true);
        this.checked = true;
        return this.countedMs > taskBudgetMs || this.excessMs > taskEvaluationCapMs;
      },
      reason: hostWorkReason,
    });
    this.budget = budget;
    this.clock.nextTask(() => {
      this.budget = undefined;
    });
    return budget;
  }

  private lap(counts: boolean): void {
    if (this.since === undefined) {
      return;
    }
    const now = this.clock.now();
    const elapsed = now - this.since;
    const excess = Math.max(0, elapsed - this.freeMs);
    this.excessMs += excess;
    if (counts) {
      this.countedMs += excess;
    }
    this.freeMs = Math.max(0, this.freeMs - elapsed);
    this.since = now;
  }
}

export const hostBudget = new TaskBudget();
