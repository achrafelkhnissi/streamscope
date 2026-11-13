import type { StreamEvent } from '../events/model';
import type { EventBackpressure } from '../events/session';
import type { StreamFormat } from '../streaming/detect';
import type { ResponseHead } from '../transport/model';

export type RunEnd =
  | {
      kind: 'completed';
      format: StreamFormat | undefined;
      contentType: string | undefined;
      bodyLength: number;
      spillPath: (end: number) => Promise<string | undefined>;
      reply: { recognised: boolean; truncated: boolean };
      signal: AbortSignal;
      readBody: (maxBytes: number) => Promise<Uint8Array | undefined>;
      readReply: () => Promise<string | undefined>;
    }
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' }
  | { kind: 'blocked'; message: string };

export interface RunAccess {
  spillPath: (end: number) => Promise<string | undefined>;
  signal: AbortSignal;
}

export interface RunObserver {
  head(head: ResponseHead, access: RunAccess): void;
  event(event: StreamEvent): void;
  end(end: RunEnd): void;
  backpressure?: EventBackpressure;
}
