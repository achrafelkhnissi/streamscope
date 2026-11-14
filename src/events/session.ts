import type { FormatDecision, StreamDirective } from '../streaming/detect';
import { defaultStreamLimits, maxIndexedEvents, type StreamLimits } from '../streaming/limits';
import { parseEventBytes, StreamParser, type StreamWarning } from '../streaming/parser';
import { UpdateBatcher } from './batcher';
import type { StreamEvent } from './model';
import { ReplyAssembler } from './reply';
import type { SpillCopy, SpillFile } from './spill';
import { EventStore } from './store';

export interface EventBackpressure {
  readonly congested: boolean;
  onDrain(listener: () => void): () => void;
}

export interface StreamSessionOptions {
  contentType: string | undefined;
  directive: StreamDirective | undefined;
  spill: SpillFile | undefined;
  now: () => number;
  onUpdate: () => void;
  onText: (text: string) => void;
  onEvent?: (event: StreamEvent) => void;
  backpressure?: EventBackpressure;
  limits?: Partial<StreamLimits>;
}

export interface RawCopy {
  result: SpillCopy | 'unsaved';
  bytes: number;
}

export class StreamSession {
  readonly store: EventStore;
  readonly reply = new ReplyAssembler();
  private decision: FormatDecision | undefined;
  private readonly warningList: StreamWarning[] = [];
  private readonly parser: StreamParser;
  private readonly batcher: UpdateBatcher;
  private closed = false;
  private spillBehind = false;

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
          options.onEvent?.(event);
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
    this.spillBehind = !(this.options.spill?.append(chunk) ?? true);
    this.parser.push(chunk);
    return !this.spillBehind && this.options.backpressure?.congested !== true;
  }

  onDrain(listener: () => void): () => void {
    const { spill, backpressure } = this.options;
    const ready = (): void => {
      if (!this.spillBehind && backpressure?.congested !== true) {
        listener();
      }
    };
    const stopSpill = spill?.onDrain(() => {
      this.spillBehind = false;
      ready();
    });
    const stopConsumer = backpressure?.onDrain(ready);
    return () => {
      stopSpill?.();
      stopConsumer?.();
    };
  }

  async copyRaw(destination: string): Promise<RawCopy> {
    const spill = this.options.spill;
    if (spill === undefined) {
      return { result: 'unsaved', bytes: 0 };
    }
    const result = await spill.copyTo(destination);
    return { result, bytes: spill.savedBytes };
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
