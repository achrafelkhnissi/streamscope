import { afterEach, describe, expect, it } from 'vitest';
import { hostBudget } from '../../../src/capture/task-budget';
import {
  CaptureTracker,
  type CaptureDefinition,
  type CaptureResult,
} from '../../../src/capture/tracker';
import { parseExpression } from '../../../src/expressions/parse';
import type { RunObserver } from '../../../src/runs/observer';
import { startRun } from '../../../src/runs/run';
import { startHttpServer, type LocalServer } from '../../support/servers';
import { dependencies, runInput, useSpillArea } from '../runs/support';
import { missingWorker } from './worker';

const mebibyte = 1_048_576;
const servers: LocalServer[] = [];
useSpillArea();

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function capture(name: string, text: string): CaptureDefinition {
  const parsed = parseExpression(text, 'capture');
  if (!parsed.ok) {
    throw new Error(`${text}: ${parsed.error.message}`);
  }
  return { name, secret: false, expression: parsed.expr, text };
}

function agentStream(bytes: number): { body: string; chunks: number; events: number } {
  const started = '{"type":"RUN_STARTED","threadId":"thread-1","runId":"run-1"}';
  const finished =
    '{"type":"RUN_FINISHED","threadId":"thread-1","runId":"run-1","result":{"messageId":12345678901234567890}}';
  const lines = [started];
  let size = started.length + 1;
  let chunks = 0;
  while (size + finished.length + 1 < bytes) {
    const sequence = lines.length;
    const line =
      sequence % 4 === 0
        ? `{"type":"STATE_DELTA","delta":[{"op":"replace","path":"/step","value":${String(sequence)}}]}`
        : `{"type":"TEXT_MESSAGE_CONTENT","messageId":"msg-1","delta":"synthetic text ${String(sequence)} "}`;
    if (sequence % 4 !== 0) {
      chunks += 1;
    }
    lines.push(line);
    size += line.length + 1;
  }
  lines.push(finished);
  return { body: `${lines.join('\n')}\n`, chunks, events: lines.length };
}

const smallEventBytes = 38;

function smallEvents(bytes: number): { body: string; events: number } {
  const lines: string[] = [];
  let size = 0;
  while (size + smallEventBytes <= bytes) {
    const base = `{"type":"x","n":${String(lines.length)},"p":""}`;
    lines.push(base.replace('"p":""', `"p":"${'a'.repeat(smallEventBytes - 1 - base.length)}"`));
    size += smallEventBytes;
  }
  return { body: `${lines.join('\n')}\n`, events: lines.length };
}

interface SmallEventCapture {
  definition: CaptureDefinition;
  text: string;
}

function smallEventCapture(at: number, events: number): SmallEventCapture {
  const last = events - 1;
  const suffix = String(at);
  switch (at % 4) {
    case 0:
      return {
        definition: capture(`counted${suffix}`, 'count(type == "x")'),
        text: String(events),
      };
    case 1:
      return { definition: capture(`latest${suffix}`, 'last(type == "x").n'), text: String(last) };
    case 2:
      return {
        definition: capture(`final${suffix}`, `first(n == ${String(last)}).n`),
        text: String(last),
      };
    default:
      return {
        definition: capture(`above${suffix}`, `count(n > ${suffix})`),
        text: String(last - at),
      };
  }
}

function smallEventCaptures(count: number, events: number): SmallEventCapture[] {
  return Array.from({ length: count }, (_, at) => smallEventCapture(at, events));
}

function expectSmallEventResults(
  results: ReadonlyMap<string, CaptureResult>,
  captures: readonly SmallEventCapture[],
): void {
  for (const { definition, text } of captures) {
    expect(results.get(definition.name), definition.name).toMatchObject({
      state: 'resolved',
      text,
    });
  }
}

async function trackedRun(
  url: string,
  definitions: CaptureDefinition[],
): Promise<{ results: Map<string, CaptureResult>; events: number | undefined }> {
  const results = new Map<string, CaptureResult>();
  const tracker = new CaptureTracker(
    { id: 1, label: 'startRun' },
    definitions,
    (name, result) => {
      results.set(name, result);
    },
    missingWorker,
    hostBudget,
  );
  let ended: Promise<void> | undefined;
  const observer: RunObserver = {
    head: (head, access) => {
      tracker.head(head, access);
    },
    event: (event) => {
      tracker.event(event);
    },
    end: (end) => {
      ended = tracker.end(end);
    },
  };
  const run = startRun({ ...runInput([`GET ${url}`]), observer }, dependencies);
  const snapshot = await run.done;
  await ended;
  expect(snapshot.status).toBe('completed');
  const events = snapshot.stream?.store.count;
  await run.release();
  return { results, events };
}

describe('many cheap captures on a fast stream of small events', () => {
  it('64 captures over 16 MiB of 38-byte events resolve', async () => {
    const stream = smallEvents(16 * mebibyte);
    const server = await startHttpServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      response.end(stream.body);
    });
    servers.push(server);

    const captures = smallEventCaptures(64, stream.events);

    const { results, events } = await trackedRun(
      `${server.url}/small`,
      captures.map(({ definition }) => definition),
    );

    expect(events).toBe(stream.events);
    expectSmallEventResults(results, captures);
  }, 60_000);

  it('3 concurrent runs of 24 captures resolve', async () => {
    const stream = smallEvents(8 * mebibyte);
    const server = await startHttpServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      response.end(stream.body);
    });
    servers.push(server);

    const captures = smallEventCaptures(24, stream.events);

    const runs = await Promise.all(
      [1, 2, 3].map((at) =>
        trackedRun(
          `${server.url}/small/${String(at)}`,
          captures.map(({ definition }) => definition),
        ),
      ),
    );

    for (const { results, events } of runs) {
      expect(events).toBe(stream.events);
      expectSmallEventResults(results, captures);
    }
  }, 60_000);
});

describe('ordinary captures on a fast stream', () => {
  it.each([2, 4, 16])(
    'resolve on a %i MiB AG-UI stream sent in one write',
    async (mebibytes) => {
      const stream = agentStream(mebibytes * mebibyte);
      const server = await startHttpServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        response.end(stream.body);
      });
      servers.push(server);
      const results = new Map<string, CaptureResult>();
      const tracker = new CaptureTracker(
        { id: 1, label: 'startRun' },
        [
          capture('threadId', 'first(type == "RUN_STARTED").threadId'),
          capture('messageId', 'last(type == "RUN_FINISHED").result.messageId'),
          capture('chunks', 'count(type == "TEXT_MESSAGE_CONTENT")'),
        ],
        (name, result) => {
          results.set(name, result);
        },
        missingWorker,
        hostBudget,
      );
      let ended: Promise<void> | undefined;
      const observer: RunObserver = {
        head: (head, access) => {
          tracker.head(head, access);
        },
        event: (event) => {
          tracker.event(event);
        },
        end: (end) => {
          ended = tracker.end(end);
        },
      };

      const run = startRun({ ...runInput([`GET ${server.url}/agent`]), observer }, dependencies);
      const snapshot = await run.done;
      await ended;

      expect(snapshot.status).toBe('completed');
      expect(snapshot.stream?.store.count).toBe(stream.events);
      expect(results.get('threadId')).toMatchObject({
        state: 'resolved',
        text: 'thread-1',
        provenance: { event: 1 },
      });
      expect(results.get('messageId')).toMatchObject({
        state: 'resolved',
        text: '12345678901234567890',
        provenance: { event: stream.events },
      });
      expect(results.get('chunks')).toMatchObject({
        state: 'resolved',
        text: String(stream.chunks),
      });
      await run.release();
    },
    30_000,
  );
});
