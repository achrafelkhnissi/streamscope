export class UpdateBatcher {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queued = false;
  private lastFlush: number | undefined;
  private disposed = false;

  constructor(
    private readonly flush: () => void,
    private readonly options: { intervalMs: number; now: () => number },
  ) {}

  schedule(): void {
    if (this.disposed || this.queued || this.timer !== undefined) {
      return;
    }
    const now = this.options.now();
    const due = this.lastFlush === undefined ? now : this.lastFlush + this.options.intervalMs;
    if (due <= now) {
      this.queued = true;
      queueMicrotask(() => {
        if (this.queued) {
          this.queued = false;
          this.run();
        }
      });
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.run();
    }, due - now);
  }

  flushNow(): void {
    if (this.disposed) {
      return;
    }
    this.cancel();
    this.run();
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private run(): void {
    this.lastFlush = this.options.now();
    this.flush();
  }

  private cancel(): void {
    this.queued = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
