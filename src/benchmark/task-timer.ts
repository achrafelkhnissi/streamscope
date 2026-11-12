export const taskBudgetMs = 50;

export interface TaskSummary {
  longestTaskMs: number;
  tasksOverBudget: number;
}

export class TaskTimer {
  private longest = 0;
  private over = 0;

  record(ms: number): void {
    this.longest = Math.max(this.longest, ms);
    if (ms > taskBudgetMs) {
      this.over += 1;
    }
  }

  reset(): void {
    this.longest = 0;
    this.over = 0;
  }

  summary(): TaskSummary {
    return { longestTaskMs: this.longest, tasksOverBudget: this.over };
  }
}
