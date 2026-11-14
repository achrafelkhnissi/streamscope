import type { CheckResult } from './tracker';

export const maxCheckRequests = 500;

export interface CheckEntry {
  runId: number;
  text: string;
  line: number;
  result: CheckResult | { state: 'pending' };
}

interface RequestChecks {
  key: string;
  runId: number;
  startedAt: number;
  entries: CheckEntry[];
}

export interface CheckSummary {
  passed: number;
  failed: number;
  total: number;
}

export class CheckRegistry {
  private readonly requests = new Map<string, RequestChecks>();
  private readonly runs = new Map<number, RequestChecks>();
  private readonly listeners = new Set<(key: string) => void>();

  constructor(private readonly limit = maxCheckRequests) {}

  get size(): number {
    return this.requests.size;
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  begin(
    run: { id: number; key: string; startedAt: number },
    checks: readonly { text: string; line: number }[],
  ): void {
    const earlier = this.requests.get(run.key);
    if (earlier !== undefined) {
      this.requests.delete(earlier.key);
      this.runs.delete(earlier.runId);
    }
    if (checks.length > 0) {
      if (this.requests.size >= this.limit) {
        this.evict();
      }
      const request: RequestChecks = {
        key: run.key,
        runId: run.id,
        startedAt: run.startedAt,
        entries: checks.map(({ text, line }) => ({
          runId: run.id,
          text,
          line,
          result: { state: 'pending' },
        })),
      };
      this.requests.set(run.key, request);
      this.runs.set(run.id, request);
    }
    this.emit(run.key);
  }

  update(runId: number, index: number, result: CheckResult): void {
    const request = this.runs.get(runId);
    const entry = request?.entries[index];
    if (request === undefined || entry === undefined) {
      return;
    }
    entry.result = result;
    this.emit(request.key);
  }

  forRequest(key: string): readonly CheckEntry[] {
    return this.requests.get(key)?.entries ?? [];
  }

  summary(key: string): CheckSummary | undefined {
    const entries = this.requests.get(key)?.entries;
    if (entries === undefined) {
      return undefined;
    }
    let passed = 0;
    let failed = 0;
    for (const { result } of entries) {
      if (result.state === 'passed') {
        passed += 1;
      } else if (result.state === 'failed') {
        failed += 1;
      }
    }
    return { passed, failed, total: entries.length };
  }

  onDidChange(listener: (key: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(key: string): void {
    for (const listener of this.listeners) {
      listener(key);
    }
  }

  private evict(): void {
    let oldest: RequestChecks | undefined;
    for (const request of this.requests.values()) {
      if (oldest === undefined || request.startedAt < oldest.startedAt) {
        oldest = request;
      }
    }
    if (oldest !== undefined) {
      this.requests.delete(oldest.key);
      this.runs.delete(oldest.runId);
      this.emit(oldest.key);
    }
  }
}
