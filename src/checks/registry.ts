import { maskValues } from '../masking/masking';
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

function isSettled(request: RequestChecks): boolean {
  return request.entries.every(({ result }) => result.state !== 'pending');
}

export class CheckRegistry {
  private readonly requests = new Map<string, RequestChecks>();
  private readonly runs = new Map<number, RequestChecks>();
  private readonly listeners = new Set<(key: string) => void>();
  private readonly waiters = new Map<
    number,
    ((entries: readonly CheckEntry[] | undefined) => void)[]
  >();

  constructor(private readonly limit = maxCheckRequests) {}

  get size(): number {
    return this.requests.size;
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  get waiterCount(): number {
    let count = 0;
    for (const waiting of this.waiters.values()) {
      count += waiting.length;
    }
    return count;
  }

  begin(
    run: { id: number; key: string; startedAt: number },
    checks: readonly { text: string; line: number }[],
  ): void {
    const earlier = this.requests.get(run.key);
    if (earlier !== undefined) {
      this.requests.delete(earlier.key);
      this.runs.delete(earlier.runId);
      this.release(earlier.runId, undefined);
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
    if (this.waiters.has(runId) && isSettled(request)) {
      this.release(runId, request.entries);
    }
    this.emit(request.key);
  }

  settled(key: string, runId: number): Promise<readonly CheckEntry[] | undefined> {
    const request = this.requests.get(key);
    if (request === undefined) {
      return Promise.resolve([]);
    }
    if (request.runId !== runId) {
      return Promise.resolve(undefined);
    }
    if (isSettled(request)) {
      return Promise.resolve(request.entries);
    }
    return new Promise((resolve) => {
      const waiting = this.waiters.get(runId);
      if (waiting === undefined) {
        this.waiters.set(runId, [resolve]);
      } else {
        waiting.push(resolve);
      }
    });
  }

  runOf(key: string): number | undefined {
    return this.requests.get(key)?.runId;
  }

  remask(key: string, values: readonly string[]): void {
    const request = this.requests.get(key);
    if (request === undefined || values.length === 0) {
      return;
    }
    let changed = false;
    for (const entry of request.entries) {
      if (entry.result.state === 'failed') {
        const detail = maskValues(entry.result.detail, values);
        if (detail !== entry.result.detail) {
          entry.result = { ...entry.result, detail };
          changed = true;
        }
      }
    }
    if (changed) {
      this.emit(key);
    }
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

  private release(runId: number, entries: readonly CheckEntry[] | undefined): void {
    const waiting = this.waiters.get(runId);
    if (waiting === undefined) {
      return;
    }
    this.waiters.delete(runId);
    for (const resolve of waiting) {
      resolve(entries);
    }
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
      this.release(oldest.runId, undefined);
      this.emit(oldest.key);
    }
  }
}
