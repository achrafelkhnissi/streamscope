import type { StreamEvent } from '../events/model';
import type { EventStore } from '../events/store';
import type { RunHandle, RunSnapshot } from '../runs/run';
import { classifyContentType } from '../streaming/detect';
import { renderHeadersDocument } from './headers-document';
import { capTail, eventText, isEventStream, panelStatus } from './panel-content';
import {
  panelLimits,
  type PanelBody,
  type PanelRow,
  type PanelStatus,
  type PanelView,
  type TextDelta,
  type ToPanel,
} from './panel-protocol';
import { capRows, capText, panelRow } from './panel-rows';

export const rowCacheSize = 1000;
export const readBackBytes = panelLimits.inlineEventBytes;
export const readsInFlight = 16;

const partBytes = panelLimits.messageBytes / 2;
const unavailableEvent = 'This event is no longer available.';

function readEvent(store: EventStore, index: number): Promise<StreamEvent | undefined> {
  return store.read(index).catch(() => undefined);
}

class ReadQueue {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  run<T>(task: () => Promise<T>, wanted: () => boolean): Promise<{ value: T } | undefined> {
    return new Promise((resolve, reject) => {
      this.waiting.push(() => {
        if (!wanted()) {
          resolve(undefined);
          return;
        }
        this.running += 1;
        void task()
          .then((value) => {
            resolve({ value });
          }, reject)
          .finally(() => {
            this.running -= 1;
            this.next();
          });
      });
      this.next();
    });
  }

  private next(): void {
    while (this.running < this.limit) {
      const start = this.waiting.shift();
      if (start === undefined) {
        return;
      }
      start();
    }
  }
}

export class RowCache {
  private readonly rows = new Map<number, PanelRow>();

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.rows.size;
  }

  get(index: number): PanelRow | undefined {
    const row = this.rows.get(index);
    if (row !== undefined) {
      this.rows.delete(index);
      this.rows.set(index, row);
    }
    return row;
  }

  set(row: PanelRow): void {
    this.rows.delete(row.index);
    this.rows.set(row.index, row);
    for (const oldest of this.rows.keys()) {
      if (this.rows.size <= this.capacity) {
        break;
      }
      this.rows.delete(oldest);
    }
  }
}

export interface PanelFeedOptions {
  readOnly: boolean;
  streamView: PanelView;
  post(message: ToPanel): void;
}

export type FeedRun = Pick<RunHandle, 'id' | 'snapshot'>;

function contentTypeOf(run: RunSnapshot): string | undefined {
  return run.head?.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1];
}

function labelledStream(run: RunSnapshot): boolean {
  const known = classifyContentType(contentTypeOf(run));
  return isEventStream(run) || known === 'sse' || known === 'ndjson';
}

export class PanelFeed {
  private live = false;
  private generation = 0;
  private windowRequest = 0;
  private tailRequest = 0;
  private readonly reads = new ReadQueue(readsInFlight);
  private requested: PanelView;
  private shown: PanelView;
  private picked = false;
  private acknowledged = 0;
  private following = true;
  private tail: number = panelLimits.windowRows;
  private sentTo = 0;
  private replySent: number | undefined;
  private rawSent: number | undefined;
  private lastState: RunSnapshot['status'] | undefined;
  private headers = '';
  private bodyState: PanelBody;
  private bodyChanged = false;
  private expanding: number | undefined;
  private readonly rows = new RowCache(rowCacheSize);

  constructor(
    readonly run: FeedRun,
    private readonly options: PanelFeedOptions,
  ) {
    const snapshot = run.snapshot();
    this.requested = labelledStream(snapshot) ? options.streamView : 'body';
    this.shown = this.requested;
    this.bodyState = isEventStream(snapshot) ? { kind: 'stream' } : { kind: 'none' };
  }

  get view(): PanelView {
    return this.shown;
  }

  get rendered(): number {
    return this.acknowledged;
  }

  get body(): PanelBody {
    return this.bodyState;
  }

  get count(): number {
    return this.run.snapshot().stream?.store.count ?? 0;
  }

  get stream(): boolean {
    return labelledStream(this.run.snapshot());
  }

  start(): void {
    this.live = true;
    this.generation += 1;
    this.acknowledged = 0;
    this.following = true;
    this.tail = panelLimits.windowRows;
    this.sentTo = 0;
    this.replySent = undefined;
    this.rawSent = undefined;
    const snapshot = this.run.snapshot();
    const status = panelStatus(snapshot);
    this.shown = this.viewFor(snapshot, status);
    this.lastState = snapshot.status;
    this.headers = renderHeadersDocument(snapshot);
    this.syncBody(snapshot);
    this.bodyChanged = false;
    this.options.post({
      type: 'reset',
      run: this.run.id,
      view: this.shown,
      readOnly: this.options.readOnly,
      status,
      headers: this.headers,
      body: this.bodyState,
    });
    this.refresh();
    if (this.expanding !== undefined) {
      this.options.post({ type: 'expand', index: this.expanding });
      this.expanding = undefined;
    }
  }

  pause(): void {
    this.live = false;
    this.generation += 1;
  }

  refresh(announce = false): void {
    if (!this.live) {
      return;
    }
    const snapshot = this.run.snapshot();
    const status = panelStatus(snapshot);
    const next = this.viewFor(snapshot, status);
    const switched = next !== this.shown;
    this.shown = next;
    let headers: string | undefined;
    if (snapshot.status !== this.lastState) {
      this.lastState = snapshot.status;
      const text = renderHeadersDocument(snapshot);
      if (text !== this.headers) {
        this.headers = text;
        headers = text;
      }
    }
    this.syncBody(snapshot);
    const body = this.bodyChanged ? this.bodyState : undefined;
    this.bodyChanged = false;
    this.options.post({
      type: 'update',
      run: this.run.id,
      status,
      count: snapshot.stream?.store.count ?? 0,
      rows: this.following ? this.tailRows(snapshot) : [],
      reply: next === 'reply' ? this.replyDelta(snapshot) : undefined,
      raw: next === 'raw' ? this.rawDelta(snapshot) : undefined,
      body,
      headers,
    });
    if (switched || announce) {
      this.options.post({ type: 'select', view: next });
    }
  }

  setBody(body: PanelBody): void {
    this.bodyState = body;
    this.bodyChanged = true;
    this.refresh();
  }

  pick(view: PanelView): void {
    this.picked = true;
    this.requested = view;
    this.shown = view;
    this.refresh();
  }

  select(view: PanelView): void {
    this.picked = true;
    this.requested = view;
    this.refresh(true);
  }

  expand(index: number): void {
    this.picked = true;
    this.requested = 'events';
    if (!this.live) {
      this.expanding = index;
      return;
    }
    this.refresh();
    this.options.post({ type: 'expand', index });
  }

  acknowledge(newest: number): void {
    this.acknowledged = Math.max(this.acknowledged, newest);
  }

  async window(start: number, end: number, following: boolean): Promise<void> {
    if (!this.live) {
      return;
    }
    this.following = following;
    this.windowRequest += 1;
    if (following) {
      this.tail = end - start + 1;
      this.sentTo = Math.max(0, this.count - this.tail);
      this.refresh();
      return;
    }
    const generation = this.generation;
    const request = this.windowRequest;
    const wanted = (): boolean => generation === this.generation && request === this.windowRequest;
    const store = this.run.snapshot().stream?.store;
    if (store === undefined) {
      return;
    }
    const reads: Promise<PanelRow>[] = [];
    for (let index = start; index <= end; index += 1) {
      reads.push(this.readRow(store, index, wanted));
    }
    const rows = await Promise.all(reads);
    if (wanted()) {
      this.options.post({ type: 'rows', run: this.run.id, rows: capRows(rows, partBytes) });
    }
  }

  async detail(index: number): Promise<void> {
    if (!this.live) {
      return;
    }
    const generation = this.generation;
    const store = this.run.snapshot().stream?.store;
    const event = store === undefined ? undefined : await readEvent(store, index);
    if (generation !== this.generation) {
      return;
    }
    const shown =
      event === undefined
        ? { text: unavailableEvent, truncated: false }
        : eventText(event, panelLimits.inlineEventBytes);
    const capped = capText(shown.text, panelLimits.inlineEventBytes);
    this.options.post({
      type: 'detail',
      run: this.run.id,
      index,
      text: capped.text,
      truncated: shown.truncated || capped.cut,
    });
  }

  private viewFor(snapshot: RunSnapshot, status: PanelStatus): PanelView {
    if (!this.picked && this.requested === 'body' && isEventStream(snapshot)) {
      this.requested = this.options.streamView;
    }
    return this.requested === 'reply' && !status.reply ? 'events' : this.requested;
  }

  private syncBody(snapshot: RunSnapshot): void {
    if (isEventStream(snapshot) && this.bodyState.kind !== 'stream') {
      this.bodyState = { kind: 'stream' };
      this.bodyChanged = true;
    }
  }

  private tailRows(snapshot: RunSnapshot): PanelRow[] {
    const store = snapshot.stream?.store;
    if (store === undefined) {
      return [];
    }
    const count = store.count;
    const from = Math.max(
      this.sentTo + 1,
      count - this.tail + 1,
      count - panelLimits.rowsPerMessage + 1,
      1,
    );
    this.sentTo = Math.max(this.sentTo, count);
    const rows: PanelRow[] = [];
    const missing: number[] = [];
    for (let index = from; index <= count; index += 1) {
      const known = this.knownRow(store, index);
      if (known === undefined) {
        missing.push(index);
        rows.push(panelRow(store, index, undefined));
      } else {
        rows.push(known);
      }
    }
    if (missing.length > 0) {
      void this.readBack(store, missing);
    }
    return capRows(rows, partBytes);
  }

  private knownRow(store: EventStore, index: number): PanelRow | undefined {
    const cached = this.rows.get(index);
    if (cached !== undefined) {
      return cached;
    }
    const event = store.inMemory(index);
    const length = store.summary(index)?.length;
    if (event === undefined && length !== undefined && length <= readBackBytes) {
      return undefined;
    }
    const row = panelRow(store, index, event);
    this.rows.set(row);
    return row;
  }

  private async readBack(store: EventStore, indexes: readonly number[]): Promise<void> {
    this.tailRequest += 1;
    const generation = this.generation;
    const request = this.tailRequest;
    const wanted = (): boolean => generation === this.generation && request === this.tailRequest;
    const rows = await Promise.all(indexes.map((index) => this.readRow(store, index, wanted)));
    if (wanted()) {
      this.options.post({ type: 'rows', run: this.run.id, rows: capRows(rows, partBytes) });
    }
  }

  private async readRow(
    store: EventStore,
    index: number,
    wanted: () => boolean,
  ): Promise<PanelRow> {
    const known = this.knownRow(store, index);
    if (known !== undefined) {
      return known;
    }
    const read = await this.reads.run(() => readEvent(store, index), wanted);
    if (read === undefined) {
      return panelRow(store, index, undefined);
    }
    const row = panelRow(store, index, read.value);
    this.rows.set(row);
    return row;
  }

  private replyDelta(snapshot: RunSnapshot): TextDelta | undefined {
    const reply = snapshot.stream?.reply;
    if (reply === undefined || reply.size === this.replySent) {
      return undefined;
    }
    const reset = this.replySent === undefined;
    const text = reply.since(this.replySent ?? 0);
    this.replySent = reply.size;
    const capped = capTail(text, partBytes);
    return { reset: reset || capped.cut, text: capped.text };
  }

  private rawDelta(snapshot: RunSnapshot): TextDelta | undefined {
    const raw = snapshot.raw;
    if (raw.total === this.rawSent) {
      return undefined;
    }
    const added = this.rawSent === undefined ? undefined : raw.since(this.rawSent);
    this.rawSent = raw.total;
    const capped = capTail(added ?? raw.text, partBytes);
    return { reset: added === undefined || capped.cut, text: capped.text };
  }
}
