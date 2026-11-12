export class CachedPromise<T> {
  private pending: Promise<T> | undefined;

  get(make: () => Promise<T>): Promise<T> {
    const current = (this.pending ??= make());
    current.catch(() => {
      if (this.pending === current) {
        this.pending = undefined;
      }
    });
    return current;
  }

  clear(): void {
    this.pending = undefined;
  }
}
