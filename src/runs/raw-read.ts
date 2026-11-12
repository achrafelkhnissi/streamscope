import type { SpillFile } from '../events/spill';

export const rawTailBytes = 2_097_152;

const continuationMask = 0xc0;
const continuationByte = 0x80;
const decoder = new TextDecoder();

export async function readRawTail(
  file: SpillFile | undefined,
  released: boolean,
  maxBytes: number = rawTailBytes,
): Promise<string | undefined> {
  if (file === undefined || released || file.evicted) {
    return undefined;
  }
  const saved = file.savedBytes;
  const start = Math.max(0, saved - maxBytes);
  const bytes = await file.read(start, saved - start);
  if (bytes === undefined) {
    return undefined;
  }
  let from = 0;
  if (start > 0) {
    while (from < bytes.length && ((bytes[from] ?? 0) & continuationMask) === continuationByte) {
      from += 1;
    }
  }
  return decoder.decode(bytes.subarray(from));
}
