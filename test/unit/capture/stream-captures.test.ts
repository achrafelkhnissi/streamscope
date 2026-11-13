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
