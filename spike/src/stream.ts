import { StreamSession } from '../../src/events/session';
import type { SpillArea, SpillFile } from '../../src/events/spill';
import type { ResponseHead, ResponseSink, TransportOptions } from '../../src/transport/model';
import { NodeTransport } from '../../src/transport/node-transport';

export type SpikeStatus = 'connecting' | 'streaming' | 'completed' | 'failed' | 'cancelled';

const rawLimit = 2 * 1024 * 1024;

const transportOptions: TransportOptions = {
  rejectUnauthorized: true,
  ca: undefined,
  connectTimeoutMs: 10_000,
  headersTimeoutMs: 30_000,
  totalTimeoutMs: undefined,
  followRedirects: false,
  maxRedirects: 0,
};

export class SpikeStream {
  session: StreamSession | undefined;
  head: ResponseHead | undefined;
  raw = '';
  rawTrimmed = false;
  rawGeneration = 0;
  status: SpikeStatus = 'connecting';
  endedAt: number | undefined;
  readonly startedAt = performance.now();
  readonly done: Promise<SpikeStatus>;
  private readonly controller = new AbortController();
  private readonly decoder = new TextDecoder();

  private constructor(
    url: string,
    private readonly spill: SpillFile,
    onUpdate: () => void,
  ) {
    const sink: ResponseSink = {
      onRequest: () => undefined,
      onHead: (head) => {
        this.head = head;
        this.status = 'streaming';
        const contentType = head.headers.find(
          ([name]) => name.toLowerCase() === 'content-type',
        )?.[1];
        this.session = new StreamSession({
          contentType,
          directive: undefined,
          spill,
          now: () => performance.now() - this.startedAt,
          onUpdate,
          onText: () => undefined,
        });
        onUpdate();
      },
      onData: (chunk) => {
        this.appendRaw(chunk);
        this.session?.write(chunk);
      },
    };
    this.done = new NodeTransport()
      .send(
        { method: 'GET', url: new URL(url), headers: [], body: [] },
        transportOptions,
        sink,
        this.controller.signal,
      )
      .then((outcome) => {
        if (outcome.kind === 'completed') {
          this.session?.end();
        } else {
          this.session?.stop();
        }
        this.status = outcome.kind;
        this.endedAt = performance.now();
        onUpdate();
        return this.status;
      });
  }

  static async open(url: string, area: SpillArea, onUpdate: () => void): Promise<SpikeStream> {
    return new SpikeStream(url, await area.create(), onUpdate);
  }

  get running(): boolean {
    return this.status === 'connecting' || this.status === 'streaming';
  }

  get elapsedMs(): number {
    return (this.endedAt ?? performance.now()) - this.startedAt;
  }

  stop(): void {
    this.controller.abort();
  }

  async dispose(): Promise<void> {
    this.stop();
    await this.done;
    this.session?.dispose();
    await this.spill.delete();
  }

  private appendRaw(chunk: Uint8Array): void {
    this.raw += this.decoder.decode(chunk, { stream: true });
    if (this.raw.length > rawLimit) {
      const tail = this.raw.slice(this.raw.length - rawLimit / 2);
      const start = tail.indexOf('\n') + 1;
      this.raw = tail.slice(start);
      this.rawTrimmed = true;
      this.rawGeneration += 1;
    }
  }
}
