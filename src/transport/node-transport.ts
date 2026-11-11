import { open, type FileHandle } from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import type { Socket } from 'node:net';
import type { Transform } from 'node:stream';
import { createDecoder } from './decompress';
import { classifyError } from './failures';
import { redirectStatuses, redirectTarget } from './redirects';
import type {
  BodyPart,
  Failure,
  Headers,
  Outcome,
  OutgoingRequest,
  RedirectHop,
  ResponseHead,
  ResponseSink,
  SentRequest,
  Timing,
  Transport,
  TransportOptions,
} from './model';

type Terminal =
  { kind: 'completed' } | { kind: 'failed'; failure: Failure } | { kind: 'cancelled' };
type Step = Terminal | { kind: 'redirect'; hop: RedirectHop };
type PartialTiming = Omit<Timing, 'totalMs'>;

interface Counters {
  wireBytes: number;
  decodedBytes: number;
}

interface PreparedPart {
  part: BodyPart;
  handle: FileHandle | undefined;
}

interface ExchangeResult {
  step: Step;
  timing: PartialTiming;
}

class BodyFileError extends Error {}

const acceptEncoding = 'gzip, deflate, br, zstd';

function duration(ms: number): string {
  return ms >= 1000 && ms % 1000 === 0 ? `${String(ms / 1000)} s` : `${String(ms)} ms`;
}

function failed(kind: Failure['kind'], message: string): Terminal {
  return { kind: 'failed', failure: { kind, message, code: undefined } };
}

function decompressionMessage(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `The response body could not be decompressed: ${reason}.`;
}

function hasHeader(headers: Headers, name: string): boolean {
  return headers.some(([header]) => header.toLowerCase() === name);
}

function bodyLength(parts: readonly BodyPart[]): number {
  return parts.reduce(
    (total, part) => total + (part.kind === 'bytes' ? part.bytes.length : part.size),
    0,
  );
}

function credentials(url: URL): string | undefined {
  if (url.username === '' && url.password === '') {
    return undefined;
  }
  const pair = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  return `Basic ${Buffer.from(pair).toString('base64')}`;
}

function withoutCredentials(url: URL): string {
  const copy = new URL(url.href);
  copy.username = '';
  copy.password = '';
  return copy.href;
}

function outgoingHeaders(request: OutgoingRequest): [string, string][] {
  const headers: [string, string][] = request.headers
    .filter(([name]) => name.toLowerCase() !== 'content-length')
    .map(([name, value]) => [name, value]);
  const authorization = credentials(request.url);
  if (authorization !== undefined && !hasHeader(headers, 'authorization')) {
    headers.push(['Authorization', authorization]);
  }
  if (!hasHeader(headers, 'host')) {
    headers.push(['Host', request.url.host]);
  }
  if (!hasHeader(headers, 'accept-encoding')) {
    headers.push(['Accept-Encoding', acceptEncoding]);
  }
  if (request.body.length > 0 && !hasHeader(headers, 'transfer-encoding')) {
    headers.push(['Content-Length', String(bodyLength(request.body))]);
  }
  return headers;
}

function nodeHeaders(headers: Headers): http.OutgoingHttpHeaders {
  const result: Record<string, string | string[]> = Object.create(null) as Record<
    string,
    string | string[]
  >;
  const keys = new Map<string, string>();
  for (const [name, value] of headers) {
    const key = keys.get(name.toLowerCase());
    if (key === undefined) {
      keys.set(name.toLowerCase(), name);
      result[name] = value;
    } else {
      const existing = result[key] ?? [];
      result[key] = [...(Array.isArray(existing) ? existing : [existing]), value];
    }
  }
  return result;
}

function headerPairs(rawHeaders: readonly string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    pairs.push([rawHeaders[index] ?? '', rawHeaders[index + 1] ?? '']);
  }
  return pairs;
}

function hostname(url: URL): string {
  return url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
}

function requestOptions(
  request: OutgoingRequest,
  headers: Headers,
  options: TransportOptions,
): https.RequestOptions {
  const { url } = request;
  const common: https.RequestOptions = {
    protocol: url.protocol,
    hostname: hostname(url),
    port: url.port === '' ? undefined : Number(url.port),
    path: `${url.pathname}${url.search}`,
    method: request.method.toUpperCase(),
    headers: nodeHeaders(headers),
  };
  if (url.protocol !== 'https:') {
    return common;
  }
  return {
    ...common,
    rejectUnauthorized: options.rejectUnauthorized,
    ...(options.ca === undefined ? {} : { ca: [...options.ca] }),
  };
}

function drained(request: http.ClientRequest): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      request.off('drain', done);
      request.off('close', done);
      resolve();
    };
    request.on('drain', done);
    request.on('close', done);
  });
}

async function write(request: http.ClientRequest, chunk: Uint8Array): Promise<void> {
  if (!request.write(chunk)) {
    await drained(request);
  }
}

async function writeFile(
  request: http.ClientRequest,
  part: { path: string; size: number },
  handle: FileHandle,
): Promise<void> {
  let sent = 0;
  if (part.size > 0) {
    const stream = handle.createReadStream({ start: 0, end: part.size - 1, autoClose: false });
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      if (request.destroyed) {
        return;
      }
      sent += chunk.length;
      await write(request, chunk);
    }
  }
  if (sent < part.size) {
    throw new BodyFileError(`Body file \`${part.path}\` changed while it was being sent.`);
  }
}

async function writeBody(
  request: http.ClientRequest,
  parts: readonly PreparedPart[],
): Promise<void> {
  for (const { part, handle } of parts) {
    if (request.destroyed) {
      return;
    }
    if (part.kind === 'bytes') {
      await write(request, part.bytes);
    } else if (handle) {
      await writeFile(request, part, handle);
    }
  }
  request.end();
}

async function prepareBody(
  parts: readonly BodyPart[],
): Promise<{ ok: true; parts: PreparedPart[] } | { ok: false; terminal: Terminal }> {
  const prepared: PreparedPart[] = [];
  for (const part of parts) {
    if (part.kind === 'bytes') {
      prepared.push({ part, handle: undefined });
      continue;
    }
    try {
      prepared.push({ part, handle: await open(part.path, 'r') });
    } catch (error) {
      await closeAll(prepared);
      const reason = classifyError(error, 'connect').code ?? 'unreadable';
      return {
        ok: false,
        terminal: failed('body-file', `Body file \`${part.path}\` could not be read (${reason}).`),
      };
    }
  }
  return { ok: true, parts: prepared };
}

async function closeAll(parts: readonly PreparedPart[]): Promise<void> {
  await Promise.all(parts.flatMap(({ handle }) => (handle ? [handle.close()] : [])));
}

interface ExchangeContext {
  request: OutgoingRequest;
  options: TransportOptions;
  sink: ResponseSink;
  body: readonly PreparedPart[];
  stop: AbortSignal;
  stopReason: () => Terminal;
  counters: Counters;
}

function exchange(context: ExchangeContext): Promise<ExchangeResult> {
  const { request, options, sink, body, stop, counters } = context;
  return new Promise((resolve) => {
    const marks: {
      start: number;
      lookup?: number;
      connect?: number;
      secure?: number;
      head?: number;
    } = { start: performance.now() };
    const secure = request.url.protocol === 'https:';
    const headers = outgoingHeaders(request);
    const sent: SentRequest = {
      method: request.method.toUpperCase(),
      url: withoutCredentials(request.url),
      headers,
    };
    let settled = false;
    let phase: 'connect' | 'headers' | 'body' = 'connect';
    let headersTimer: NodeJS.Timeout | undefined;
    let response: http.IncomingMessage | undefined;
    let outgoing: http.ClientRequest | undefined;
    let decoder: Transform | undefined;

    const timing = (): PartialTiming => {
      const result: PartialTiming = {};
      if (marks.lookup !== undefined) {
        result.dnsMs = marks.lookup - marks.start;
      }
      if (marks.connect !== undefined) {
        result.connectMs = marks.connect - (marks.lookup ?? marks.start);
      }
      if (marks.secure !== undefined && marks.connect !== undefined) {
        result.tlsMs = marks.secure - marks.connect;
      }
      if (marks.head !== undefined) {
        result.firstByteMs = marks.head - (marks.secure ?? marks.connect ?? marks.start);
      }
      return result;
    };

    const settle = (step: Step): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(headersTimer);
      stop.removeEventListener('abort', onStop);
      if (step.kind !== 'completed') {
        decoder?.destroy();
        response?.destroy();
        outgoing?.destroy();
      }
      resolve({ step, timing: timing() });
    };

    const onStop = (): void => {
      settle(context.stopReason());
    };

    const connectTimer = setTimeout(() => {
      settle(
        failed(
          'connect-timeout',
          `No connection to ${request.url.host} within ${duration(options.connectTimeoutMs)}. Raise streamscope.request.connectTimeout to wait longer.`,
        ),
      );
    }, options.connectTimeoutMs);

    const ready = (): void => {
      if (phase !== 'connect') {
        return;
      }
      phase = 'headers';
      clearTimeout(connectTimer);
      headersTimer = setTimeout(() => {
        settle(
          failed(
            'headers-timeout',
            `${request.url.host} sent no response within ${duration(options.headersTimeoutMs)}. Raise streamscope.request.headersTimeout to wait longer.`,
          ),
        );
      }, options.headersTimeoutMs);
    };

    if (stop.aborted) {
      settle(context.stopReason());
      return;
    }
    stop.addEventListener('abort', onStop, { once: true });

    try {
      outgoing = (secure ? https : http).request(requestOptions(request, headers, options));
    } catch (error) {
      settle({ kind: 'failed', failure: classifyError(error, 'connect') });
      return;
    }

    sink.onRequest(sent);

    outgoing.on('error', (error) => {
      settle({ kind: 'failed', failure: classifyError(error, phase) });
    });

    outgoing.on('socket', (socket: Socket) => {
      if (!socket.connecting) {
        ready();
        return;
      }
      socket.once('lookup', () => {
        marks.lookup = performance.now();
      });
      socket.once('connect', () => {
        marks.connect = performance.now();
        if (!secure) {
          ready();
        }
      });
      if (secure) {
        socket.once('secureConnect', () => {
          marks.secure = performance.now();
          ready();
        });
      }
    });

    outgoing.on('response', (incoming) => {
      response = incoming;
      phase = 'body';
      clearTimeout(headersTimer);
      marks.head = performance.now();
      const head: ResponseHead = {
        httpVersion: incoming.httpVersion,
        status: incoming.statusCode ?? 0,
        statusText: incoming.statusMessage ?? '',
        headers: headerPairs(incoming.rawHeaders),
      };
      const location = incoming.headers.location;
      if (options.followRedirects && redirectStatuses.has(head.status) && location) {
        settle({
          kind: 'redirect',
          hop: { request: sent, status: head.status, statusText: head.statusText, location },
        });
        return;
      }
      sink.onHead(head, sent);
      const deliver = (chunk: Buffer): void => {
        counters.decodedBytes += chunk.length;
        sink.onData(chunk);
      };
      const contentEncoding = head.headers
        .filter(([name]) => name.toLowerCase() === 'content-encoding')
        .map(([, value]) => value)
        .join(', ');
      let decoding = false;
      incoming.on('data', (chunk: Buffer) => {
        counters.wireBytes += chunk.length;
        if (!decoding) {
          decoding = true;
          try {
            decoder = createDecoder(contentEncoding);
          } catch (error) {
            settle(failed('decompression', decompressionMessage(error)));
            return;
          }
          decoder?.on('data', deliver);
          decoder?.on('drain', () => {
            incoming.resume();
          });
          decoder?.on('end', () => {
            settle({ kind: 'completed' });
          });
          decoder?.on('error', (error) => {
            settle(failed('decompression', decompressionMessage(error)));
          });
        }
        if (decoder) {
          if (!decoder.write(chunk)) {
            incoming.pause();
          }
        } else {
          deliver(chunk);
        }
      });
      incoming.on('end', () => {
        if (decoder) {
          decoder.end();
        } else {
          settle({ kind: 'completed' });
        }
      });
      incoming.on('error', (error) => {
        settle({ kind: 'failed', failure: classifyError(error, 'body') });
      });
      incoming.on('close', () => {
        if (!incoming.complete) {
          settle(
            failed('premature-close', 'The connection closed before the response was complete.'),
          );
        }
      });
    });

    writeBody(outgoing, body).catch((error: unknown) => {
      if (error instanceof BodyFileError) {
        settle(failed('body-file', error.message));
      }
    });
  });
}

export class NodeTransport implements Transport {
  async send(
    request: OutgoingRequest,
    options: TransportOptions,
    sink: ResponseSink,
    signal: AbortSignal,
  ): Promise<Outcome> {
    const startedAt = performance.now();
    const counters: Counters = { wireBytes: 0, decodedBytes: 0 };
    const hops: RedirectHop[] = [];
    let timing: PartialTiming = {};
    const outcome = (terminal: Terminal): Outcome => ({
      ...terminal,
      hops,
      timing: { ...timing, totalMs: performance.now() - startedAt },
      ...counters,
    });

    const prepared = await prepareBody(request.body);
    if (!prepared.ok) {
      return outcome(prepared.terminal);
    }

    const stop = new AbortController();
    let stopReason: Terminal = { kind: 'cancelled' };
    const onCancel = (): void => {
      stopReason = { kind: 'cancelled' };
      stop.abort();
    };
    signal.addEventListener('abort', onCancel, { once: true });
    const totalTimeoutMs = options.totalTimeoutMs;
    const totalTimer =
      totalTimeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            stopReason = failed(
              'total-timeout',
              `The request did not finish within its # @timeout of ${duration(totalTimeoutMs)}.`,
            );
            stop.abort();
          }, totalTimeoutMs);

    try {
      if (signal.aborted) {
        return outcome({ kind: 'cancelled' });
      }
      const handles = new Map(prepared.parts.map(({ part, handle }) => [part, handle]));
      let current = request;
      for (;;) {
        const result = await exchange({
          request: current,
          options,
          sink,
          body: current.body.map((part) => ({ part, handle: handles.get(part) })),
          stop: stop.signal,
          stopReason: () => stopReason,
          counters,
        });
        timing = result.timing;
        if (result.step.kind !== 'redirect') {
          return outcome(result.step);
        }
        if (hops.length >= options.maxRedirects) {
          return outcome(
            failed(
              'redirect',
              `The server redirected more than ${String(options.maxRedirects)} times. Raise streamscope.request.maxRedirects to follow more.`,
            ),
          );
        }
        const { hop } = result.step;
        hops.push(hop);
        const next = redirectTarget(current, hop.status, hop.location);
        if (!next.ok) {
          return outcome(failed('redirect', next.message));
        }
        current = next.request;
      }
    } finally {
      clearTimeout(totalTimer);
      signal.removeEventListener('abort', onCancel);
      await closeAll(prepared.parts);
    }
  }
}
