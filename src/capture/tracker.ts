import type { StreamEvent } from '../events/model';
import type { Expr, SourceNode, Value } from '../expressions/ast';
import { holds, type ConditionItem, type Outcome } from '../expressions/evaluate';
import { sourcesOf } from '../expressions/parse';
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
  bodyUnavailableReason,
  cancelledReason,
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
  | { state: 'resolved'; text: string; secret: boolean; provenance: Provenance }
  | { state: 'failed'; reason: string };

type EventNode = Extract<SourceNode, { kind: 'events' | 'nth' }>;
type HeadNode = Extract<SourceNode, { kind: 'source' }> & { name: keyof HeadValues };

interface Match {
  index: number;
  value: Value;
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

interface HeadValues {
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

function headValues(head: ResponseHead): HeadValues {
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
    value: event.value,
    offset: event.offset,
    length: event.length,
    format: event.sse === undefined ? 'ndjson' : 'sse',
  };
}

function largeMatch(watch: Watch): Match | undefined {
  return watch.kind !== 'all' &&
    watch.kind !== 'count' &&
    watch.match !== undefined &&
    watch.match.length > inlineBodyBytes
    ? watch.match
    : undefined;
}

function matchCollected(match: Match, path: string | undefined): Collected | undefined {
  if (path !== undefined) {
    return { kind: 'ranges', ranges: [match.offset, match.length], index: match.index };
  }
  return match.length <= maxSentValueBytes
    ? { kind: 'values', values: [match.value], index: match.index }
    : undefined;
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
  return { events: 0, bytes: 0, values: true };
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
  matches.ranges.push(event.offset, event.length);
  if (budget.values && budget.bytes > maxSentValueBytes) {
    budget.values = false;
    dropValues();
  } else if (budget.values) {
    matches.values.push(event.value);
  }
  return undefined;
}

function collected(
  matches: Matches,
  budget: Budget,
  path: string | undefined,
): Collected | undefined {
  if (path !== undefined) {
    return { kind: 'ranges', ranges: matches.ranges };
  }
  return budget.values ? { kind: 'values', values: matches.values } : undefined;
}

async function bodySubject(end: CompletedEnd): Promise<BodySubject | undefined> {
  const path =
    end.bodyLength > fileBodyBytes
      ? await end.spillPath(end.bodyLength).catch(() => undefined)
      : undefined;
  if (path !== undefined) {
    return { kind: 'file', path, length: end.bodyLength, contentType: end.contentType };
  }
  const bytes = await end.readBody(Number.MAX_SAFE_INTEGER).catch(() => undefined);
  return bytes === undefined ? undefined : { kind: 'body', bytes, contentType: end.contentType };
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
  private rangesEnd = 0;
  private readonly counts: EventCounts = { events: 0, malformed: 0, oversize: 0 };
  private response: HeadValues | undefined;
  private access: RunAccess | undefined;
  private readonly inFlight: Promise<void>[] = [];
  private ending: Promise<void> | undefined;

  constructor(
    private readonly run: { id: number; label: string },
    definitions: readonly CaptureDefinition[],
    private readonly onResult: (name: string, result: CaptureResult) => void,
    private readonly workerFile: string,
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

  head(head: ResponseHead, access?: RunAccess): void {
    this.response = headValues(head);
    this.access = access;
    for (const tracked of this.tracked) {
      if (!tracked.settled && tracked.timing === 'head') {
        this.settle(tracked, inserted(this.evaluateNow(tracked, headPhase)));
      }
    }
  }

  event(event: StreamEvent): void {
    this.counts.events += 1;
    if (event.kind === 'malformed') {
      this.counts.malformed += 1;
    } else if (event.kind === 'oversize') {
      this.counts.oversize += 1;
    }
    if (event.kind !== 'json' && event.kind !== 'text') {
      return;
    }
    let changed = this.collectQuery(event);
    if (this.watching.length === 0) {
      return;
    }
    const item: ConditionItem = { value: event.value, sse: event.sse, malformed: false };
    for (const tracked of this.watching) {
      if (tracked.settled) {
        continue;
      }
      const overflow = this.observe(tracked, event, item);
      if (overflow !== undefined) {
        this.fail(tracked, overflow);
        changed = true;
      } else if (matchedNow(tracked)) {
        const [watch] = tracked.watches;
        const large = watch === undefined ? undefined : largeMatch(watch);
        if (large === undefined) {
          this.settle(tracked, inserted(this.evaluateNow(tracked, eventPhase)));
        } else {
          this.evaluateLater(tracked, large);
        }
        changed = true;
      }
    }
    if (changed) {
      this.watching = this.watching.filter((tracked) => !tracked.settled && !tracked.inFlight);
    }
  }

  end(end: RunEnd): Promise<void> {
    this.ending ??= this.finish(end).catch((error: unknown) => {
      const reason = unexpectedReason(error);
      for (const tracked of this.tracked) {
        if (!tracked.settled) {
          this.fail(tracked, reason);
        }
      }
    });
    return this.ending;
  }

  private evaluateLater(tracked: Tracked, match: Match): void {
    tracked.inFlight = true;
    const work = async (): Promise<void> => {
      const path = await this.access?.spillPath(match.offset + match.length).catch(() => undefined);
      const subject: BodySubject = { kind: 'events', format: match.format, path, query: undefined };
      const job = this.job(tracked, { subject, phase: eventPhase, path });
      if (typeof job === 'string') {
        this.fail(tracked, job);
        return;
      }
      const results = await evaluateJobs(subject, [job], this.workerFile, {
        signal: this.access?.signal,
      });
      for (const [done, result] of results) {
        this.settle(done.tracked, result);
      }
    };
    this.inFlight.push(
      work().catch((error: unknown) => {
        if (!tracked.settled) {
          this.fail(tracked, unexpectedReason(error));
        }
      }),
    );
  }

  private async finish(end: RunEnd): Promise<void> {
    this.watching = [];
    const pending = this.tracked.filter((tracked) => !tracked.settled && !tracked.inFlight);
    if (end.kind !== 'completed') {
      for (const tracked of pending) {
        this.fail(tracked, this.endReason(end, tracked.definition.name));
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
    for (const tracked of pending) {
      const job = this.job(tracked, subject);
      if (typeof job === 'string') {
        this.fail(tracked, job);
      } else {
        jobs.push(job);
      }
    }
    const results = await evaluateJobs(subject.subject, jobs, this.workerFile, {
      signal: end.signal,
    });
    for (const [job, result] of results) {
      this.settle(job.tracked, result);
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
      subject: read ?? { kind: 'body', bytes: new Uint8Array(), contentType: end.contentType },
      phase: {
        events: 'none',
        reply: { present: false, reason: notAnEventStreamReason },
        body:
          needsBody && read === undefined
            ? { present: false, reason: bodyUnavailableReason }
            : undefined,
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
    const path =
      this.rangesEnd > 0 ? await end.spillPath(this.rangesEnd).catch(() => undefined) : undefined;
    const query = this.query;
    this.query = undefined;
    return {
      subject: {
        kind: 'events',
        format,
        path,
        query: query === undefined ? undefined : collected(query.matches, query.budget, path),
      },
      phase: { events: 'streamed', reply, body: eventPhase.body },
      path,
    };
  }

  private job(
    tracked: Tracked,
    { subject, phase, path }: { subject: BodySubject; phase: Phase; path: string | undefined },
  ): TrackedJob | string {
    const gathered = new Map<string, Collected>();
    if (phase.events === 'streamed') {
      if (tracked.queries && subject.kind === 'events' && subject.query === undefined) {
        return eventsUnavailableReason;
      }
      for (const watch of tracked.watches) {
        const large = largeMatch(watch);
        if (watch.kind === 'all') {
          const matches = collected(watch.matches, tracked.budget, path);
          if (matches === undefined) {
            return eventsUnavailableReason;
          }
          gathered.set(sourceKey(watch.node), matches);
        } else if (large !== undefined) {
          const matched = matchCollected(large, path);
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
      known: this.known(tracked, phase),
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
      this.rangesEnd = event.offset + event.length;
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

  private observe(tracked: Tracked, event: StreamEvent, item: ConditionItem): string | undefined {
    for (const watch of tracked.watches) {
      if ((watch.kind === 'first' || watch.kind === 'nth') && watch.match !== undefined) {
        continue;
      }
      if (watch.condition !== undefined && !holds(watch.condition, item)) {
        continue;
      }
      switch (watch.kind) {
        case 'first':
        case 'last':
          watch.match = matchOf(event);
          this.reach(event);
          break;
        case 'nth':
          watch.seen += 1;
          if (watch.seen === watch.position) {
            watch.match = matchOf(event);
            this.reach(event);
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
          this.rangesEnd = event.offset + event.length;
          break;
        }
      }
    }
    return undefined;
  }

  private reach(event: StreamEvent): void {
    if (event.length > inlineBodyBytes) {
      this.rangesEnd = Math.max(this.rangesEnd, event.offset + event.length);
    }
  }

  private sourceText(tracked: Tracked, node: SourceNode): string {
    return tracked.definition.text.slice(node.span.start, node.span.end);
  }

  private watchOutcome(tracked: Tracked, watch: Exclude<Watch, { kind: 'all' }>): Outcome {
    switch (watch.kind) {
      case 'first':
      case 'last':
      case 'nth': {
        if (watch.match !== undefined) {
          return { present: true, value: watch.match.value, path: '', event: watch.match.index };
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

  private known(tracked: Tracked, phase: Phase): Map<string, Outcome> {
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
        if (watch.kind !== 'all' && largeMatch(watch) === undefined) {
          known.set(sourceKey(watch.node), this.watchOutcome(tracked, watch));
        }
      }
    }
    return known;
  }

  private evaluateNow(tracked: Tracked, phase: Phase): Outcome {
    const known = this.known(tracked, phase);
    return evaluateWith(
      tracked.definition.expression,
      (node) => known.get(sourceKey(node)) ?? notEnded,
      phase.events === 'streamed',
    );
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
      provenance: { runId: this.run.id, event: result.event, path: result.path, time: Date.now() },
    });
  }

  private fail(tracked: Tracked, reason: string): void {
    this.report(tracked, { state: 'failed', reason });
  }

  private report(tracked: Tracked, result: CaptureResult): void {
    tracked.settled = true;
    tracked.watches = [];
    if (tracked.queries && !this.tracked.some((other) => other.queries && !other.settled)) {
      this.query = undefined;
    }
    this.onResult(tracked.definition.name, result);
  }
}
