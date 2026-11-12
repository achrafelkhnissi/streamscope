import { StreamSession } from '../../src/events/session';
import { contentEvent, type SyntheticFormat } from '../support/stream-server';

export interface ThroughputResult {
  format: SyntheticFormat;
  events: number;
  eventBytes: number;
  seconds: number;
  eventsPerSecond: number;
}

export function measureThroughput(options: {
  format: SyntheticFormat;
  events: number;
  eventBytes: number;
  chunkBytes: number;
}): ThroughputResult {
  const sentAt = performance.timeOrigin + performance.now();
  const parts: string[] = [];
  for (let sequence = 1; sequence <= options.events; sequence += 1) {
    parts.push(contentEvent(options.format, sequence, options.eventBytes, sentAt));
  }
  const bytes = new TextEncoder().encode(parts.join(''));
  parts.length = 0;
  const session = new StreamSession({
    contentType: options.format === 'sse' ? 'text/event-stream' : 'application/x-ndjson',
    directive: undefined,
    spill: undefined,
    now: () => performance.now(),
    onUpdate: () => undefined,
    onText: () => undefined,
  });
  const startedAt = performance.now();
  for (let start = 0; start < bytes.length; start += options.chunkBytes) {
    session.write(bytes.subarray(start, start + options.chunkBytes));
  }
  session.end();
  const seconds = (performance.now() - startedAt) / 1000;
  session.dispose();
  return {
    format: options.format,
    events: session.store.count,
    eventBytes: options.eventBytes,
    seconds,
    eventsPerSecond: session.store.count / seconds,
  };
}
