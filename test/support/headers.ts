export function headerPairs(rawHeaders: readonly string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    pairs.push([rawHeaders[index] ?? '', rawHeaders[index + 1] ?? '']);
  }
  return pairs;
}
