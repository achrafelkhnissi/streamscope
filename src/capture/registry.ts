import {
  ownCaptureReason,
  waitCancelledReason,
  waitCycleReason,
  waitTimeoutReason,
} from './messages';
import type { CaptureResult } from './tracker';

export interface CaptureEntry {
  request: string;
  label: string;
  name: string;
  secret: boolean;
  runId: number;
  runStartedAt: number;
  result: CaptureResult;
}

export type CaptureWaitKind = 'timeout' | 'cancelled' | 'self' | 'cycle';

export class CaptureWaitError extends Error {
  constructor(
    readonly kind: CaptureWaitKind,
    message: string,
  ) {
    super(message);
    this.name = 'CaptureWaitError';
  }
}

export const maxCaptureRequests = 500;

interface RequestCaptures {
  readonly key: string;
  readonly label: string;
  readonly runId: number;
  readonly startedAt: number;
  readonly entries: Map<string, CaptureEntry>;
}

interface Wait {
  readonly request: string;
  readonly name: string;
  readonly waiter: number;
  settle(entry: CaptureEntry): void;
}

const pendingResult: CaptureResult = { state: 'pending' };

function added<Key, Item>(map: Map<Key, Set<Item>>, key: Key, item: Item): void {
  const items = map.get(key);
  if (items === undefined) {
    map.set(key, new Set([item]));
  } else {
    items.add(item);
  }
}

function removed<Key, Item>(map: Map<Key, Set<Item>>, key: Key, item: Item): boolean {
  const items = map.get(key);
  if (items?.delete(item) !== true) {
    return false;
  }
  if (items.size === 0) {
    map.delete(key);
  }
  return true;
}

export class CaptureRegistry {
  private readonly requests = new Map<string, RequestCaptures>();
  private readonly runs = new Map<number, RequestCaptures>();
  private readonly declaring = new Map<string, Set<RequestCaptures>>();
  private readonly waitsByCapture = new Map<string, Set<Wait>>();
  private readonly waitsByRun = new Map<number, Set<Wait>>();
  private readonly listeners = new Set<(entry: CaptureEntry) => void>();
  private waits = 0;

  constructor(private readonly limit = maxCaptureRequests) {}

  get size(): number {
    return this.requests.size;
  }

  get waitCount(): number {
    return this.waits;
  }

  begin(
    run: { id: number; key: string; label: string; startedAt: number },
    definitions: readonly { name: string; secret: boolean }[],
  ): void {
    const earlier = this.requests.get(run.key);
    if (earlier !== undefined) {
      this.remove(earlier);
    }
    if (definitions.length === 0) {
      return;
    }
    if (this.requests.size >= this.limit) {
      this.evict();
    }
    const captures: RequestCaptures = {
      key: run.key,
      label: run.label,
      runId: run.id,
      startedAt: run.startedAt,
      entries: new Map(),
    };
    for (const { name, secret } of definitions) {
      captures.entries.set(name, {
        request: run.key,
        label: run.label,
        name,
        secret,
        runId: run.id,
        runStartedAt: run.startedAt,
        result: pendingResult,
      });
      added(this.declaring, name, captures);
    }
    this.requests.set(run.key, captures);
    this.runs.set(run.id, captures);
    for (const entry of captures.entries.values()) {
      this.emit(entry);
    }
  }

  update(runId: number, name: string, result: CaptureResult): void {
    const captures = this.runs.get(runId);
    const entry = captures?.entries.get(name);
    if (captures === undefined || entry === undefined) {
      return;
    }
    const updated = { ...entry, result };
    captures.entries.set(name, updated);
    this.emit(updated);
    if (result.state === 'pending') {
      return;
    }
    for (const wait of [...(this.waitsByCapture.get(captureKey(captures.key, name)) ?? [])]) {
      wait.settle(updated);
    }
  }

  get(request: string, name: string): CaptureEntry | undefined {
    return this.requests.get(request)?.entries.get(name);
  }

  latest(name: string): CaptureEntry | undefined {
    let latest: RequestCaptures | undefined;
    for (const captures of this.declaring.get(name) ?? []) {
      if (
        latest === undefined ||
        captures.startedAt > latest.startedAt ||
        (captures.startedAt === latest.startedAt && captures.runId > latest.runId)
      ) {
        latest = captures;
      }
    }
    return latest?.entries.get(name);
  }

  forRequest(request: string): readonly CaptureEntry[] {
    const captures = this.requests.get(request);
    return captures === undefined ? [] : [...captures.entries.values()];
  }

  wait(
    request: string,
    name: string,
    waiter: number,
    options: { timeoutMs: number; signal: AbortSignal },
  ): Promise<CaptureEntry> {
    const { timeoutMs, signal } = options;
    const producer = this.requests.get(request);
    const label = producer?.label ?? request;
    if (signal.aborted) {
      return Promise.reject(new CaptureWaitError('cancelled', waitCancelledReason(label, name)));
    }
    if (this.runs.get(waiter)?.key === request) {
      return Promise.reject(new CaptureWaitError('self', ownCaptureReason(label, name)));
    }
    const entry = producer?.entries.get(name);
    if (entry !== undefined && entry.result.state !== 'pending') {
      return Promise.resolve(entry);
    }
    const cycle = producer === undefined ? undefined : this.cycle(waiter, producer);
    if (cycle !== undefined) {
      return Promise.reject(new CaptureWaitError('cycle', waitCycleReason(cycle)));
    }
    return new Promise((resolve, reject) => {
      const end = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        this.forget(wait);
      };
      const cancel = (): void => {
        end();
        reject(new CaptureWaitError('cancelled', waitCancelledReason(label, name)));
      };
      const wait: Wait = {
        request,
        name,
        waiter,
        settle: (settled) => {
          end();
          resolve(settled);
        },
      };
      const timer = setTimeout(() => {
        end();
        reject(new CaptureWaitError('timeout', waitTimeoutReason(label, name, timeoutMs)));
      }, timeoutMs);
      signal.addEventListener('abort', cancel, { once: true });
      this.remember(wait);
    });
  }

  onDidChange(listener: (entry: CaptureEntry) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(entry: CaptureEntry): void {
    for (const listener of this.listeners) {
      listener(entry);
    }
  }

  private cycle(waiter: number, producer: RequestCaptures): readonly string[] | undefined {
    const previous = new Map<RequestCaptures, RequestCaptures>();
    const queue = [producer];
    for (const current of queue) {
      for (const wait of this.waitsByRun.get(current.runId) ?? []) {
        const next = this.requests.get(wait.request);
        if (next === undefined || next === producer || previous.has(next)) {
          continue;
        }
        previous.set(next, current);
        if (next.runId === waiter) {
          const chain: string[] = [];
          for (let at: RequestCaptures | undefined = current; at; at = previous.get(at)) {
            chain.push(at.label);
          }
          return [next.label, ...chain.reverse()];
        }
        queue.push(next);
      }
    }
    return undefined;
  }

  private remember(wait: Wait): void {
    added(this.waitsByCapture, captureKey(wait.request, wait.name), wait);
    added(this.waitsByRun, wait.waiter, wait);
    this.waits += 1;
  }

  private forget(wait: Wait): void {
    if (removed(this.waitsByCapture, captureKey(wait.request, wait.name), wait)) {
      removed(this.waitsByRun, wait.waiter, wait);
      this.waits -= 1;
    }
  }

  private remove(captures: RequestCaptures): void {
    this.requests.delete(captures.key);
    this.runs.delete(captures.runId);
    for (const name of captures.entries.keys()) {
      removed(this.declaring, name, captures);
    }
  }

  private evict(): void {
    let oldest: RequestCaptures | undefined;
    for (const captures of this.requests.values()) {
      if (oldest === undefined || captures.startedAt < oldest.startedAt) {
        oldest = captures;
      }
    }
    if (oldest !== undefined) {
      this.remove(oldest);
    }
  }
}

function captureKey(request: string, name: string): string {
  return `${name} ${request}`;
}
