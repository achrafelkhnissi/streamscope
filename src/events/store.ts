import { maxLabels } from '../streaming/limits';
import type { EventKind, StreamEvent } from './model';
import type { SpillFile } from './spill';

export interface EventSummary {
  index: number;
  time: number;
  offset: number;
  length: number;
  line: number;
  kind: EventKind;
  label: string | undefined;
}

export interface EventStoreOptions {
  memoryEvents: number;
  memoryBytes: number;
  spill: SpillFile | undefined;
  reparse: (bytes: Uint8Array) => Omit<StreamEvent, 'index' | 'time'> | undefined;
}

interface IndexBlock {
  time: Float64Array;
  offset: Float64Array;
  length: Uint32Array;
  line: Uint32Array;
  kind: Uint8Array;
  label: Uint16Array;
}

const blockSize = 65_536;
const kinds: readonly EventKind[] = ['json', 'text', 'malformed', 'oversize', 'comment'];
const kindCodes: ReadonlyMap<EventKind, number> = new Map(kinds.map((kind, code) => [kind, code]));

function createBlock(): IndexBlock {
  return {
    time: new Float64Array(blockSize),
    offset: new Float64Array(blockSize),
    length: new Uint32Array(blockSize),
    line: new Uint32Array(blockSize),
    kind: new Uint8Array(blockSize),
    label: new Uint16Array(blockSize),
  };
}

export class EventStore {
  private readonly blocks: IndexBlock[] = [];
  private total = 0;
  private readonly ring: (StreamEvent | undefined)[];
  private oldest = 1;
  private ringBytes = 0;
  private readonly labels: string[] = [''];
  private readonly labelIds = new Map<string, number>();

  constructor(private readonly options: EventStoreOptions) {
    this.ring = new Array<StreamEvent | undefined>(Math.max(1, options.memoryEvents));
  }

  get count(): number {
    return this.total;
  }

  append(event: StreamEvent): void {
    if (event.index !== this.total + 1) {
      throw new Error(`Event ${String(event.index)} cannot follow event ${String(this.total)}`);
    }
    this.total = event.index;
    this.record(event);
    if (this.total - this.oldest + 1 > this.ring.length) {
      this.evictOldest();
    }
    this.ring[this.slot(event.index)] = event;
    this.ringBytes += event.length;
    while (this.ringBytes > this.options.memoryBytes && this.oldest < this.total) {
      this.evictOldest();
    }
  }

  summary(index: number): EventSummary | undefined {
    if (!Number.isInteger(index) || index < 1 || index > this.total) {
      return undefined;
    }
    const block = this.blocks[Math.floor((index - 1) / blockSize)];
    if (block === undefined) {
      return undefined;
    }
    const at = (index - 1) % blockSize;
    const labelId = block.label[at] ?? 0;
    return {
      index,
      time: block.time[at] ?? 0,
      offset: block.offset[at] ?? 0,
      length: block.length[at] ?? 0,
      line: block.line[at] ?? 0,
      kind: kinds[block.kind[at] ?? 0] ?? 'json',
      label: labelId === 0 ? undefined : this.labels[labelId],
    };
  }

  inMemory(index: number): StreamEvent | undefined {
    return index >= this.oldest && index <= this.total ? this.ring[this.slot(index)] : undefined;
  }

  async read(index: number): Promise<StreamEvent | undefined> {
    const recent = this.inMemory(index);
    if (recent !== undefined) {
      return recent;
    }
    const summary = this.summary(index);
    if (summary === undefined || this.options.spill === undefined) {
      return undefined;
    }
    const bytes = await this.options.spill.read(summary.offset, summary.length);
    const parsed = bytes === undefined ? undefined : this.options.reparse(bytes);
    if (parsed === undefined) {
      return undefined;
    }
    return {
      ...parsed,
      index,
      time: summary.time,
      offset: summary.offset,
      length: summary.length,
      line: summary.line,
    };
  }

  private record(event: StreamEvent): void {
    const blockIndex = Math.floor((event.index - 1) / blockSize);
    let block = this.blocks[blockIndex];
    if (block === undefined) {
      block = createBlock();
      this.blocks.push(block);
    }
    const at = (event.index - 1) % blockSize;
    block.time[at] = event.time;
    block.offset[at] = event.offset;
    block.length[at] = event.length;
    block.line[at] = event.line;
    block.kind[at] = kindCodes.get(event.kind) ?? 0;
    block.label[at] = this.labelId(event.label);
  }

  private labelId(label: string | undefined): number {
    if (label === undefined) {
      return 0;
    }
    const known = this.labelIds.get(label);
    if (known !== undefined) {
      return known;
    }
    if (this.labels.length > maxLabels) {
      return 0;
    }
    this.labels.push(label);
    this.labelIds.set(label, this.labels.length - 1);
    return this.labels.length - 1;
  }

  private slot(index: number): number {
    return (index - 1) % this.ring.length;
  }

  private evictOldest(): void {
    const slot = this.slot(this.oldest);
    this.ringBytes -= this.ring[slot]?.length ?? 0;
    this.ring[slot] = undefined;
    this.oldest += 1;
  }
}
