import * as zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { startHttpServer, type LocalServer } from '../../support/servers';
import { collector, send, waitFor } from './harness';

const original = '{"message": "synthetic streamed text"}\n'.repeat(50);
const servers: LocalServer[] = [];

async function serving(
  status: number,
  encoding: string,
  body: Uint8Array | undefined,
): Promise<LocalServer> {
  const server = await startHttpServer((_request, response) => {
    response.writeHead(status, { 'Content-Encoding': encoding });
    response.end(body);
  });
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const codings: [string, (input: Buffer) => Buffer][] = [
  ['gzip', (input) => zlib.gzipSync(input)],
  ['x-gzip', (input) => zlib.gzipSync(input)],
  ['deflate', (input) => zlib.deflateSync(input)],
  ['br', (input) => zlib.brotliCompressSync(input)],
  ['zstd', (input) => zlib.zstdCompressSync(input)],
];

describe('response decompression', () => {
  for (const [coding, compress] of codings) {
    it(`decodes ${coding}`, async () => {
      const compressed = compress(Buffer.from(original));
      const server = await serving(200, coding, compressed);

      const { outcome, sink } = await send({ url: server.url });

      expect(outcome.kind).toBe('completed');
      expect(sink.body()).toBe(original);
      expect(outcome.wireBytes).toBe(compressed.length);
      expect(outcome.decodedBytes).toBe(original.length);
    });
  }

  it('decodes raw deflate bodies', async () => {
    const server = await serving(200, 'deflate', zlib.deflateRawSync(Buffer.from(original)));

    const { outcome, sink } = await send({ url: server.url });

    expect(outcome.kind).toBe('completed');
    expect(sink.body()).toBe(original);
  });

  it('decodes chained codings in reverse order', async () => {
    const compressed = zlib.brotliCompressSync(zlib.gzipSync(Buffer.from(original)));
    const server = await serving(200, 'gzip, br', compressed);

    const { outcome, sink } = await send({ url: server.url });

    expect(outcome.kind).toBe('completed');
    expect(sink.body()).toBe(original);
  });

  it('completes HEAD, 204 and 304 responses that declare gzip but carry no body', async () => {
    const head = await serving(200, 'gzip', undefined);
    const noContent = await serving(204, 'gzip', undefined);
    const notModified = await serving(304, 'gzip', undefined);

    const results = await Promise.all([
      send({ url: head.url, method: 'HEAD' }),
      send({ url: noContent.url }),
      send({ url: notModified.url }),
    ]);

    expect(results.map(({ outcome }) => outcome.kind)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
  });

  it('passes unknown codings through unchanged', async () => {
    const server = await serving(200, 'snappy', Buffer.from('opaque'));

    const { outcome, sink } = await send({ url: server.url });

    expect(outcome.kind).toBe('completed');
    expect(sink.body()).toBe('opaque');
  });

  it('ignores identity', async () => {
    const server = await serving(200, 'identity', Buffer.from('plain'));

    const { sink } = await send({ url: server.url });

    expect(sink.body()).toBe('plain');
  });

  it('decodes up to five chained codings', async () => {
    let compressed = Buffer.from(original);
    for (let round = 0; round < 5; round += 1) {
      compressed = zlib.gzipSync(compressed);
    }
    const server = await serving(200, 'gzip, gzip, gzip, gzip, gzip', compressed);

    const { outcome, sink } = await send({ url: server.url });

    expect(outcome.kind).toBe('completed');
    expect(sink.body()).toBe(original);
  });

  it('fails with decompression for more than five codings', async () => {
    let compressed = Buffer.from(original);
    for (let round = 0; round < 6; round += 1) {
      compressed = zlib.gzipSync(compressed);
    }
    const server = await serving(
      200,
      Array.from({ length: 6 }, () => 'gzip').join(', '),
      compressed,
    );

    const { outcome } = await send({ url: server.url });

    expect(outcome.kind === 'failed' && outcome.failure.kind).toBe('decompression');
    expect(outcome.kind === 'failed' && outcome.failure.message).toContain('at most 5');
  });

  it('decodes raw deflate inside a chain of codings', async () => {
    const compressed = zlib.gzipSync(zlib.deflateRawSync(Buffer.from(original)));
    const server = await serving(200, 'deflate, gzip', compressed);

    const { outcome, sink } = await send({ url: server.url });

    expect(outcome.kind).toBe('completed');
    expect(sink.body()).toBe(original);
  });

  it('fails with decompression for a truncated gzip body', async () => {
    const compressed = zlib.gzipSync(Buffer.from(original));
    const server = await serving(200, 'gzip', compressed.subarray(0, compressed.length - 12));

    const { outcome } = await send({ url: server.url });

    expect(outcome.kind === 'failed' && outcome.failure.kind).toBe('decompression');
  });

  it('fails with decompression for a truncated brotli body', async () => {
    const compressed = zlib.brotliCompressSync(Buffer.from(original));
    const server = await serving(200, 'br', compressed.subarray(0, compressed.length - 4));

    const { outcome } = await send({ url: server.url });

    expect(outcome.kind === 'failed' && outcome.failure.kind).toBe('decompression');
  });

  it('fails with decompression for a corrupt gzip body', async () => {
    const server = await serving(200, 'gzip', Buffer.from('this is not gzip at all'));

    const { outcome } = await send({ url: server.url });

    expect(outcome.kind === 'failed' && outcome.failure.kind).toBe('decompression');
  });

  it('delivers decoded data before the response ends', async () => {
    let finish: (() => void) | undefined;
    const server = await startHttpServer((_request, response) => {
      response.writeHead(200, { 'Content-Encoding': 'gzip' });
      const gzip = zlib.createGzip();
      gzip.pipe(response);
      gzip.write('first ');
      gzip.flush(zlib.constants.Z_SYNC_FLUSH);
      finish = () => {
        gzip.end('second');
      };
    });
    servers.push(server);
    const sink = collector();

    const sending = send({ url: server.url }, {}, sink);
    await waitFor(() => sink.body() === 'first ', 2000);
    expect(finish).toBeDefined();
    finish?.();
    const { outcome } = await sending;

    expect(outcome.kind).toBe('completed');
    expect(sink.body()).toBe('first second');
  });
});
