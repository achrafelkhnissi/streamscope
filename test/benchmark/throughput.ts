import * as path from 'node:path';
import {
  CaptureTracker,
  type CaptureDefinition,
  type CaptureResult,
} from '../../src/capture/tracker';
import { StreamSession } from '../../src/events/session';
import { parseExpression } from '../../src/expressions/parse';
import { contentEvent, type SyntheticFormat } from '../support/stream-server';

export interface ThroughputResult {
  format: SyntheticFormat;
  events: number;
  eventBytes: number;
  captures: number;
  counted?: number;
  unmatched?: number;
  seconds: number;
  eventsPerSecond: number;
}

const countName = 'counted';

function definition(name: string, text: string): CaptureDefinition {
  const parsed = parseExpression(text, 'capture');
  if (!parsed.ok) {
    throw new Error(`${text}: ${parsed.error.message}`);
  }
  return { name, secret: false, expression: parsed.expr, text };
}

function captureDefinitions(unmatched: number): CaptureDefinition[] {
  const definitions = Array.from({ length: unmatched }, (_, index) => {
    const number = String(index + 1);
    return definition(`never${number}`, `first(type == "RUN_STARTED_${number}").threadId`);
  });
  definitions.push(definition(countName, 'count(type == "TEXT_MESSAGE_CONTENT")'));
  return definitions;
}

function drained(session: StreamSession): Promise<void> {
  return new Promise((resolve) => {
    const stop = session.onDrain(() => {
      stop();
      resolve();
    });
  });
}

function captureCounts(results: ReadonlyMap<string, CaptureResult>): {
  counted: number | undefined;
  unmatched: number;
} {
  let counted: number | undefined;
  let unmatched = 0;
  for (const [name, result] of results) {
    if (name === countName) {
      counted = result.state === 'resolved' ? Number(result.text) : undefined;
    } else if (result.state === 'failed') {
      unmatched += 1;
    }
  }
  return { counted, unmatched };
}

export async function measureThroughput(options: {
  format: SyntheticFormat;
  events: number;
  eventBytes: number;
  chunkBytes: number;
  captures: number;
}): Promise<ThroughputResult> {
  const sentAt = performance.timeOrigin + performance.now();
  const parts: string[] = [];
  for (let sequence = 1; sequence <= options.events; sequence += 1) {
    parts.push(contentEvent(options.format, sequence, options.eventBytes, sentAt));
  }
  const bytes = new TextEncoder().encode(parts.join(''));
  parts.length = 0;
  const contentType = options.format === 'sse' ? 'text/event-stream' : 'application/x-ndjson';
  const signal = new AbortController().signal;
  const results = new Map<string, CaptureResult>();
  const tracker =
    options.captures === 0
      ? undefined
      : new CaptureTracker(
          { id: 1, label: 'throughput', wallStartedAt: Date.now(), sensitiveValues: [] },
          captureDefinitions(options.captures),
          (name, result) => {
            results.set(name, result);
          },
          path.resolve('dist/capture-worker.js'),
        );
  const session = new StreamSession({
    contentType,
    directive: undefined,
    spill: undefined,
    now: () => performance.now(),
    onUpdate: () => undefined,
    onText: () => undefined,
    onEvent:
      tracker === undefined
        ? undefined
        : (event) => {
            tracker.event(event);
          },
    backpressure: tracker,
  });
  tracker?.head(
    { httpVersion: '1.1', status: 200, statusText: 'OK', headers: [['content-type', contentType]] },
    { spillPath: () => Promise.resolve(undefined), signal },
  );
  const startedAt = performance.now();
  for (let start = 0; start < bytes.length; start += options.chunkBytes) {
    if (!session.write(bytes.subarray(start, start + options.chunkBytes))) {
      await drained(session);
    }
  }
  session.end();
  await tracker?.end({
    kind: 'completed',
    format: options.format,
    contentType,
    bodyLength: bytes.length,
    spillPath: () => Promise.resolve(undefined),
    reply: { recognised: false, truncated: false },
    signal,
    readBody: () => Promise.resolve(undefined),
    readReply: () => Promise.resolve(undefined),
  });
  const seconds = (performance.now() - startedAt) / 1000;
  session.dispose();
  return {
    format: options.format,
    events: session.store.count,
    eventBytes: options.eventBytes,
    captures: options.captures,
    ...(tracker === undefined ? {} : captureCounts(results)),
    seconds,
    eventsPerSecond: session.store.count / seconds,
  };
}
