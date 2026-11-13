import type { SourceNode } from '../expressions/ast';
import type { Outcome } from '../expressions/evaluate';

export interface EventCounts {
  events: number;
  malformed: number;
  oversize: number;
}

export interface Subject {
  text: string;
  plural: boolean;
}

export const maxCollectedEvents = 10_000;
export const maxCollectedBytes = 16_777_216;
export const maxSentValueBytes = 1_048_576;

export const notAnEventStreamReason = 'the response is not an event stream';
export const eventStreamBodyReason =
  'the response is an event stream; use first(…), last(…) or all(…)';
export const jsonPathLimitReason = 'jsonpath() took too long or used too much memory';
export const bodyLimitReason = 'evaluating the body took too long or used too much memory';
export const eventsLimitReason = 'evaluating the events took too long or used too much memory';
export const bodyUnavailableReason = 'the body is no longer available';
export const evaluationCancelledReason = 'evaluating the capture was cancelled';
export const replyUnavailableReason = 'the reply text is no longer available';
export const eventsUnavailableReason = 'the events are no longer available for this capture';
export const eventUnavailableReason = 'the event is no longer available for this capture';
export const bodyNotSentReason = 'the body is no longer available for this capture';
export const noReplyReason = 'the response has no recognised reply';
export const replyCutOffReason = 'the reply is larger than 1 MiB';
export const noHeadersReason = 'the response has no headers';
export const responsePendingReason = 'the response has not ended yet';
export const checkSourceReason = 'exists(…), before(…) and unique(…) work only in # @expect';
export const hostWorkReason = 'the capture needs too much work for this stream';

export const hardReasons: ReadonlySet<string> = new Set([
  notAnEventStreamReason,
  eventStreamBodyReason,
  bodyUnavailableReason,
  eventsUnavailableReason,
  eventUnavailableReason,
  bodyNotSentReason,
  replyUnavailableReason,
  noReplyReason,
  replyCutOffReason,
]);

const missingPrefix = 'has no value';
const genericSubject: Subject = { text: 'the expression', plural: false };
const sourceSubjects: Readonly<
  Record<'status' | 'headers' | 'cookies' | 'body' | 'text', Subject>
> = {
  status: { text: 'the status', plural: false },
  headers: { text: 'the headers', plural: true },
  cookies: { text: 'the cookies', plural: true },
  body: { text: 'the body', plural: false },
  text: { text: 'the reply text', plural: false },
};

function counted(count: number, noun: string): string {
  return `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`;
}

function countsText(counts: EventCounts): string {
  const parts = [counted(counts.events, 'event')];
  if (counts.malformed > 0) {
    parts.push(`${counts.malformed.toLocaleString('en-US')} malformed`);
  }
  if (counts.oversize > 0) {
    parts.push(`${counts.oversize.toLocaleString('en-US')} too large`);
  }
  return `(${parts.join(', ')})`;
}

function clause(sentence: string): string {
  return sentence.endsWith('.') ? sentence.slice(0, -1) : sentence;
}

function eventSubject(outcome: Outcome): Subject {
  return outcome.present && outcome.event !== undefined
    ? { text: `event ${String(outcome.event)}`, plural: false }
    : genericSubject;
}

export function noEventMatchedReason(source: string, counts: EventCounts): string {
  return `no event matched ${source} ${countsText(counts)}`;
}

export function tooFewMatchedReason(source: string, matched: number, counts: EventCounts): string {
  return `only ${counted(matched, 'event')} matched ${source} ${countsText(counts)}`;
}

export function tooManyMatchesReason(source: string): string {
  return `${source} matched more than ${maxCollectedEvents.toLocaleString('en-US')} events`;
}

export function tooManyMatchBytesReason(source: string): string {
  return `${source} matched more than 16 MiB of events`;
}

export function tooManyStreamEventsReason(source: string): string {
  return `${source} reads at most ${maxCollectedEvents.toLocaleString('en-US')} events, and the stream has more`;
}

export function tooManyStreamBytesReason(source: string): string {
  return `${source} reads at most 16 MiB of events, and the stream has more`;
}

export function unavailableSourceReason(source: string): string {
  return `${source} is not available to this evaluation`;
}

export function missingQueryReason(query: string): string {
  return `${missingPrefix} at ${query} (the query matched nothing)`;
}

export function cancelledReason(label: string, name: string): string {
  return `${label} was cancelled before ${name} resolved`;
}

export function failedReason(label: string, name: string, failure: string): string {
  return `${label} failed before ${name} resolved: ${clause(failure)}`;
}

export function notSentReason(label: string, problem: string): string {
  return `${label} was not sent: ${clause(problem)}`;
}

export function unexpectedReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `evaluating the capture failed: ${clause(message)}`;
}

export function subjectOf(node: SourceNode, outcome: Outcome, streamed: boolean): Subject {
  switch (node.kind) {
    case 'source':
      return sourceSubjects[node.name];
    case 'events':
      if (node.name === 'all') {
        return { text: 'the matching events', plural: true };
      }
      return node.name === 'count' ? { text: 'the count', plural: false } : eventSubject(outcome);
    case 'nth':
      return eventSubject(outcome);
    case 'jsonpath':
      return streamed ? { text: 'the events', plural: true } : sourceSubjects.body;
    case 'check':
      return genericSubject;
  }
}

export function withSubject(reason: string, subject: Subject | undefined): string {
  if (!reason.startsWith(missingPrefix)) {
    return reason;
  }
  const { text, plural } = subject ?? genericSubject;
  return `${text} ${plural ? `have${reason.slice('has'.length)}` : reason}`;
}
