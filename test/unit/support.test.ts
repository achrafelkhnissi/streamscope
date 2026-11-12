import { X509Certificate } from 'node:crypto';
import * as http from 'node:http';
import * as tls from 'node:tls';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { describe, expect, it } from 'vitest';
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
});
