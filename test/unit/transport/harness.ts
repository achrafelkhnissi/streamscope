import type {
  Outcome,
  OutgoingRequest,
  ResponseHead,
  ResponseSink,
  SentRequest,
  TransportOptions,
} from '../../../src/transport/model';
import { NodeTransport } from '../../../src/transport/node-transport';

export interface CollectingSink extends ResponseSink {
  head: ResponseHead | undefined;
  sent: SentRequest | undefined;
  requests: SentRequest[];
  chunks: Uint8Array[];
  body(): string;
}

export function collector(onData?: (chunk: Uint8Array) => void): CollectingSink {
  const sink: CollectingSink = {
    head: undefined,
    sent: undefined,
    requests: [],
    chunks: [],
    onRequest(sent) {
      sink.requests.push(sent);
    },
    onHead(head, sent) {
      sink.head = head;
      sink.sent = sent;
    },
    onData(chunk) {
      sink.chunks.push(chunk);
      onData?.(chunk);
    },
    body: () => Buffer.concat(sink.chunks).toString(),
  };
  return sink;
}

export const defaultOptions: TransportOptions = {
  rejectUnauthorized: true,
  ca: undefined,
  connectTimeoutMs: 5000,
  headersTimeoutMs: 5000,
  totalTimeoutMs: undefined,
  followRedirects: true,
  maxRedirects: 10,
};

export interface SendInput {
  url: string;
  method?: string;
  headers?: OutgoingRequest['headers'];
  body?: OutgoingRequest['body'];
}

export async function send(
  input: SendInput,
  options: Partial<TransportOptions> = {},
  sink: CollectingSink = collector(),
  signal: AbortSignal = new AbortController().signal,
): Promise<{ outcome: Outcome; sink: CollectingSink }> {
  const outcome = await new NodeTransport().send(
    {
      method: input.method ?? 'GET',
      url: new URL(input.url),
      headers: input.headers ?? [],
      body: input.body ?? [],
    },
    { ...defaultOptions, ...options },
    sink,
    signal,
  );
  return { outcome, sink };
}

export function bytes(text: string): { kind: 'bytes'; bytes: Uint8Array } {
  return { kind: 'bytes', bytes: Buffer.from(text) };
}

export { headerPairs } from '../../support/headers';

export async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${String(timeoutMs)} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
