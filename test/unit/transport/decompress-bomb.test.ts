import { Buffer } from 'node:buffer';
import * as zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createDecoder } from '../../../src/transport/decompress';

const expanded = 64 * 1024 * 1024;
const zeros = Buffer.alloc(expanded);

async function turns(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const bombs: [string, () => Buffer][] = [
  [
    'br',
    () =>
      zlib.brotliCompressSync(zeros, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 1 },
      }),
  ],
  ['deflate', () => zlib.deflateSync(zeros, { level: 1 })],
  ['gzip, gzip', () => zlib.gzipSync(zlib.gzipSync(zeros, { level: 1 }), { level: 1 })],
  ['zstd', () => zlib.zstdCompressSync(zeros)],
];

describe('decompression backpressure', () => {
  it.each(bombs)(
    'stops decoding a %s bomb while its output is not read, then decodes all of it',
    async (encoding, compress) => {
      const bomb = compress();
      const decoder = createDecoder(encoding);
      expect(decoder).toBeDefined();
      if (decoder === undefined) {
        return;
      }
      decoder.write(bomb);
      await turns(25);

      expect(decoder.readableLength).toBeLessThanOrEqual(1024 * 1024);

      let total = 0;
      decoder.on('data', (chunk: Buffer) => {
        total += chunk.length;
      });
      const ended = new Promise<void>((resolve, reject) => {
        decoder.on('end', resolve);
        decoder.on('error', reject);
      });
      decoder.end();
      await ended;
      expect(total).toBe(expanded);
    },
    30_000,
  );
});
