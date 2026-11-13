import type { StreamEvent } from '../events/model';
import type { Expr, SourceNode, Value } from '../expressions/ast';
import { holds, type ConditionItem, type Outcome } from '../expressions/evaluate';
import { sourcesOf } from '../expressions/parse';
import { unitsPerCheck, type WorkBudget } from '../expressions/work';
import {
  isSensitiveHeader,
  maskValues,
  sensitiveHeaderValues,
  sensitiveValuesIn,
} from '../masking/masking';
import type { RunAccess, RunEnd } from '../runs/observer';
import type { ResponseHead } from '../transport/model';
import {
  evaluateJobs,
  evaluateWith,
  fileBodyBytes,
  inlineBodyBytes,
  inserted,
  sourceKey,
  type BodyJob,
  type BodySubject,
  type Collected,
  type Inserted,
} from './body';
import {
  bodyNotSentReason,
  bodyUnavailableReason,
  cancelledReason,
  evaluationCancelledReason,
  eventsUnavailableReason,
  eventStreamBodyReason,
  eventUnavailableReason,
  failedReason,
  maxCollectedBytes,
  maxCollectedEvents,
  maxSentValueBytes,
  noEventMatchedReason,
  noHeadersReason,
  noReplyReason,
  notAnEventStreamReason,
  notSentReason,
  replyCutOffReason,
  replyUnavailableReason,
  responsePendingReason,
  tooFewMatchedReason,
  tooManyMatchBytesReason,
  tooManyMatchesReason,
  tooManyStreamBytesReason,
  tooManyStreamEventsReason,
  unexpectedReason,
  type EventCounts,
} from './messages';
import { hostBudget, type TaskBudget } from './task-budget';

export interface CaptureDefinition {
  name: string;
  secret: boolean;
  expression: Expr;
  text: string;
}

export interface Provenance {
  runId: number;
  event: number | undefined;
  path: string;
  time: number;
}

export type CaptureResult =
  | { state: 'pending' }
  | {
      state: 'resolved';
      text: string;
      secret: boolean;
      sensitive: readonly string[];
      provenance: Provenance;
    }
  | { state: 'failed'; reason: string };

type EventNode = Extract<SourceNode, { kind: 'events' | 'nth' }>;
type HeadNode = Extract<SourceNode, { kind: 'source' }> & { name: keyof HeadValues };

interface Match {
  index: number;
  time: number;
  value: Value | undefined;
  offset: number;
  length: number;
  format: 'sse' | 'ndjson';
}

type Watch =
  | {
      kind: 'first' | 'last';
      node: EventNode;
      condition: Expr | undefined;
      match: Match | undefined;
    }
  | {
      kind: 'nth';
      node: EventNode;
      condition: Expr | undefined;
      position: number;
      seen: number;
      match: Match | undefined;
    }
  | { kind: 'count'; node: EventNode; condition: Expr | undefined; count: number }
  | { kind: 'all'; node: EventNode; condition: Expr | undefined; matches: Matches };

type Timing = 'head' | 'event' | 'end';

interface Matches {
  ranges: number[];
  values: Value[];
}

interface Budget {
  events: number;
  bytes: number;
  end: number;
  values: boolean;
}

interface Tracked {
  readonly definition: CaptureDefinition;
  readonly sources: readonly SourceNode[];
  readonly timing: Timing;
  readonly queries: boolean;
  readonly budget: Budget;
  watches: Watch[];
  settled: boolean;
  inFlight: boolean;
}

interface Collection {
  matches: Matches;
  budget: Budget;
}

export interface HeadValues {
  status: Value;
  headers: Value;
  cookies: Value;
}

interface Phase {
  events: 'unknown' | 'streamed' | 'none';
  reply: Outcome | undefined;
  body: Outcome | undefined;
}

type TrackedJob = BodyJob & { tracked: Tracked };

export const congestedEvents = 5_000;
export const congestedBytes = 8_388_608;
export const drainedEvents = 1_000;
export const drainedBytes = 2_097_152;
const compactQueueAt = 1_024;

interface Resumed {
  readonly resumed: StreamEvent;
  readonly captures: readonly Tracked[];
  readonly inlineBytes: number;
}

type Queued = StreamEvent | Resumed;

function queuedEvent(entry: Queued): StreamEvent {
  return 'resumed' in entry ? entry.resumed : entry;
}
type CompletedEnd = Extract<RunEnd, { kind: 'completed' }>;

const headPhase: Phase = { events: 'unknown', reply: undefined, body: undefined };
const eventPhase: Phase = {
  events: 'streamed',
  reply: undefined,
  body: { present: false, reason: eventStreamBodyReason },
};
const notEnded: Outcome = { present: false, reason: responsePendingReason };

function isEventNode(node: SourceNode): node is EventNode {
  return node.kind === 'events' || node.kind === 'nth';
}

function isHeadNode(node: SourceNode): node is HeadNode {
  return (
    node.kind === 'source' &&
    (node.name === 'status' || node.name === 'headers' || node.name === 'cookies')
  );
}

function timingOf(sources: readonly SourceNode[]): Timing {
  let resolving = 0;
  for (const node of sources) {
    if (isHeadNode(node)) {
      continue;
    }
    if (node.kind === 'nth' || (node.kind === 'events' && node.name === 'first')) {
      resolving += 1;
      continue;
    }
    return 'end';
  }
  if (resolving === 0) {
    return 'head';
  }
  return resolving === 1 ? 'event' : 'end';
}

function watchOf(node: EventNode): Watch {
  const { condition } = node;
  if (node.kind === 'nth') {
    return { kind: 'nth', node, condition, position: node.position, seen: 0, match: undefined };
  }
  switch (node.name) {
    case 'first':
    case 'last':
      return { kind: node.name, node, condition, match: undefined };
    case 'count':
      return { kind: 'count', node, condition, count: 0 };
    case 'all':
      return { kind: 'all', node, condition, matches: { ranges: [], values: [] } };
  }
}

export function readsSensitiveHead(expression: Expr): boolean {
  const pending: Expr[] = [expression];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    switch (node.kind) {
      case 'source':
        if (node.name === 'cookies') {
          return true;
        }
        break;
      case 'access':
        if (
          node.target.kind === 'source' &&
          node.target.name === 'headers' &&
          node.step.kind === 'name' &&
          isSensitiveHeader(node.step.name)
        ) {
          return true;
        }
        pending.push(node.target);
        break;
      case 'filter':
        pending.push(node.target);
        break;
      case 'check':
        pending.push(...node.args);
        break;
      case 'list':
        pending.push(...node.items);
        break;
      case 'not':
        pending.push(node.operand);
        break;
      case 'logical':
      case 'compare':
        pending.push(node.left, node.right);
        break;
      case 'events':
      case 'nth':
      case 'jsonpath':
      case 'literal':
      case 'regex':
      case 'field':
      case 'item':
      case 'sse':
        break;
    }
  }
  return false;
}

export function headValues(head: ResponseHead): HeadValues {
  const headers = new Map<string, string>();
  const cookies = new Map<string, string>();
  for (const [name, value] of head.headers) {
    const key = name.toLowerCase();
    const earlier = headers.get(key);
    headers.set(key, earlier === undefined ? value : `${earlier}, ${value}`);
    if (key !== 'set-cookie') {
      continue;
    }
    const pair = value.split(';', 1)[0] ?? '';
    const equals = pair.indexOf('=');
    const cookie = equals === -1 ? '' : pair.slice(0, equals).trim();
    if (cookie !== '') {
      cookies.set(cookie, pair.slice(equals + 1).trim());
    }
  }
  return {
    status: head.status,
    headers: Object.fromEntries(headers),
    cookies: Object.fromEntries(cookies),
  };
}

function matchOf(event: StreamEvent): Match {
  return {
    index: event.index,
    time: event.time,
    value: event.length > maxSentValueBytes ? undefined : event.value,
    offset: event.offset,
    length: event.length,
    format: event.sse === undefined ? 'ndjson' : 'sse',
  };
}

function matchedWatch(watch: Watch): Match | undefined {
  return watch.kind === 'all' || watch.kind === 'count' ? undefined : watch.match;
}

function furthest(tracked: Tracked): number {
  let end = tracked.budget.end;
  for (const watch of tracked.watches) {
    const match = matchedWatch(watch);
    if (match !== undefined && match.length > inlineBodyBytes) {
      end = Math.max(end, match.offset + match.length);
    }
  }
  return end;
}

function matchedNow(tracked: Tracked): boolean {
  const [watch] = tracked.watches;
  return (
    tracked.timing === 'event' &&
    (watch?.kind === 'first' || watch?.kind === 'nth') &&
    watch.match !== undefined
  );
}

function readsSource(tracked: Tracked, name: 'body' | 'text'): boolean {
  return tracked.sources.some((node) => node.kind === 'source' && node.name === name);
}

function allWatches(tracked: Tracked): Extract<Watch, { kind: 'all' }>[] {
  return tracked.watches.filter((watch) => watch.kind === 'all');
}

function newBudget(): Budget {
  return { events: 0, bytes: 0, end: 0, values: true };
}

function collect(
  matches: Matches,
  budget: Budget,
  event: StreamEvent,
  dropValues: () => void,
): 'events' | 'bytes' | undefined {
  if (budget.events === maxCollectedEvents) {
    return 'events';
  }
  if (budget.bytes + event.length > maxCollectedBytes) {
    return 'bytes';
  }
  budget.events += 1;
  budget.bytes += event.length;
  budget.end = event.offset + event.length;
  matches.ranges.push(event.offset, event.length);
  if (budget.values && budget.bytes > maxSentValueBytes) {
    budget.values = false;
    dropValues();
  } else if (budget.values) {
    matches.values.push(event.value);
  }
  return undefined;
}

async function bodySubject(end: CompletedEnd): Promise<BodySubject | string> {
  if (end.bodyLength > fileBodyBytes) {
    const path = await end.spillPath(end.bodyLength).catch(() => undefined);
    return path === undefined
      ? bodyNotSentReason
      : { kind: 'file', path, length: end.bodyLength, contentType: end.contentType };
  }
  const bytes = await end.readBody(Number.MAX_SAFE_INTEGER).catch(() => undefined);
  return bytes === undefined
    ? bodyUnavailableReason
    : { kind: 'body', bytes, contentType: end.contentType };
}

async function replyOutcome(end: CompletedEnd): Promise<Outcome> {
  if (!end.reply.recognised) {
    return { present: false, reason: noReplyReason };
  }
  if (end.reply.truncated) {
    return { present: false, reason: replyCutOffReason };
  }
  const reply = await end.readReply().catch(() => undefined);
  return reply === undefined
    ? { present: false, reason: replyUnavailableReason }
    : { present: true, value: reply, path: '' };
}

export class CaptureTracker {
  private readonly tracked: readonly Tracked[];
  private watching: Tracked[];
  private query: Collection | undefined;
  private sentBytes = 0;
  private readonly counts: EventCounts = { events: 0, malformed: 0, oversize: 0 };
  private response: HeadValues | undefined;
  private access: RunAccess | undefined;
  private readonly inFlight: Promise<void>[] = [];
  private ending: Promise<void> | undefined;
  private queue: (Queued | undefined)[] = [];
  private queueStart = 0;
  private queuedBytes = 0;
  private draining = false;
  private backlogged = false;
  private dropped = false;
  private idle: (() => void) | undefined;
  private readonly drainListeners = new Set<() => void>();
  private sensitive: readonly string[];

  constructor(
    private readonly run: {
      id: number;
      label: string;
      wallStartedAt: number;
      sensitiveValues: readonly string[];
    },
    definitions: readonly CaptureDefinition[],
    private readonly onResult: (name: string, result: CaptureResult) => void,
    private readonly workerFile: string,
    private readonly budget: TaskBudget = hostBudget,
  ) {
    this.tracked = definitions.map((definition) => {
      const sources = sourcesOf(definition.expression);
      return {
        definition,
        sources,
        timing: timingOf(sources),
        queries: sources.some((node) => node.kind === 'jsonpath'),
        budget: newBudget(),
        watches: sources.filter(isEventNode).map(watchOf),
        settled: false,
        inFlight: false,
      };
    });
    this.watching = this.tracked.filter((tracked) => tracked.watches.length > 0);
    this.query = this.tracked.some((tracked) => tracked.queries)
      ? { matches: { ranges: [], values: [] }, budget: newBudget() }
      : undefined;
    this.sensitive = run.sensitiveValues;
  }

  get retainedValues(): number {
    let retained = this.query?.matches.values.length ?? 0;
    for (const tracked of this.tracked) {
      for (const watch of allWatches(tracked)) {
        retained += watch.matches.values.length;
      }
    }
    return retained;
  }

  get retainedRanges(): number {
    let retained = this.query?.matches.ranges.length ?? 0;
    for (const tracked of this.tracked) {
      for (const watch of allWatches(tracked)) {
        retained += watch.matches.ranges.length;
      }
    }
    return retained / 2;
  }

  get queued(): number {
    return this.queue.length - this.queueStart;
  }

  get congested(): boolean {
    return this.queued > congestedEvents || this.queuedBytes > congestedBytes;
  }

  onDrain(listener: () => void): () => void {
    this.drainListeners.add(listener);
    return () => {
      this.drainListeners.delete(listener);
    };
  }

  head(head: ResponseHead, access?: RunAccess): void {
    this.response = headValues(head);
    this.sensitive = [...this.run.sensitiveValues, ...sensitiveHeaderValues(head.headers)];
    this.access = access;
    for (const tracked of this.tracked) {
      if (!tracked.settled && tracked.timing === 'head') {
        const result = this.evaluateNow(tracked, headPhase, this.budget.enter());
        this.budget.leave();
        this.settle(tracked, result);
      }
    }
  }

  event(event: StreamEvent): void {
    if (this.access?.signal.aborted === true) {
      this.dropQueue(true);
      return;
    }
    this.counts.events += 1;
    if (event.kind === 'malformed') {
      this.counts.malformed += 1;
    } else if (event.kind === 'oversize') {
      this.counts.oversize += 1;
    }
    if (event.kind !== 'json' && event.kind !== 'text') {
      return;
    }
    if (this.collectQuery(event)) {
      this.watching = this.watching.filter((tracked) => !tracked.settled && !tracked.inFlight);
    }
    if (this.watching.length === 0) {
      return;
    }
    if (this.queued > 0 || !this.budget.hasRoom) {
      this.enqueue(event);
      return;
    }
    this.process(event, this.watching, 0);
  }

  end(end: RunEnd): Promise<void> {
    this.ending ??= this.drained(end)
      .then(() => this.finish(end))
      .catch((error: unknown) => {
        const reason = unexpectedReason(error);
        for (const tracked of this.tracked) {
          if (!tracked.settled) {
            this.fail(tracked, reason);
          }
        }
      });
    return this.ending;
  }

  private process(event: StreamEvent, captures: readonly Tracked[], inlineStart: number): void {
    const item: ConditionItem = { value: event.value, sse: event.sse, malformed: false };
    const budget = this.budget.enter();
    let changed = false;
    let inlineBytes = inlineStart;
    const away: Tracked[] = [];
    let settled: [Tracked, Inserted][] | undefined;
    let position = 0;
    for (const tracked of captures) {
      position += 1;
      if (tracked.settled) {
        continue;
      }
      budget.restart();
      const overflow = this.observe(tracked, event, item, budget);
      if (overflow !== undefined) {
        (settled ??= []).push([tracked, { present: false, reason: overflow }]);
        changed = true;
      } else if (matchedNow(tracked)) {
        changed = true;
        if (event.length > inlineBodyBytes || inlineBytes + event.length > inlineBodyBytes) {
          away.push(tracked);
        } else {
          inlineBytes += event.length;
          (settled ??= []).push([tracked, this.evaluateNow(tracked, eventPhase, budget)]);
        }
      }
      if (budget.spent >= unitsPerCheck && position < captures.length && !this.budget.roomLeft()) {
        this.resume({ resumed: event, captures: captures.slice(position), inlineBytes });
        break;
      }
    }
    this.budget.leave();
    for (const [tracked, result] of settled ?? []) {
      this.settle(tracked, result);
    }
    if (away.length > 0) {
      this.evaluateLater(away, matchOf(event));
    }
    if (changed) {
      this.watching = this.watching.filter((tracked) => !tracked.settled && !tracked.inFlight);
    }
  }

  private resume(entry: Resumed): void {
    if (this.queueStart > 0) {
      this.queueStart -= 1;
      this.queue[this.queueStart] = entry;
    } else {
      this.queue.unshift(entry);
    }
    this.queuedBytes += entry.resumed.length;
    this.backlogged ||= this.congested;
    this.scheduleDrain();
  }

  private enqueue(event: StreamEvent): void {
    this.queue.push(event);
    this.queuedBytes += event.length;
    this.backlogged ||= this.congested;
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (!this.draining) {
      this.draining = true;
      this.budget.requestTurn(() => {
        this.drain();
      });
    }
  }

  private dequeue(): Queued | undefined {
    const entry = this.queue[this.queueStart];
    if (entry === undefined) {
      return undefined;
    }
    this.queue[this.queueStart] = undefined;
    this.queueStart += 1;
    this.queuedBytes -= queuedEvent(entry).length;
    if (this.queueStart === this.queue.length) {
      this.queue = [];
      this.queueStart = 0;
    } else if (this.queueStart >= compactQueueAt && this.queueStart * 2 >= this.queue.length) {
      this.queue = this.queue.slice(this.queueStart);
      this.queueStart = 0;
    }
    return entry;
  }

  private drain(): void {
    this.draining = false;
    if (this.access?.signal.aborted === true) {
      this.dropQueue(true);
      return;
    }
    while (this.watching.length > 0 && this.budget.hasRoom) {
      const next = this.dequeue();
      if (next === undefined) {
        break;
      }
      if ('resumed' in next) {
        this.process(next.resumed, next.captures, next.inlineBytes);
      } else {
        this.process(next, this.watching, 0);
      }
    }
    if (this.watching.length === 0) {
      this.dropQueue(false);
      return;
    }
    if (this.queued > 0) {
      this.scheduleDrain();
    }
    this.queueChanged();
  }

  private dropQueue(aborted: boolean): void {
    this.queue = [];
    this.queueStart = 0;
    this.queuedBytes = 0;
    this.dropped ||= aborted;
    this.queueChanged();
  }

  private queueChanged(): void {
    if (this.queued === 0) {
      const idle = this.idle;
      this.idle = undefined;
      idle?.();
    }
    if (this.backlogged && this.queued < drainedEvents && this.queuedBytes < drainedBytes) {
      this.backlogged = false;
      for (const listener of [...this.drainListeners]) {
        listener();
      }
    }
  }

  private drained(end: RunEnd): Promise<void> {
    if (end.kind !== 'completed') {
      this.dropQueue(false);
    }
    return this.queued === 0
      ? Promise.resolve()
      : new Promise((resolve) => {
          this.idle = resolve;
        });
  }

  private evaluateLater(batch: readonly Tracked[], match: Match): void {
    for (const tracked of batch) {
      tracked.inFlight = true;
    }
    const work = async (): Promise<void> => {
      const path = await this.access?.spillPath(match.offset + match.length).catch(() => undefined);
      const subject: BodySubject = { kind: 'events', format: match.format, path, query: undefined };
      const jobs: TrackedJob[] = [];
      for (const tracked of batch) {
        const job = this.job(tracked, { subject, phase: eventPhase, path }, true);
        if (typeof job === 'string') {
          this.fail(tracked, job);
        } else {
          jobs.push(job);
        }
      }
      const results = await evaluateJobs(subject, jobs, this.workerFile, {
        signal: this.access?.signal,
        taskBudget: this.budget,
      });
      for (const [done, result] of results) {
        this.settleJob(done.tracked, result);
      }
    };
    this.inFlight.push(
      work().catch((error: unknown) => {
        const reason = unexpectedReason(error);
        for (const tracked of batch) {
          this.fail(tracked, reason);
        }
      }),
    );
  }

  private async finish(end: RunEnd): Promise<void> {
    this.watching = [];
    const pending = this.tracked.filter((tracked) => !tracked.settled && !tracked.inFlight);
    if (end.kind !== 'completed' || this.dropped) {
      for (const tracked of pending) {
        const name = tracked.definition.name;
        this.fail(
          tracked,
          end.kind === 'completed'
            ? cancelledReason(this.run.label, name)
            : this.endReason(end, name),
        );
      }
      this.query = undefined;
      await Promise.all(this.inFlight);
      return;
    }
    const format = end.format === 'sse' || end.format === 'ndjson' ? end.format : undefined;
    const subject =
      format === undefined
        ? await this.bodyPhase(end, pending)
        : await this.streamPhase(end, format, pending);
    const jobs: TrackedJob[] = [];
    const paths = new Map<number, string | undefined>();
    for (const tracked of pending) {
      const reach = format === undefined ? 0 : furthest(tracked);
      let path = paths.get(reach);
      if (reach > 0 && !paths.has(reach)) {
        path = await end.spillPath(reach).catch(() => undefined);
        paths.set(reach, path);
      }
      const job = this.job(tracked, { ...subject, path });
      if (typeof job === 'string') {
        this.fail(tracked, job);
      } else {
        jobs.push(job);
      }
    }
    const results = await evaluateJobs(subject.subject, jobs, this.workerFile, {
      signal: end.signal,
      taskBudget: this.budget,
    });
    for (const [job, result] of results) {
      this.settleJob(job.tracked, result);
    }
    await Promise.all(this.inFlight);
  }

  private async bodyPhase(
    end: CompletedEnd,
    pending: readonly Tracked[],
  ): Promise<{ subject: BodySubject; phase: Phase; path: undefined }> {
    const needsBody = pending.some((tracked) => tracked.queries || readsSource(tracked, 'body'));
    const read = needsBody ? await bodySubject(end) : undefined;
    return {
      subject:
        read === undefined || typeof read === 'string'
          ? { kind: 'body', bytes: new Uint8Array(), contentType: end.contentType }
          : read,
      phase: {
        events: 'none',
        reply: { present: false, reason: notAnEventStreamReason },
        body: typeof read === 'string' ? { present: false, reason: read } : undefined,
      },
      path: undefined,
    };
  }

  private async streamPhase(
    end: CompletedEnd,
    format: 'sse' | 'ndjson',
    pending: readonly Tracked[],
  ): Promise<{ subject: BodySubject; phase: Phase; path: string | undefined }> {
    const reply = pending.some((tracked) => readsSource(tracked, 'text'))
      ? await replyOutcome(end)
      : undefined;
    const query = this.query;
    this.query = undefined;
    const queryPath =
      query === undefined || query.budget.end === 0
        ? undefined
        : await end.spillPath(query.budget.end).catch(() => undefined);
    let spillFile = queryPath;
    for (const tracked of pending) {
      const reach = furthest(tracked);
      spillFile ??= reach > 0 ? await end.spillPath(reach).catch(() => undefined) : undefined;
    }
    return {
      subject: {
        kind: 'events',
        format,
        path: spillFile,
        query:
          query === undefined
            ? undefined
            : this.collected(query.matches, query.budget, queryPath, query.budget.bytes),
      },
      phase: { events: 'streamed', reply, body: eventPhase.body },
      path: undefined,
    };
  }

  private collected(
    matches: Matches,
    budget: Budget,
    path: string | undefined,
    bytes: number,
  ): Collected | undefined {
    if (path !== undefined) {
      return { kind: 'ranges', ranges: matches.ranges };
    }
    if (!budget.values || this.sentBytes + bytes > maxSentValueBytes) {
      return undefined;
    }
    this.sentBytes += bytes;
    return { kind: 'values', values: matches.values };
  }

  private matchCollected(match: Match, path: string | undefined): Collected | undefined {
    if (path !== undefined) {
      if (match.length > inlineBodyBytes) {
        match.value = undefined;
      }
      return { kind: 'ranges', ranges: [match.offset, match.length], index: match.index };
    }
    if (match.value === undefined || this.sentBytes + match.length > maxSentValueBytes) {
      return undefined;
    }
    this.sentBytes += match.length;
    return { kind: 'values', values: [match.value], index: match.index };
  }

  private job(
    tracked: Tracked,
    { subject, phase, path }: { subject: BodySubject; phase: Phase; path: string | undefined },
    away = false,
  ): TrackedJob | string {
    const gathered = new Map<string, Collected>();
    if (phase.events === 'streamed') {
      if (tracked.queries && subject.kind === 'events' && subject.query === undefined) {
        return eventsUnavailableReason;
      }
      const all = allWatches(tracked);
      if (all.length > 0) {
        const budget = tracked.budget;
        let first = true;
        for (const watch of all) {
          const matches = this.collected(watch.matches, budget, path, first ? budget.bytes : 0);
          if (matches === undefined) {
            return eventsUnavailableReason;
          }
          first = false;
          gathered.set(sourceKey(watch.node), matches);
        }
      }
      for (const watch of tracked.watches) {
        const match = matchedWatch(watch);
        if (match !== undefined && (away || match.length > inlineBodyBytes)) {
          const matched = this.matchCollected(match, path);
          if (matched === undefined) {
            return eventUnavailableReason;
          }
          gathered.set(sourceKey(watch.node), matched);
        }
      }
    }
    return {
      tracked,
      name: tracked.definition.name,
      expression: tracked.definition.expression,
      text: tracked.definition.text,
      known: this.known(tracked, phase, gathered),
      collected: gathered,
    };
  }

  private endReason(end: Exclude<RunEnd, { kind: 'completed' }>, name: string): string {
    switch (end.kind) {
      case 'cancelled':
        return cancelledReason(this.run.label, name);
      case 'failed':
        return failedReason(this.run.label, name, end.message);
      case 'blocked':
        return notSentReason(this.run.label, end.message);
    }
  }

  private collectQuery(event: StreamEvent): boolean {
    const query = this.query;
    if (query === undefined || event.kind !== 'json') {
      return false;
    }
    const overflow = collect(query.matches, query.budget, event, () => {
      query.matches.values = [];
    });
    if (overflow === undefined) {
      return false;
    }
    this.query = undefined;
    const reason = overflow === 'events' ? tooManyStreamEventsReason : tooManyStreamBytesReason;
    for (const tracked of this.tracked) {
      const node = tracked.sources.find((source) => source.kind === 'jsonpath');
      if (!tracked.settled && node !== undefined) {
        this.fail(tracked, reason(this.sourceText(tracked, node)));
      }
    }
    return true;
  }

  private observe(
    tracked: Tracked,
    event: StreamEvent,
    item: ConditionItem,
    budget: WorkBudget,
  ): string | undefined {
    for (const watch of tracked.watches) {
      if ((watch.kind === 'first' || watch.kind === 'nth') && watch.match !== undefined) {
        continue;
      }
      if (watch.condition !== undefined) {
        const held = holds(watch.condition, item, { budget });
        if (budget.exhausted) {
          return budget.reason;
        }
        if (!held) {
          continue;
        }
      }
      switch (watch.kind) {
        case 'first':
        case 'last':
          watch.match = matchOf(event);
          break;
        case 'nth':
          watch.seen += 1;
          if (watch.seen === watch.position) {
            watch.match = matchOf(event);
          }
          break;
        case 'count':
          watch.count += 1;
          break;
        case 'all': {
          const overflow = collect(watch.matches, tracked.budget, event, () => {
            for (const other of allWatches(tracked)) {
              other.matches.values = [];
            }
          });
          if (overflow !== undefined) {
            const sources = allWatches(tracked)
              .map((other) => this.sourceText(tracked, other.node))
              .join(' and ');
            return overflow === 'events'
              ? tooManyMatchesReason(sources)
              : tooManyMatchBytesReason(sources);
          }
          break;
        }
      }
    }
    return undefined;
  }

  private sourceText(tracked: Tracked, node: SourceNode): string {
    return tracked.definition.text.slice(node.span.start, node.span.end);
  }

  private watchOutcome(tracked: Tracked, watch: Exclude<Watch, { kind: 'all' }>): Outcome {
    switch (watch.kind) {
      case 'first':
      case 'last':
      case 'nth': {
        if (watch.match?.value !== undefined) {
          return { present: true, value: watch.match.value, path: '', event: watch.match.index };
        }
        if (watch.match !== undefined) {
          return { present: false, reason: eventUnavailableReason };
        }
        const source = this.sourceText(tracked, watch.node);
        const seen = watch.kind === 'nth' ? watch.seen : 0;
        return {
          present: false,
          reason:
            seen === 0
              ? noEventMatchedReason(source, this.counts)
              : tooFewMatchedReason(source, seen, this.counts),
        };
      }
      case 'count':
        return { present: true, value: watch.count, path: '' };
    }
  }

  private known(
    tracked: Tracked,
    phase: Phase,
    gathered: ReadonlyMap<string, Collected> = new Map(),
  ): Map<string, Outcome> {
    const known = new Map<string, Outcome>();
    const response = this.response;
    for (const node of tracked.sources) {
      const key = sourceKey(node);
      if (isHeadNode(node)) {
        known.set(
          key,
          response === undefined
            ? { present: false, reason: noHeadersReason }
            : { present: true, value: response[node.name], path: '' },
        );
      } else if (node.kind === 'source' && node.name === 'text' && phase.reply !== undefined) {
        known.set(key, phase.reply);
      } else if (
        (node.kind === 'source' && node.name === 'body') ||
        (node.kind === 'jsonpath' && phase.events === 'none')
      ) {
        if (phase.body !== undefined) {
          known.set(key, phase.body);
        }
      } else if (isEventNode(node) && phase.events === 'none') {
        known.set(key, { present: false, reason: notAnEventStreamReason });
      }
    }
    if (phase.events === 'streamed') {
      for (const watch of tracked.watches) {
        const key = sourceKey(watch.node);
        if (watch.kind !== 'all' && !gathered.has(key)) {
          known.set(key, this.watchOutcome(tracked, watch));
        }
      }
    }
    return known;
  }

  private evaluateNow(tracked: Tracked, phase: Phase, budget: WorkBudget): Inserted {
    const known = this.known(tracked, phase);
    return inserted(
      evaluateWith(
        tracked.definition.expression,
        (node) => known.get(sourceKey(node)) ?? notEnded,
        phase.events === 'streamed',
        budget,
      ),
      budget,
    );
  }

  private settleJob(tracked: Tracked, result: Inserted): void {
    if (!result.present && result.reason === evaluationCancelledReason) {
      this.fail(tracked, cancelledReason(this.run.label, tracked.definition.name));
      return;
    }
    this.settle(tracked, result);
  }

  private settle(tracked: Tracked, result: Inserted): void {
    if (!result.present) {
      this.fail(tracked, result.reason);
      return;
    }
    this.report(tracked, {
      state: 'resolved',
      text: result.text,
      secret: tracked.definition.secret,
      sensitive: sensitiveValuesIn(result.text, this.sensitive),
      provenance: {
        runId: this.run.id,
        event: result.event,
        path: result.path,
        time: this.settledAt(tracked, result.event),
      },
    });
  }

  private settledAt(tracked: Tracked, event: number | undefined): number {
    const match = tracked.watches
      .map(matchedWatch)
      .find((candidate) => candidate !== undefined && candidate.index === event);
    return match === undefined ? Date.now() : this.run.wallStartedAt + match.time;
  }

  private fail(tracked: Tracked, reason: string): void {
    this.report(tracked, { state: 'failed', reason: maskValues(reason, this.sensitive) });
  }

  private report(tracked: Tracked, result: CaptureResult): void {
    if (tracked.settled) {
      return;
    }
    tracked.settled = true;
    tracked.watches = [];
    if (tracked.queries && !this.tracked.some((other) => other.queries && !other.settled)) {
      this.query = undefined;
    }
    this.onResult(tracked.definition.name, result);
  }
}
