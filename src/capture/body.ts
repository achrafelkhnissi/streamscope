import { fork, type ChildProcess } from 'node:child_process';
import type { Expr, SourceNode, Value } from '../expressions/ast';
import { evaluate, type Outcome } from '../expressions/evaluate';
import { insertText, maxInsertedLength, valueTooLargeReason } from '../expressions/insert';
import { queryJsonPath } from '../expressions/jsonpath';
import { sourcesOf } from '../expressions/parse';
import { parseJson } from '../streaming/json';
import {
  bodyLimitReason,
  bodyUnavailableReason,
  checkSourceReason,
  evaluationCancelledReason,
  eventsUnavailableReason,
  eventStreamBodyReason,
  hardReasons,
  jsonPathLimitReason,
  missingQueryReason,
  notAnEventStreamReason,
  subjectOf,
  unavailableSourceReason,
  withSubject,
} from './messages';
import type { CaptureDefinition } from './tracker';

export type Collected =
  { kind: 'values'; values: readonly Value[] } | { kind: 'ranges'; ranges: readonly number[] };

export type BodySubject =
  | { kind: 'body'; bytes: Uint8Array; contentType: string | undefined }
  | { kind: 'file'; path: string; length: number; contentType: string | undefined }
  | {
      kind: 'events';
      format: 'sse' | 'ndjson';
      path: string | undefined;
      query: Collected | undefined;
    };

export type Inserted =
  | { present: true; text: string; event?: number; path: string }
  | { present: false; reason: string };

export type ReadCollected = (collected: Collected) => readonly Value[] | undefined;

export interface EvaluationOptions {
  timeLimitMs?: number;
  signal?: AbortSignal;
}

export class ChildSlots {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  get running(): number {
    return this.active;
  }

  get waiting(): number {
    return this.queue.length;
  }

  take(signal: AbortSignal | undefined): Promise<boolean> {
    if (signal?.aborted === true) {
      return Promise.resolve(false);
    }
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const start = (): void => {
        signal?.removeEventListener('abort', leave);
        this.active += 1;
        resolve(true);
      };
      const leave = (): void => {
        this.queue.splice(this.queue.indexOf(start), 1);
        resolve(false);
      };
      this.queue.push(start);
      signal?.addEventListener('abort', leave, { once: true });
    });
  }

  give(): void {
    this.active -= 1;
    this.queue.shift()?.();
  }
}

export interface BodyJob {
  name: string;
  expression: Expr;
  text: string;
  known: ReadonlyMap<string, Outcome>;
  collected: ReadonlyMap<string, Collected>;
}

export interface WorkerRequest {
  subject: BodySubject;
  jobs: readonly Omit<BodyJob, 'expression'>[];
}

export interface WorkerReply {
  name: string;
  result: Inserted;
}

interface DecodedBody {
  text: string;
  json: boolean;
}

export const inlineBodyBytes = 262_144;
export const inlineDigitBodyBytes = 65_536;
export const fileBodyBytes = 1_048_576;
export const childTimeLimitMs = 5000;
export const maxCaptureChildren = 2;
export const captureChildren = new ChildSlots(maxCaptureChildren);

const childHeapLimit = '--max-old-space-size=1024';
const longDigitRun = /\d{16}/;
const noneKnown: ReadonlyMap<string, Outcome> = new Map();
const noneCollected: ReadonlyMap<string, Collected> = new Map();

export function sourceKey(node: SourceNode): string {
  return `${String(node.span.start)}:${String(node.span.end)}`;
}

export function valuesOnly(collected: Collected): readonly Value[] | undefined {
  return collected.kind === 'values' ? collected.values : undefined;
}

function needsChild(node: SourceNode): boolean {
  return node.kind === 'jsonpath' || (node.kind === 'events' && node.name === 'all');
}

function hasJsonPath(expression: Expr): boolean {
  return sourcesOf(expression).some((node) => node.kind === 'jsonpath');
}

function readsBody(expression: Expr): boolean {
  return sourcesOf(expression).some((node) => node.kind === 'source' && node.name === 'body');
}

export function inserted(outcome: Outcome): Inserted {
  if (!outcome.present) {
    return outcome;
  }
  const text = insertText(outcome.value, maxInsertedLength);
  if (!text.ok) {
    return { present: false, reason: valueTooLargeReason };
  }
  return outcome.event === undefined
    ? { present: true, text: text.text, path: outcome.path }
    : { present: true, text: text.text, event: outcome.event, path: outcome.path };
}

export function evaluateWith(
  expression: Expr,
  read: (node: SourceNode) => Outcome,
  streamed: boolean,
): Outcome {
  let last: { node: SourceNode; outcome: Outcome } | undefined;
  let hard: string | undefined;
  const outcome = evaluate(expression, {
    value(node) {
      const served = read(node);
      last = { node, outcome: served };
      if (!served.present && hard === undefined && hardReasons.has(served.reason)) {
        hard = served.reason;
      }
      return served;
    },
  });
  if (hard !== undefined) {
    return { present: false, reason: hard };
  }
  if (outcome.present) {
    return outcome;
  }
  const subject = last === undefined ? undefined : subjectOf(last.node, last.outcome, streamed);
  return { present: false, reason: withSubject(outcome.reason, subject) };
}

function contentTypeParts(contentType: string | undefined): {
  media: string;
  charset: string | undefined;
} {
  const [media = '', ...parameters] = (contentType ?? '').split(';');
  let charset: string | undefined;
  for (const parameter of parameters) {
    const equals = parameter.indexOf('=');
    if (equals !== -1 && parameter.slice(0, equals).trim().toLowerCase() === 'charset') {
      const value = parameter.slice(equals + 1).trim();
      charset =
        value.length >= 2 && value.startsWith('"') && value.endsWith('"')
          ? value.slice(1, -1)
          : value;
    }
  }
  return { media: media.trim().toLowerCase(), charset };
}

function decoderFor(charset: string | undefined): InstanceType<typeof TextDecoder> {
  try {
    return new TextDecoder(charset ?? 'utf-8');
  } catch {
    return new TextDecoder('utf-8');
  }
}

function startsLikeJson(text: string): boolean {
  const start = text.trimStart();
  return start.startsWith('{') || start.startsWith('[');
}

function decodeBody(bytes: Uint8Array, contentType: string | undefined): DecodedBody {
  const { media, charset } = contentTypeParts(contentType);
  const text = decoderFor(charset).decode(bytes);
  return {
    text,
    json: media === 'application/json' || media.endsWith('+json') || startsLikeJson(text),
  };
}

function bodyValue(decoded: DecodedBody): Value {
  if (decoded.json) {
    const parsed = parseJson(decoded.text);
    if (parsed.ok) {
      return parsed.value;
    }
  }
  return decoded.text;
}

function inlineBody(subject: BodySubject): DecodedBody | undefined {
  if (subject.kind !== 'body' || subject.bytes.length > inlineBodyBytes) {
    return undefined;
  }
  const decoded = decodeBody(subject.bytes, subject.contentType);
  return subject.bytes.length > inlineDigitBodyBytes && longDigitRun.test(decoded.text)
    ? undefined
    : decoded;
}

function queryOutcome(target: Value, query: string): Outcome {
  const result = queryJsonPath(target, query);
  if (!result.ok) {
    return { present: false, reason: result.reason };
  }
  const [first] = result.nodes;
  if (first === undefined) {
    return { present: false, reason: missingQueryReason(query) };
  }
  return { present: true, value: result.nodes.length === 1 ? first : result.nodes, path: query };
}

export function jobEvaluator(
  subject: BodySubject,
  read: ReadCollected,
  decoded?: DecodedBody,
): (job: BodyJob) => Outcome {
  let target: { value: Value | undefined } | undefined;
  const subjectValue = (): Value | undefined => {
    if (target === undefined) {
      switch (subject.kind) {
        case 'body':
          target = { value: bodyValue(decoded ?? decodeBody(subject.bytes, subject.contentType)) };
          break;
        case 'file':
          target = { value: undefined };
          break;
        case 'events':
          target = { value: subject.query === undefined ? undefined : read(subject.query) };
          break;
      }
    }
    return target.value;
  };
  const unavailable: Outcome = {
    present: false,
    reason: subject.kind === 'events' ? eventsUnavailableReason : bodyUnavailableReason,
  };
  const computed = (node: SourceNode, job: BodyJob): Outcome => {
    if (node.kind === 'jsonpath') {
      const value = subjectValue();
      return value === undefined ? unavailable : queryOutcome(value, node.query);
    }
    if (node.kind === 'check') {
      return { present: false, reason: checkSourceReason };
    }
    if (node.kind === 'source' && node.name === 'body') {
      if (subject.kind === 'events') {
        return { present: false, reason: eventStreamBodyReason };
      }
      const value = subjectValue();
      return value === undefined ? unavailable : { present: true, value, path: '' };
    }
    if (node.kind === 'source' && node.name !== 'text') {
      return { present: false, reason: unavailableSourceReason(node.name) };
    }
    if (subject.kind !== 'events') {
      return { present: false, reason: notAnEventStreamReason };
    }
    const collected = job.collected.get(sourceKey(node));
    const values = collected === undefined ? undefined : read(collected);
    if (values !== undefined) {
      return { present: true, value: values, path: '' };
    }
    return collected === undefined
      ? {
          present: false,
          reason: unavailableSourceReason(job.text.slice(node.span.start, node.span.end)),
        }
      : { present: false, reason: eventsUnavailableReason };
  };
  return (job) =>
    evaluateWith(
      job.expression,
      (node) => job.known.get(sourceKey(node)) ?? computed(node, job),
      subject.kind === 'events',
    );
}

function unansweredResult(job: BodyJob, cancelled: boolean): Inserted {
  if (cancelled) {
    return { present: false, reason: evaluationCancelledReason };
  }
  return {
    present: false,
    reason: hasJsonPath(job.expression) ? jsonPathLimitReason : bodyLimitReason,
  };
}

interface ChildAnswers {
  answers: Map<string, Inserted>;
  cancelled: boolean;
}

async function runInChild(
  subject: BodySubject,
  jobs: readonly BodyJob[],
  workerFile: string,
  options: EvaluationOptions,
): Promise<ChildAnswers> {
  const { signal } = options;
  if (!(await captureChildren.take(signal))) {
    return { answers: new Map(), cancelled: true };
  }
  const ordered = jobs.toSorted(
    (left, right) => Number(hasJsonPath(left.expression)) - Number(hasJsonPath(right.expression)),
  );
  const request: WorkerRequest = {
    subject,
    jobs: ordered.map(({ name, text, known, collected }) => ({ name, text, known, collected })),
  };
  return new Promise((resolve) => {
    const answers = new Map<string, Inserted>();
    let child: ChildProcess | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      clearTimeout(timer);
      child?.kill('SIGKILL');
    };
    const closed = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      child?.removeAllListeners();
      captureChildren.give();
      resolve({ answers, cancelled: signal?.aborted === true });
    };
    try {
      const started = fork(workerFile, [], {
        execArgv: [childHeapLimit],
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      child = started;
      started.on('message', (reply: WorkerReply) => {
        answers.set(reply.name, reply.result);
        if (answers.size === ordered.length) {
          stop();
        }
      });
      started.on('error', () => {
        if (started.pid === undefined) {
          closed();
        } else {
          stop();
        }
      });
      started.on('close', closed);
      signal?.addEventListener('abort', stop, { once: true });
      timer = setTimeout(stop, options.timeLimitMs ?? childTimeLimitMs);
      started.send(request, (error: Error | null) => {
        if (error !== null) {
          stop();
        }
      });
    } catch {
      if (child === undefined) {
        closed();
      } else {
        stop();
      }
    }
  });
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function evaluateJobs<Job extends BodyJob>(
  subject: BodySubject,
  jobs: readonly Job[],
  workerFile: string,
  options: EvaluationOptions = {},
): Promise<(readonly [Job, Inserted])[]> {
  let decoded: DecodedBody | undefined;
  let decodedOnce = false;
  const bodyInline = (): boolean => {
    if (!decodedOnce) {
      decodedOnce = true;
      decoded = inlineBody(subject);
    }
    return decoded !== undefined;
  };
  const inline: Job[] = [];
  const away: Job[] = [];
  for (const job of jobs) {
    const child =
      sourcesOf(job.expression).some(
        (node) => needsChild(node) && !job.known.has(sourceKey(node)),
      ) ||
      (subject.kind !== 'events' && readsBody(job.expression) && !bodyInline());
    (child ? away : inline).push(job);
  }
  const answering = away.length === 0 ? undefined : runInChild(subject, away, workerFile, options);
  const results = new Map<string, Inserted>();
  const evaluateJob = jobEvaluator(subject, valuesOnly, decoded);
  for (const [position, job] of inline.entries()) {
    if (position > 0) {
      await nextTask();
    }
    results.set(job.name, inserted(evaluateJob(job)));
  }
  const { answers, cancelled } = (await answering) ?? { answers: new Map(), cancelled: false };
  return jobs.map((job) => [
    job,
    results.get(job.name) ?? answers.get(job.name) ?? unansweredResult(job, cancelled),
  ]);
}

export async function evaluateBodyExpressions(
  bytes: Uint8Array,
  contentType: string | undefined,
  definitions: readonly CaptureDefinition[],
  workerFile: string,
  options: EvaluationOptions = {},
): Promise<ReadonlyMap<string, Inserted>> {
  const results = await evaluateJobs(
    { kind: 'body', bytes, contentType },
    definitions.map(({ name, expression, text }) => ({
      name,
      expression,
      text,
      known: noneKnown,
      collected: noneCollected,
    })),
    workerFile,
    options,
  );
  return new Map(results.map(([job, result]) => [job.name, result]));
}
