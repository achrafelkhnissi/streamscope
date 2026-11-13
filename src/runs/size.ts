const sizePattern = /^(\d+)(KiB|MiB|GiB)$/;
const unitBytes: Record<string, number> = { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };

export function parseSize(text: string): number | undefined {
  const match = sizePattern.exec(text);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]) * (unitBytes[match[2] ?? ''] ?? 0);
  return Number.isSafeInteger(value) ? value : undefined;
}
