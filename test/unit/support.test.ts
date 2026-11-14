import { X509Certificate } from 'node:crypto';
import * as http from 'node:http';
import * as tls from 'node:tls';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { describe, expect, it } from 'vitest';
import { startAgentServer } from '../support/agent-server';
import { createSelfSignedCertificate, derInteger } from '../support/certificate';
import { everySplit, randomSplits } from '../support/chunks';
import { startHttpServer } from '../support/servers';
import { streamFixtures } from '../support/stream-fixtures';
import { startStreamServer } from '../support/stream-server';

function get(url: string): Promise<{ contentType: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            contentType: response.headers['content-type'],
            body: Buffer.concat(chunks).toString(),
          });
        });
      })
      .on('error', reject);
  });
}

function post(url: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'POST' }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        resolve(Buffer.concat(chunks).toString());
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

interface Exchange {
  status: number | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
  complete: boolean;
  firstByteMs: number | undefined;
  elapsedMs: number;
}

function exchange(url: string, body = '{"message": "hello"}'): Promise<Exchange> {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'POST' }, (response) => {
      const chunks: Buffer[] = [];
      let firstByteMs: number | undefined;
      response.on('data', (chunk: Buffer) => {
        firstByteMs ??= performance.now() - startedAt;
        chunks.push(chunk);
      });
      response.on('error', () => undefined);
      response.on('close', () => {
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString(),
          complete: response.complete,
          firstByteMs,
          elapsedMs: performance.now() - startedAt,
        });
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

function lines(body: string): string[] {
  return body.split('\n').slice(0, -1);
}

function eventTypes(body: string): (string | undefined)[] {
  return lines(body).map((line) => {
    try {
      return (JSON.parse(line) as { type: string }).type;
    } catch {
      return undefined;
    }
  });
}

function activeTimers(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
}

describe('test support', () => {
  it('creates a certificate Node accepts', () => {
    const { cert, key } = createSelfSignedCertificate(['localhost', '127.0.0.1']);
    const certificate = new X509Certificate(cert);

    expect(certificate.subjectAltName).toBe('DNS:localhost, IP Address:127.0.0.1');
    expect(certificate.subject).toBe('CN=localhost');
    expect(certificate.ca).toBe(true);
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(() => tls.createSecureContext({ cert, key })).not.toThrow();
  });

  it('encodes DER integers without redundant leading zeros', () => {
    expect([...derInteger(Buffer.from([0x00, 0x05]))]).toEqual([0x02, 0x01, 0x05]);
    expect([...derInteger(Buffer.from([0x00, 0x00, 0x85]))]).toEqual([0x02, 0x02, 0x00, 0x85]);
    expect([...derInteger(Buffer.from([0x85]))]).toEqual([0x02, 0x02, 0x00, 0x85]);
    expect([...derInteger(Buffer.from([0x00, 0x00]))]).toEqual([0x02, 0x01, 0x00]);
  });

  it('records requests and socket lifecycle', async () => {
    const server = await startHttpServer((_request, response) => {
      response.end('done');
    });

    expect(await post(`${server.url}/items?page=2`, 'synthetic body')).toBe('done');
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.method).toBe('POST');
    expect(server.requests[0]?.url).toBe('/items?page=2');
    expect(server.requests[0]?.body.toString()).toBe('synthetic body');
    expect(server.sockets.opened).toBe(1);

    await server.close();

    expect(server.sockets.closed).toBe(server.sockets.opened);
  });

  it('splits at every boundary and reassembles the input', () => {
    const input = new Uint8Array([1, 2, 3, 4, 5]);
    const chunkings = [...everySplit(input)];

    expect(chunkings).toHaveLength(6);
    for (const chunks of chunkings) {
      expect([...Buffer.concat(chunks)]).toEqual([...input]);
    }
    expect(chunkings[0]?.map((chunk) => chunk.length)).toEqual([5]);
    expect(chunkings.slice(1, 5).map((chunks) => chunks[0]?.length)).toEqual([1, 2, 3, 4]);
    expect(chunkings[5]?.map((chunk) => chunk.length)).toEqual([1, 1, 1, 1, 1]);
  });

  it('random splits are reproducible and complete', () => {
    const input = new Uint8Array(200).map((_, index) => index);
    const first = randomSplits(input, 7, 20);
    const second = randomSplits(input, 7, 20);

    expect(first.map((chunks) => chunks.map((chunk) => chunk.length))).toEqual(
      second.map((chunks) => chunks.map((chunk) => chunk.length)),
    );
    expect(first).toHaveLength(20);
    for (const chunks of first) {
      expect([...Buffer.concat(chunks)]).toEqual([...input]);
      expect(chunks.every((chunk) => chunk.length > 0)).toBe(true);
    }
    expect(new Set(first.map((chunks) => chunks.length)).size).toBeGreaterThan(1);
  });

  it('loads every stream fixture', () => {
    const byName = new Map(streamFixtures.map((fixture) => [fixture.name, fixture]));

    expect([...byName.keys()].sort()).toEqual([
      'ag-ui.ndjson',
      'ag-ui.sse',
      'anthropic.sse',
      'edge-cases.ndjson',
      'edge-cases.sse',
      'invalid-utf8.ndjson',
      'ollama.ndjson',
      'openai-chat.sse',
      'openai-responses.sse',
    ]);
    expect(Buffer.from(byName.get('ag-ui.sse')?.bytes ?? []).toString()).toContain('\r\n');
    expect([...(byName.get('edge-cases.sse')?.bytes.subarray(0, 3) ?? [])]).toEqual([
      0xef, 0xbb, 0xbf,
    ]);
  });

  it('eventsource-parser parses the SSE fixtures', () => {
    const fixture = streamFixtures.find((candidate) => candidate.name === 'openai-chat.sse');
    const events: EventSourceMessage[] = [];
    const parser = createParser({
      onEvent: (event) => {
        events.push(event);
      },
    });

    parser.feed(new TextDecoder().decode(fixture?.bytes));
    parser.reset({ consume: true });

    expect(events).toHaveLength(4);
    expect(events.at(-1)?.data).toBe('[DONE]');
  });

  it('serves a paced synthetic AG-UI stream', async () => {
    const server = await startStreamServer();
    const startedAt = performance.now();
    const { contentType, body } = await get(`${server.url}/stream?rate=200&seconds=1&size=256`);
    const elapsed = performance.now() - startedAt;
    await server.close();
    const lines = body.split('\n').slice(0, -1);
    const events = lines.map((line) => JSON.parse(line) as { type: string; sequence?: number });
    const sequences = events.flatMap((event) =>
      event.sequence === undefined ? [] : [event.sequence],
    );

    expect(contentType).toBe('application/x-ndjson');
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(lines.length).toBeGreaterThanOrEqual(150);
    expect(lines.length).toBeLessThanOrEqual(260);
    expect(lines.every((line) => Buffer.byteLength(`${line}\n`) === 256)).toBe(true);
    expect(events[0]?.type).toBe('RUN_STARTED');
    expect(events.at(-1)?.type).toBe('RUN_FINISHED');
    expect(sequences).toEqual(sequences.map((_, index) => index + 1));
  });

  it('stamps every streamed event with the time it was sent', async () => {
    const server = await startStreamServer();
    const { body } = await get(`${server.url}/stream?rate=50&seconds=0.2&size=256`);
    await server.close();
    const events = body
      .split('\n')
      .slice(0, -1)
      .map((line) => JSON.parse(line) as { type: string; sentAt?: unknown });

    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.every((event) => typeof event.sentAt === 'number')).toBe(true);
  });

  it('answers a request whose path is not a URL with 400 instead of failing', async () => {
    const server = await startStreamServer();
    const status = await new Promise<number | undefined>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: server.port, path: '//' }, (response) => {
          response.resume();
          resolve(response.statusCode);
        })
        .on('error', reject);
    });
    const { contentType } = await get(`${server.url}/stream?rate=10&seconds=0.1`);
    await server.close();

    expect(status).toBe(400);
    expect(contentType).toBe('application/x-ndjson');
  });

  it('serves the same stream as SSE', async () => {
    const server = await startStreamServer();
    const { contentType, body } = await get(
      `${server.url}/stream?format=sse&rate=100&seconds=0.3&size=200`,
    );
    const override = await get(
      `${server.url}/stream?format=ndjson&type=application%2Fjson&rate=10&seconds=0.1`,
    );
    await server.close();
    const blocks = body.split('\n\n').slice(0, -1);

    expect(contentType).toBe('text/event-stream');
    expect(blocks.length).toBeGreaterThanOrEqual(20);
    expect(blocks.every((block) => block.startsWith('data: '))).toBe(true);
    expect(blocks.every((block) => Buffer.byteLength(`${block}\n\n`) === 200)).toBe(true);
    expect(blocks.at(-1)).toContain('RUN_FINISHED');
    expect(override.contentType).toBe('application/json');
  });

  it('serves a synthetic agent run with a fresh threadId and session headers', async () => {
    const server = await startAgentServer();
    const first = await exchange(`${server.url}/agent/run`);
    const second = await exchange(`${server.url}/agent/run`);
    await server.close();

    expect(first.status).toBe(200);
    expect(first.complete).toBe(true);
    expect(first.headers['content-type']).toBe('application/x-ndjson');
    expect(first.headers['x-session-token']).toBe('synthetic-session');
    expect(first.headers['set-cookie']).toEqual(['session=synthetic; Path=/']);
    expect(lines(first.body)).toEqual([
      '{"type":"RUN_STARTED","threadId":"synthetic-thread-1","runId":"synthetic-run-1"}',
      '{"type":"TEXT_MESSAGE_CONTENT","messageId":"synthetic-message-1","delta":"Synthetic "}',
      '{"type":"TEXT_MESSAGE_CONTENT","messageId":"synthetic-message-1","delta":"agent "}',
      '{"type":"TEXT_MESSAGE_CONTENT","messageId":"synthetic-message-1","delta":"reply."}',
      '{"type":"RUN_FINISHED","threadId":"synthetic-thread-1","runId":"synthetic-run-1","result":{"messageId":"synthetic-message-1","sequence":12345678901234567890}}',
    ]);
    expect(lines(second.body)[0]).toBe(
      '{"type":"RUN_STARTED","threadId":"synthetic-thread-2","runId":"synthetic-run-2"}',
    );
  });

  it('leaves out RUN_STARTED or RUN_FINISHED and adds one malformed line on request', async () => {
    const server = await startAgentServer();
    const withoutStart = await exchange(`${server.url}/agent/run?omit=started`);
    const withoutFinish = await exchange(`${server.url}/agent/run?omit=finished`);
    const malformed = await exchange(`${server.url}/agent/run?malformed=1`);
    await server.close();

    expect(eventTypes(withoutStart.body)).toEqual([
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_CONTENT',
      'RUN_FINISHED',
    ]);
    expect(eventTypes(withoutFinish.body)).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_CONTENT',
    ]);
    expect(eventTypes(malformed.body)).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_CONTENT',
      undefined,
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_CONTENT',
      'RUN_FINISHED',
    ]);
    expect(withoutStart.complete && withoutFinish.complete && malformed.complete).toBe(true);
  });

  it('waits delayMs before RUN_STARTED and gapMs between events', async () => {
    const server = await startAgentServer();
    const delayed = await exchange(`${server.url}/agent/run?delayMs=600`);
    const spaced = await exchange(`${server.url}/agent/run?gapMs=300`);
    await server.close();

    expect(delayed.firstByteMs).toBeGreaterThanOrEqual(550);
    expect(eventTypes(delayed.body)[0]).toBe('RUN_STARTED');
    expect(spaced.firstByteMs).toBeLessThan(spaced.elapsedMs - 1_100);
    expect(spaced.elapsedMs).toBeGreaterThanOrEqual(1_150);
    expect(eventTypes(spaced.body)).toHaveLength(5);
  });

  it('cuts the connection right after RUN_STARTED with fail=mid', async () => {
    const server = await startAgentServer();
    const cut = await exchange(`${server.url}/agent/run?fail=mid`);
    await server.close();

    expect(cut.status).toBe(200);
    expect(cut.complete).toBe(false);
    expect(eventTypes(cut.body)).toEqual(['RUN_STARTED']);
  });

  it('echoes the body of /agent/continue as JSON with every digit kept', async () => {
    const server = await startAgentServer();
    const body = '{"threadId": "synthetic-thread-1", "sequence": 12345678901234567890}';
    const echoed = await exchange(
      `${server.url}/agent/continue?sequence=12345678901234567890`,
      body,
    );
    const missing = await exchange(`${server.url}/agent/missing`);
    await server.close();

    expect(echoed.status).toBe(200);
    expect(echoed.headers['content-type']).toBe('application/json');
    expect(echoed.body).toBe(body);
    expect(server.requests[0]?.url).toBe('/agent/continue?sequence=12345678901234567890');
    expect(missing.status).toBe(404);
  });

  it('releases every socket and timer when it closes in the middle of a run', async () => {
    const before = activeTimers();
    const server = await startAgentServer();
    const openRun = (query: string): Promise<http.IncomingMessage> =>
      new Promise((resolve, reject) => {
        const request = http.request(
          `${server.url}/agent/run?${query}`,
          { method: 'POST' },
          resolve,
        );
        request.on('error', reject);
        request.end('{}');
      });
    const [delayed, spaced] = await Promise.all([openRun('delayMs=10000'), openRun('gapMs=10000')]);
    const started = new Promise<void>((resolve) => {
      spaced.once('data', () => {
        resolve();
      });
    });
    const closed = [delayed, spaced].map(
      (response) =>
        new Promise<void>((resolve) => {
          response.on('error', () => undefined);
          response.on('close', resolve);
          response.resume();
        }),
    );
    await started;
    await server.close();
    await Promise.all(closed);

    expect(server.sockets.opened).toBe(2);
    expect(server.sockets.closed).toBe(server.sockets.opened);
    expect(activeTimers()).toBe(before);
  });
});
