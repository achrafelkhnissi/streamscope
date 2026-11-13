import type { StreamEvent } from '../events/model';
import type { Expr, SourceNode, Value } from '../expressions/ast';
import { holds, type ConditionItem, type Outcome } from '../expressions/evaluate';
import { insertText, maxInsertedLength, valueTooLargeReason } from '../expressions/insert';
import { sourcesOf } from '../expressions/parse';
import type { RunEnd } from '../runs/observer';
import type { ResponseHead } from '../transport/model';
import {
  evaluateJobs,
  evaluateWith,
  inlineBodyLimit,
  sourceKey,
  type BodyJob,
  type BodySubject,
} from './body';
import {
  bodyUnavailableReason,
  cancelledReason,
  eventStreamBodyReason,
  failedReason,
  maxCollectedBytes,
  maxCollectedEvents,
  maxQueriedBytes,
  noEventMatchedReason,
  noHeadersReason,
  notAnEventStreamReason,
  notSentReason,
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
  | { kind: 'all'; node: EventNode; condition: Expr | undefined; values: Value[]; bytes: number };

type Timing = 'head' | 'event' | 'end';

interface Tracked {
  readonly definition: CaptureDefinition;
  readonly sources: readonly SourceNode[];
  readonly timing: Timing;
  readonly queries: boolean;
  watches: Watch[];
  settled: boolean;
}

interface Collection {
  values: Value[];
  bytes: number;
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
      return { kind: 'all', node, condition, values: [], bytes: 0 };
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

function matchedNow(tracked: Tracked): boolean {
  const [watch] = tracked.watches;
  return (
    tracked.timing === 'event' &&
    (watch?.kind === 'first' || watch?.kind === 'nth') &&
    watch.match !== undefined
  );
}

async function bodySubject(end: CompletedEnd): Promise<BodySubject | undefined> {
  const file =
    end.bodyLength > inlineBodyLimit ? await end.bodyFile().catch(() => undefined) : undefined;
  if (file !== undefined) {
    return { kind: 'file', path: file.path, length: file.length, contentType: end.contentType };
  }
  const bytes = await end.readBody(Number.MAX_SAFE_INTEGER).catch(() => undefined);
  return bytes === undefined ? undefined : { kind: 'body', bytes, contentType: end.contentType };
}

function readsSource(tracked: Tracked, name: 'body' | 'text'): boolean {
  return tracked.sources.some((node) => node.kind === 'source' && node.name === name);
}

export class CaptureTracker {
  private readonly tracked: readonly Tracked[];
  private watching: Tracked[];
  private collection: Collection | undefined;
  private readonly counts: EventCounts = { events: 0, malformed: 0, oversize: 0 };
  private response: HeadValues | undefined;
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
        watches: sources.filter(isEventNode).map(watchOf),
        settled: false,
      };
    });
    this.watching = this.tracked.filter((tracked) => tracked.watches.length > 0);
    this.collection = this.tracked.some((tracked) => tracked.queries)
      ? { values: [], bytes: 0 }
      : undefined;
  }

  get retainedValues(): number {
    let retained = this.collection?.values.length ?? 0;
    for (const tracked of this.tracked) {
      for (const watch of tracked.watches) {
        if (watch.kind === 'all') {
          retained += watch.values.length;
        }
      }
    }
    return retained;
  }

  head(head: ResponseHead): void {
    this.response = headValues(head);
    for (const tracked of this.tracked) {
      if (!tracked.settled && tracked.timing === 'head') {
        this.settle(tracked, this.evaluateNow(tracked, headPhase));
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
    let changed = this.collect(event);
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
        this.settle(tracked, this.evaluateNow(tracked, eventPhase));
        changed = true;
      }
    }
    if (changed) {
      this.watching = this.watching.filter((tracked) => !tracked.settled);
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

  private async finish(end: RunEnd): Promise<void> {
    this.watching = [];
    const pending = this.tracked.filter((tracked) => !tracked.settled);
    if (end.kind !== 'completed') {
      for (const tracked of pending) {
        this.fail(tracked, this.endReason(end, tracked.definition.name));
      }
      this.collection = undefined;
      return;
    }
    const streamed = end.format === 'sse' || end.format === 'ndjson';
    const values = this.collection?.values ?? [];
    this.collection = undefined;
    let subject: BodySubject;
    let phase: Phase;
    if (streamed) {
      const reply = pending.some((tracked) => readsSource(tracked, 'text'))
        ? await end.readReply().catch(() => undefined)
        : undefined;
      subject = { kind: 'events', values };
      phase = {
        events: 'streamed',
        reply:
          reply === undefined
            ? { present: false, reason: replyUnavailableReason }
            : { present: true, value: reply, path: '' },
        body: eventPhase.body,
      };
    } else {
      const needsBody = pending.some((tracked) => tracked.queries || readsSource(tracked, 'body'));
      const read = needsBody ? await bodySubject(end) : undefined;
      subject = read ?? { kind: 'body', bytes: new Uint8Array(), contentType: end.contentType };
      phase = {
        events: 'none',
        reply: { present: false, reason: notAnEventStreamReason },
        body:
          needsBody && read === undefined
            ? { present: false, reason: bodyUnavailableReason }
            : undefined,
      };
    }
    const jobs: TrackedJob[] = pending.map((tracked) => ({
      tracked,
      name: tracked.definition.name,
      expression: tracked.definition.expression,
      text: tracked.definition.text,
      known: this.known(tracked, phase),
    }));
    for (const [job, outcome] of await evaluateJobs(subject, jobs, this.workerFile, {
      signal: end.signal,
    })) {
      this.settle(job.tracked, outcome);
    }
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

  private collect(event: StreamEvent): boolean {
    const collection = this.collection;
    if (collection === undefined || event.kind !== 'json') {
      return false;
    }
    const overflow =
      collection.values.length === maxCollectedEvents
        ? tooManyStreamEventsReason
        : collection.bytes + event.length > maxQueriedBytes
          ? tooManyStreamBytesReason
          : undefined;
    if (overflow === undefined) {
      collection.values.push(event.value);
      collection.bytes += event.length;
      return false;
    }
    this.collection = undefined;
    for (const tracked of this.tracked) {
      const query = tracked.sources.find((node) => node.kind === 'jsonpath');
      if (!tracked.settled && query !== undefined) {
        this.fail(tracked, overflow(this.sourceText(tracked, query)));
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
          watch.match = { index: event.index, value: event.value };
          break;
        case 'nth':
          watch.seen += 1;
          if (watch.seen === watch.position) {
            watch.match = { index: event.index, value: event.value };
          }
          break;
        case 'count':
          watch.count += 1;
          break;
        case 'all':
          if (watch.values.length === maxCollectedEvents) {
            return tooManyMatchesReason(this.sourceText(tracked, watch.node));
          }
          if (watch.bytes + event.length > maxCollectedBytes) {
            return tooManyMatchBytesReason(this.sourceText(tracked, watch.node));
          }
          watch.values.push(event.value);
          watch.bytes += event.length;
          break;
      }
    }
    return undefined;
  }

  private sourceText(tracked: Tracked, node: SourceNode): string {
    return tracked.definition.text.slice(node.span.start, node.span.end);
  }

  private watchOutcome(tracked: Tracked, watch: Watch): Outcome {
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
      case 'all':
        return { present: true, value: watch.values, path: '' };
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
        known.set(sourceKey(watch.node), this.watchOutcome(tracked, watch));
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

  private settle(tracked: Tracked, outcome: Outcome): void {
    if (!outcome.present) {
      this.fail(tracked, outcome.reason);
      return;
    }
    const inserted = insertText(outcome.value, maxInsertedLength);
    if (!inserted.ok) {
      this.fail(tracked, valueTooLargeReason);
      return;
    }
    this.report(tracked, {
      state: 'resolved',
      text: inserted.text,
      secret: tracked.definition.secret,
      provenance: {
        runId: this.run.id,
        event: outcome.event,
        path: outcome.path,
        time: Date.now(),
      },
    });
  }

  private fail(tracked: Tracked, reason: string): void {
    this.report(tracked, { state: 'failed', reason });
  }

  private report(tracked: Tracked, result: CaptureResult): void {
    tracked.settled = true;
    tracked.watches = [];
    if (tracked.queries && !this.tracked.some((other) => other.queries && !other.settled)) {
      this.collection = undefined;
    }
    this.onResult(tracked.definition.name, result);
  }
}
