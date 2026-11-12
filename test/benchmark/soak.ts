import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { JsonValue } from '../../src/events/model';
import { StreamSession } from '../../src/events/session';
import { SpillArea } from '../../src/events/spill';
import { NodeTransport } from '../../src/transport/node-transport';
import type { ResponseSink, TransportOptions } from '../../src/transport/model';
import { startStreamServer, type SyntheticFormat } from '../support/stream-server';

export interface SoakResult {
  format: SyntheticFormat;
  rate: number;
  seconds: number;
  events: number;
  maxHeapBytes: number;
  maxExternalBytes: number;
  maxRssBytes: number;
  maxArrayBuffersBytes: number;
  maxMemoryBytes: number;
  lagP95Ms: number;
  lagMaxMs: number;
  spillBytes: number;
  spillDirectory: string;
}

const histogramLimitMs = 10_000;

function sentAtOf(value: JsonValue | undefined): number | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const sentAt = (value as { readonly [key: string]: JsonValue }).sentAt;
  return typeof sentAt === 'number' ? sentAt : undefined;
}

function percentile(histogram: Uint32Array, fraction: number): number {
  const total = histogram.reduce((sum, count) => sum + count, 0);
  const target = Math.ceil(total * fraction);
  let seen = 0;
  for (const [bucket, count] of histogram.entries()) {
    seen += count;
    if (seen >= target && count > 0) {
      return bucket;
    }
  }
  return 0;
}

const transportOptions: TransportOptions = {
  rejectUnauthorized: true,
  ca: undefined,
  connectTimeoutMs: 10_000,
  headersTimeoutMs: 10_000,
  totalTimeoutMs: undefined,
  followRedirects: false,
  maxRedirects: 0,
};

export async function runSoak(options: {
  format: SyntheticFormat;
  rate: number;
  seconds: number;
  eventBytes: number;
  sampleMs: number;
}): Promise<SoakResult> {
  const server = await startStreamServer();
  const root = await mkdtemp(path.join(tmpdir(), 'streamscope-soak-'));
  const area = await SpillArea.open(root);
  const spill = await area.create();
  const histogram = new Uint32Array(histogramLimitMs + 1);
  const memory = { heap: 0, external: 0, rss: 0, arrayBuffers: 0, total: 0 };
  let lagMax = 0;
  let measured = 0;
  let session: StreamSession | undefined;
  const sample = (): void => {
    (globalThis as { gc?: () => void }).gc?.();
    const usage = process.memoryUsage();
    memory.heap = Math.max(memory.heap, usage.heapUsed);
    memory.external = Math.max(memory.external, usage.external);
    memory.rss = Math.max(memory.rss, usage.rss);
    memory.arrayBuffers = Math.max(memory.arrayBuffers, usage.arrayBuffers);
    memory.total = Math.max(memory.total, usage.heapUsed + usage.arrayBuffers);
  };
  const measure = (): void => {
    if (session === undefined) {
      return;
    }
    const now = performance.timeOrigin + performance.now();
    for (let index = measured + 1; index <= session.store.count; index += 1) {
      const sentAt = sentAtOf(session.store.inMemory(index)?.value);
      if (sentAt !== undefined) {
        const lag = Math.max(0, now - sentAt);
        lagMax = Math.max(lagMax, lag);
        const bucket = Math.min(histogramLimitMs, Math.floor(lag));
        histogram[bucket] = (histogram[bucket] ?? 0) + 1;
      }
    }
    measured = session.store.count;
  };
  const sink: ResponseSink = {
    onRequest: () => undefined,
    onHead: (head) => {
      const contentType = head.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1];
      const startedAt = performance.now();
      session = new StreamSession({
        contentType,
        directive: undefined,
        spill,
        now: () => performance.now() - startedAt,
        onUpdate: measure,
        onText: () => undefined,
      });
    },
    onData: (chunk) => {
      session?.write(chunk);
    },
  };
  const url = new URL(
    `${server.url}/stream?format=${options.format}&rate=${String(options.rate)}&seconds=${String(options.seconds)}&size=${String(options.eventBytes)}`,
  );
  sample();
  const sampler = setInterval(sample, options.sampleMs);
  const outcome = await new NodeTransport().send(
    { method: 'GET', url, headers: [], body: [] },
    transportOptions,
    sink,
    new AbortController().signal,
  );
  session?.end();
  clearInterval(sampler);
  sample();
  const events = session?.store.count ?? 0;
  session?.dispose();
  const spillBytes = spill.savedBytes;
  await area.dispose();
  await rm(root, { recursive: true, force: true });
  await server.close();
  if (outcome.kind !== 'completed') {
    throw new Error(`The soak request did not complete: ${outcome.kind}`);
  }
  return {
    format: options.format,
    rate: options.rate,
    seconds: options.seconds,
    events,
    maxHeapBytes: memory.heap,
    maxExternalBytes: memory.external,
    maxRssBytes: memory.rss,
    maxArrayBuffersBytes: memory.arrayBuffers,
    maxMemoryBytes: memory.total,
    lagP95Ms: percentile(histogram, 0.95),
    lagMaxMs: lagMax,
    spillBytes,
    spillDirectory: area.directory,
  };
}
