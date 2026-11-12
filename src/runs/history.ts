import type { RunHandle } from './run';

export class RunHistory {
  private readonly runs = new Map<number, RunHandle>();

  constructor(
    private readonly limit: number,
    private readonly canEvict: (run: RunHandle) => boolean,
  ) {}

  add(run: RunHandle): void {
    this.runs.set(run.id, run);
    for (const held of this.runs.values()) {
      if (this.runs.size <= this.limit) {
        break;
      }
      if (held !== run && this.canEvict(held)) {
        this.runs.delete(held.id);
        void held.release();
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
