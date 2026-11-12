import type { RunHandle } from './run';

export class RunHistory {
  private readonly runs = new Map<number, RunHandle>();

  constructor(private readonly limit: number) {}

  add(run: RunHandle): void {
    this.runs.set(run.id, run);
    if (this.runs.size > this.limit) {
      const oldest = this.runs.values().next().value;
      if (oldest !== undefined) {
        this.runs.delete(oldest.id);
        void oldest.release();
      }
    }
  }

  list(): readonly RunHandle[] {
    return [...this.runs.values()].reverse();
  }

  find(id: number): RunHandle | undefined {
    return this.runs.get(id);
  }

  async dispose(): Promise<void> {
    const held = [...this.runs.values()];
    this.runs.clear();
    await Promise.all(held.map((run) => run.release()));
  }
}
