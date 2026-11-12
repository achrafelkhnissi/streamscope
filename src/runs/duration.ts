const durationPattern = /^(\d+)(ms|s|m)$/;
const unitMs: Record<string, number> = { ms: 1, s: 1000, m: 60_000 };
const longestTimerMs = 2_147_483_647;

export function parseDuration(text: string): number | undefined {
  const match = durationPattern.exec(text);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]) * (unitMs[match[2] ?? ''] ?? 0);
  return value <= longestTimerMs ? value : undefined;
}
