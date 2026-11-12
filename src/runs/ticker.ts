const defaultIntervalMs = 1000;

export class LiveTicker {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly isActive: () => boolean,
    private readonly onTick: () => void,
    private readonly intervalMs = defaultIntervalMs,
  ) {}

  poke(): void {
    this.onTick();
    if (this.timer === undefined && this.isActive()) {
      this.timer = setInterval(() => {
        if (!this.isActive()) {
          this.stop();
        }
        this.onTick();
      }, this.intervalMs);
    }
  }

  dispose(): void {
    this.stop();
  }

  private stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
