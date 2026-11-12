import type { FormatDecision, StreamDirective } from '../streaming/detect';
import { defaultStreamLimits, maxIndexedEvents, type StreamLimits } from '../streaming/limits';
import { parseEventBytes, StreamParser, type StreamWarning } from '../streaming/parser';
import { UpdateBatcher } from './batcher';
import { ReplyAssembler } from './reply';
import type { SpillFile } from './spill';
import { EventStore } from './store';

export interface StreamSessionOptions {
  contentType: string | undefined;
  directive: StreamDirective | undefined;
  spill: SpillFile | undefined;
  now: () => number;
  onUpdate: () => void;
  onText: (text: string) => void;
  limits?: Partial<StreamLimits>;
}

export class StreamSession {
  readonly store: EventStore;
  readonly reply = new ReplyAssembler();
  private decision: FormatDecision | undefined;
  private readonly warningList: StreamWarning[] = [];
  private readonly parser: StreamParser;
  private readonly batcher: UpdateBatcher;
  private closed = false;

  constructor(private readonly options: StreamSessionOptions) {
    const limits: StreamLimits = { ...defaultStreamLimits, ...options.limits };
    this.store = new EventStore({
      memoryEvents: limits.memoryEvents,
      memoryBytes: limits.memoryBytes,
      maxIndexedEvents,
      spill: options.spill,
      reparse: (bytes) => {
        const format = this.decision?.format;
        return format === 'sse' || format === 'ndjson'
          ? parseEventBytes(bytes, format, {
              maxEventSize: limits.maxEventSize,
              typeFields: limits.typeFields,
            })
          : undefined;
      },
    });
    this.batcher = new UpdateBatcher(options.onUpdate, {
      intervalMs: limits.batchIntervalMs,
      now: options.now,
    });
    this.parser = new StreamParser(
      {
        contentType: options.contentType,
        directive: options.directive,
        maxEventSize: limits.maxEventSize,
        typeFields: limits.typeFields,
        now: options.now,
      },
      {
        format: (decision) => {
          this.decision = decision;
          this.batcher.schedule();
        },
        event: (event) => {
          this.store.append(event);
          this.reply.push(event, this.decision?.format ?? 'text');
          this.batcher.schedule();
        },
        text: (text) => {
          options.onText(text);
          this.batcher.schedule();
        },
        warning: (warning) => {
          this.warningList.push(warning);
          this.batcher.schedule();
        },
      },
    );
  }

  get format(): FormatDecision | undefined {
    return this.decision;
  }

  get warnings(): readonly StreamWarning[] {
    return this.warningList;
  }

  write(chunk: Uint8Array): boolean {
    if (this.closed) {
      return true;
    }
    const accepted = this.options.spill?.append(chunk) ?? true;
    this.parser.push(chunk);
    return accepted;
  }

  onDrain(listener: () => void): () => void {
    return this.options.spill?.onDrain(listener) ?? (() => undefined);
  }

  end(): void {
    if (this.close()) {
      this.parser.end();
      this.batcher.flushNow();
    }
  }

  stop(): void {
    if (this.close()) {
      this.parser.stop();
      this.batcher.flushNow();
    }
  }

  dispose(): void {
    this.batcher.dispose();
    if (this.close()) {
      this.parser.stop();
    }
  }

  private close(): boolean {
    if (this.closed) {
      return false;
    }
    this.closed = true;
    void this.options.spill?.finish();
    return true;
  }
}
