import type { CaptureRegistry } from './registry';

const captureRefreshMs = 200;

export class CaptureChanges {
  private requests = new Set<string>();
  private names = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly unsubscribe: () => void;

  constructor(
    registry: CaptureRegistry,
    private readonly refresh: (requests: ReadonlySet<string>, names: ReadonlySet<string>) => void,
  ) {
    this.unsubscribe = registry.onDidChange((request, name) => {
      this.requests.add(request);
      this.names.add(name);
      this.timer ??= setTimeout(() => {
        this.flush();
      }, captureRefreshMs);
    });
  }

  dispose(): void {
    this.unsubscribe();
    clearTimeout(this.timer);
    this.timer = undefined;
    this.requests.clear();
    this.names.clear();
  }

  private flush(): void {
    const { requests, names } = this;
    this.timer = undefined;
    this.requests = new Set();
    this.names = new Set();
    this.refresh(requests, names);
  }
}
