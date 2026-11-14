import {
  startRun,
  type RunDependencies,
  type RunHandle,
  type RunInput,
  type RunSnapshot,
} from './run';

export function isActive(handle: RunHandle): boolean {
  const { status } = handle.snapshot();
  return status === 'waiting' || status === 'sending' || status === 'receiving';
}

export class RunRegistry {
  private readonly runs = new Map<string, RunHandle>();
  private readonly listeners = new Set<(snapshot: RunSnapshot) => void>();

  constructor(private readonly dependencies: RunDependencies) {}

  start(input: RunInput): RunHandle {
    this.runs.get(input.key)?.cancel();
    const handle = startRun(input, this.dependencies, (snapshot) => {
      for (const listener of this.listeners) {
        listener(snapshot);
      }
    });
    this.runs.set(input.key, handle);
    return handle;
  }

  latest(key: string): RunHandle | undefined {
    return this.runs.get(key);
  }

  cancel(key: string): boolean {
    const handle = this.runs.get(key);
    if (!handle || !isActive(handle)) {
      return false;
    }
    handle.cancel();
    return true;
  }

  isRunning(): boolean {
    return [...this.runs.values()].some(isActive);
  }

  running(): RunHandle[] {
    return [...this.runs.values()].filter(isActive);
  }

  onDidChange(listener: (snapshot: RunSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    for (const handle of this.runs.values()) {
      handle.cancel();
    }
    this.listeners.clear();
  }
}
