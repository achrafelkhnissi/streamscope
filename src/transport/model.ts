export type Headers = readonly (readonly [string, string])[];

export type BodyPart =
  { kind: 'bytes'; bytes: Uint8Array } | { kind: 'file'; path: string; size: number };

export interface OutgoingRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: readonly BodyPart[];
}

export interface TransportOptions {
  rejectUnauthorized: boolean;
  ca: readonly string[] | undefined;
  connectTimeoutMs: number;
  headersTimeoutMs: number;
  totalTimeoutMs: number | undefined;
  followRedirects: boolean;
  maxRedirects: number;
}

export interface SentRequest {
  method: string;
  url: string;
  headers: Headers;
}

export interface ResponseHead {
  httpVersion: string;
  status: number;
  statusText: string;
  headers: Headers;
}

export interface RedirectHop {
  request: SentRequest;
  status: number;
  statusText: string;
  location: string;
}

export interface Timing {
  dnsMs?: number;
  connectMs?: number;
  tlsMs?: number;
  firstByteMs?: number;
  totalMs: number;
}

export interface ResponseSink {
  onRequest(sent: SentRequest): void;
  onHead(head: ResponseHead, sent: SentRequest): void;
  onData(chunk: Uint8Array): void;
}

export type FailureKind =
  | 'dns'
  | 'refused'
  | 'reset'
  | 'tls'
  | 'connect-timeout'
  | 'headers-timeout'
  | 'total-timeout'
  | 'premature-close'
  | 'protocol'
  | 'decompression'
  | 'redirect'
  | 'invalid-request'
  | 'body-file';

export interface Failure {
  kind: FailureKind;
  message: string;
  code: string | undefined;
}

export interface Exchange {
  hops: RedirectHop[];
  timing: Timing;
  wireBytes: number;
  decodedBytes: number;
}

export type Outcome =
  | ({ kind: 'completed' } & Exchange)
  | ({ kind: 'failed'; failure: Failure } & Exchange)
  | ({ kind: 'cancelled' } & Exchange);

export interface Transport {
  send(
    request: OutgoingRequest,
    options: TransportOptions,
    sink: ResponseSink,
    signal: AbortSignal,
  ): Promise<Outcome>;
}
