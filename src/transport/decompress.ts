import { Transform, type TransformCallback } from 'node:stream';
import * as zlib from 'node:zlib';

const maxCodings = 5;
const knownCodings: ReadonlySet<string> = new Set(['gzip', 'x-gzip', 'deflate', 'br', 'zstd']);
const zlibOptions: zlib.ZlibOptions = {
  flush: zlib.constants.Z_SYNC_FLUSH,
  finishFlush: zlib.constants.Z_SYNC_FLUSH,
};
const brotliOptions: zlib.BrotliOptions = {
  flush: zlib.constants.BROTLI_OPERATION_FLUSH,
  finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH,
};

function isZlibWrapped(firstByte: number | undefined): boolean {
  return firstByte === undefined || (firstByte & 0x0f) === 0x08;
}

function stage(coding: string, firstByte: number | undefined): Transform {
  switch (coding) {
    case 'deflate':
      return isZlibWrapped(firstByte)
        ? zlib.createInflate(zlibOptions)
        : zlib.createInflateRaw(zlibOptions);
    case 'br':
      return zlib.createBrotliDecompress(brotliOptions);
    case 'zstd':
      return zlib.createZstdDecompress();
    default:
      return zlib.createGunzip(zlibOptions);
  }
}

class Decoder extends Transform {
  private stages: Transform[] = [];

  constructor(private readonly codings: readonly string[]) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const first = this.stages[0] ?? this.start(chunk);
    first.write(chunk, () => {
      callback();
    });
  }

  override _flush(callback: TransformCallback): void {
    const first = this.stages[0];
    const last = this.stages[this.stages.length - 1];
    if (!first || !last) {
      callback();
      return;
    }
    last.once('end', () => {
      callback();
    });
    first.end();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    for (const inner of this.stages) {
      inner.destroy();
    }
    callback(error);
  }

  private start(chunk: Buffer): Transform {
    this.stages = this.codings.map((coding, index) =>
      stage(coding, index === 0 ? chunk[0] : undefined),
    );
    this.stages.forEach((inner, index) => {
      inner.on('error', (error) => {
        this.destroy(error);
      });
      const next = this.stages[index + 1];
      if (next) {
        inner.pipe(next);
      } else {
        inner.on('data', (data: Buffer) => {
          this.push(data);
        });
      }
    });
    return this.stages[0] as Transform;
  }
}

export function createDecoder(contentEncoding: string | undefined): Transform | undefined {
  const codings = (contentEncoding ?? '')
    .split(',')
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== '' && coding !== 'identity');
  if (codings.length === 0 || codings.some((coding) => !knownCodings.has(coding))) {
    return undefined;
  }
  if (codings.length > maxCodings) {
    throw new Error(
      `the response lists ${String(codings.length)} content codings and Streamscope decodes at most ${String(maxCodings)}`,
    );
  }
  return new Decoder(codings.reverse());
}
