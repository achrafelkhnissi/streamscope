export class BoundedCache<Value> {
  private readonly entries = new Map<string, Value>();

  constructor(private readonly limit: number) {}

  get(key: string): Value | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: Value): void {
    if (!this.entries.has(key) && this.entries.size >= this.limit) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) {
        this.entries.delete(oldest.value);
      }
    }
    this.entries.set(key, value);
  }
}
