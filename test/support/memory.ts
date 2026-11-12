export function collect(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc === undefined) {
    throw new Error('Run the tests with --expose-gc');
  }
  gc();
  gc();
}

export function retainedHeap(build: () => unknown): { value: unknown; bytes: number } {
  collect();
  const before = process.memoryUsage().heapUsed;
  const value = build();
  collect();
  return { value, bytes: process.memoryUsage().heapUsed - before };
}
