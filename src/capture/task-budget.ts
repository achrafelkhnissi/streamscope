import { WorkBudget } from '../expressions/work';
import { hostWorkReason } from './messages';

export interface TaskClock {
  now(): number;
  nextTask(callback: () => void): void;
}

export const captureSliceMs = 10;
export const hostEvaluationUnits = 2_000_000;

const realClock: TaskClock = {
  now: () => performance.now(),
  nextTask: (callback) => {
    setImmediate(callback);
  },
};

export class TaskBudget {
  private readonly work = new WorkBudget({ units: hostEvaluationUnits, reason: hostWorkReason });
  private open = false;
  private spentMs = 0;
  private since = 0;

  constructor(private readonly clock: TaskClock = realClock) {}

  get hasRoom(): boolean {
    return !this.open || this.spentMs < captureSliceMs;
  }

  enter(): WorkBudget {
    if (!this.open) {
      this.open = true;
      this.spentMs = 0;
      this.clock.nextTask(() => {
        this.open = false;
      });
    }
    this.since = this.clock.now();
    this.work.restart();
    return this.work;
  }

  roomLeft(): boolean {
    return this.spentMs + this.clock.now() - this.since < captureSliceMs;
  }

  leave(): void {
    this.spentMs += this.clock.now() - this.since;
    this.work.forget();
  }

  afterTask(callback: () => void): void {
    this.clock.nextTask(callback);
  }
}

export const hostBudget = new TaskBudget();
