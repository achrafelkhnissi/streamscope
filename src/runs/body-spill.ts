import type { SpillFile } from '../events/spill';

export type DataSource = 'memory' | 'spill' | 'gone';

const chunkBytes = 1_048_576;

function holdsBody(file: SpillFile | undefined, bodyLength: number): file is SpillFile {
  return file !== undefined && !file.evicted && file.savedBytes >= bodyLength;
}

export function bodySourceOf(
  dropped: boolean,
  file: SpillFile | undefined,
  released: boolean,
  bodyLength: number,
): DataSource {
  if (!dropped || bodyLength === 0) {
    return 'memory';
  }
  return !released && holdsBody(file, bodyLength) ? 'spill' : 'gone';
}

export async function readBodyFromSpill(
  file: SpillFile | undefined,
  bodyLength: number,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  const length = Math.min(bodyLength, maxBytes);
  if (length === 0) {
    return new Uint8Array();
  }
  if (!holdsBody(file, bodyLength)) {
    return undefined;
  }
  const body = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += chunkBytes) {
    const piece = await file.read(offset, Math.min(chunkBytes, length - offset));
    if (piece === undefined) {
      return undefined;
    }
    body.set(piece, offset);
  }
  return body;
}
