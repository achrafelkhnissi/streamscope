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
  private readonly turns: (() => void)[] = [];
  private dispatching = false;

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

  requestTurn(turn: () => void): void {
    this.turns.push(turn);
    this.scheduleTurns();
  }

  private scheduleTurns(): void {
    if (!this.dispatching) {
      this.dispatching = true;
      this.clock.nextTask(() => {
        this.dispatch();
      });
    }
  }

  private dispatch(): void {
    this.dispatching = false;
    for (let waiting = this.turns.length; waiting > 0 && this.hasRoom; waiting -= 1) {
      this.turns.shift()?.();
    }
    if (this.turns.length > 0) {
      this.scheduleTurns();
    }
  }
}

export const hostBudget = new TaskBudget();
