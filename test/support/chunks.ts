export function* everySplit(bytes: Uint8Array): Generator<Uint8Array[]> {
  yield [bytes];
  for (let index = 1; index < bytes.length; index += 1) {
    yield [bytes.subarray(0, index), bytes.subarray(index)];
  }
  yield Array.from({ length: bytes.length }, (_, index) => bytes.subarray(index, index + 1));
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSplits(bytes: Uint8Array, seed: number, count: number): Uint8Array[][] {
  const random = mulberry32(seed);
  return Array.from({ length: count }, () => {
    const chunks: Uint8Array[] = [];
    let start = 0;
    while (start < bytes.length) {
      const size = Math.min(bytes.length - start, 1 + Math.floor(random() ** 2 * 64));
      chunks.push(bytes.subarray(start, start + size));
      start += size;
    }
    return chunks;
  });
}
