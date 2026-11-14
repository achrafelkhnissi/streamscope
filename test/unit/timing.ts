export const timedRuns = 3;

export function fastest<T>(run: () => T): { value: T; ms: number } {
  let start = performance.now();
  let value = run();
  let ms = performance.now() - start;
  for (let round = 1; round < timedRuns; round += 1) {
    start = performance.now();
    value = run();
    ms = Math.min(ms, performance.now() - start);
  }
  return { value, ms };
}

export async function fastestOf(round: () => Promise<number>): Promise<number> {
  let ms = Number.POSITIVE_INFINITY;
  for (let at = 0; at < timedRuns; at += 1) {
    ms = Math.min(ms, await round());
  }
  return ms;
}
