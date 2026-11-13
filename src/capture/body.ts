import { Worker } from 'node:worker_threads';
import type { Expr, SourceNode, Value } from '../expressions/ast';
import { evaluate, type Outcome } from '../expressions/evaluate';
import { queryJsonPath } from '../expressions/jsonpath';
import { sourcesOf } from '../expressions/parse';
import { parseJson } from '../streaming/json';
import {
  bodyLimitReason,
  checkSourceReason,
  eventStreamBodyReason,
  jsonPathLimitReason,
  missingQueryReason,
  notAnEventStreamReason,
  subjectOf,
  unavailableSourceReason,
  withSubject,
} from './messages';
import type { CaptureDefinition } from './tracker';

export type BodySubject =
  | { kind: 'body'; bytes: Uint8Array; contentType: string | undefined }
  | { kind: 'events'; values: readonly Value[] };

export interface BodyJob {
  name: string;
  expression: Expr;
  text: string;
  known: ReadonlyMap<string, Outcome>;
}

export interface WorkerRequest {
  subject: BodySubject;
  jobs: readonly Omit<BodyJob, 'expression'>[];
}

export interface WorkerReply {
  name: string;
  outcome: Outcome;
}

const inlineBodyLimit = 1_048_576;

const workerTimeLimitMs = 1000;
const workerMemoryLimitMb = 256;
const noneKnown: ReadonlyMap<string, Outcome> = new Map();

export function sourceKey(node: SourceNode): string {
  return `${String(node.span.start)}:${String(node.span.end)}`;
}

function hasJsonPath(expression: Expr): boolean {
  return sourcesOf(expression).some((node) => node.kind === 'jsonpath');
}

function readsBody(expression: Expr): boolean {
  return sourcesOf(expression).some((node) => node.kind === 'source' && node.name === 'body');
}

export function evaluateWith(
  expression: Expr,
  read: (node: SourceNode) => Outcome,
  streamed: boolean,
): Outcome {
  let last: { node: SourceNode; outcome: Outcome } | undefined;
  const outcome = evaluate(expression, {
    value(node) {
      const served = read(node);
      last = { node, outcome: served };
      return served;
    },
  });
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

function bodyValue(bytes: Uint8Array, contentType: string | undefined): Value {
  const { media, charset } = contentTypeParts(contentType);
  const text = decoderFor(charset).decode(bytes);
  if (media === 'application/json' || media.endsWith('+json') || startsLikeJson(text)) {
    const parsed = parseJson(text);
    if (parsed.ok) {
      return parsed.value;
    }
  }
  return text;
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

export function runJobs(
  subject: BodySubject,
  jobs: readonly BodyJob[],
  report: (name: string, outcome: Outcome) => void,
): void {
  let target: { value: Value } | undefined;
  const subjectValue = (): Value => {
    target ??= {
      value:
        subject.kind === 'body' ? bodyValue(subject.bytes, subject.contentType) : subject.values,
    };
    return target.value;
  };
  const computed = (node: SourceNode, text: string): Outcome => {
    if (node.kind === 'jsonpath') {
      return queryOutcome(subjectValue(), node.query);
    }
    if (node.kind === 'check') {
      return { present: false, reason: checkSourceReason };
    }
    if (node.kind === 'source' && node.name === 'body') {
      return subject.kind === 'body'
        ? { present: true, value: subjectValue(), path: '' }
        : { present: false, reason: eventStreamBodyReason };
    }
    if (node.kind === 'source' && node.name !== 'text') {
      return { present: false, reason: unavailableSourceReason(node.name) };
    }
    return subject.kind === 'body'
      ? { present: false, reason: notAnEventStreamReason }
      : {
          present: false,
          reason: unavailableSourceReason(text.slice(node.span.start, node.span.end)),
        };
  };
  for (const job of jobs) {
    const outcome = evaluateWith(
      job.expression,
      (node) => job.known.get(sourceKey(node)) ?? computed(node, job.text),
      subject.kind === 'events',
    );
    report(job.name, outcome);
  }
}

function limitOutcome(job: BodyJob): Outcome {
  return {
    present: false,
    reason: hasJsonPath(job.expression) ? jsonPathLimitReason : bodyLimitReason,
  };
}

function workerMessage(
  subject: BodySubject,
  jobs: readonly BodyJob[],
): { request: WorkerRequest; transfer: ArrayBuffer[] } {
  const described = jobs.map(({ name, text, known }) => ({ name, text, known }));
  if (subject.kind === 'events') {
    return { request: { subject, jobs: described }, transfer: [] };
  }
  const bytes = new Uint8Array(subject.bytes);
  return {
    request: {
      subject: { kind: 'body', bytes, contentType: subject.contentType },
      jobs: described,
    },
    transfer: [bytes.buffer],
  };
}

function runInWorker(
  subject: BodySubject,
  jobs: readonly BodyJob[],
  workerFile: string,
): Promise<Map<string, Outcome>> {
  const ordered = jobs.toSorted(
    (left, right) => Number(hasJsonPath(left.expression)) - Number(hasJsonPath(right.expression)),
  );
  return new Promise((resolve) => {
    const answers = new Map<string, Outcome>();
    let settled = false;
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      void worker?.terminate();
      resolve(answers);
    };
    try {
      const started = new Worker(workerFile, {
        resourceLimits: { maxOldGenerationSizeMb: workerMemoryLimitMb },
      });
      worker = started;
      started.on('message', (reply: WorkerReply) => {
        if (settled) {
          return;
        }
        answers.set(reply.name, reply.outcome);
        if (answers.size === ordered.length) {
          finish();
        }
      });
      started.on('error', finish);
      started.on('exit', finish);
      timer = setTimeout(finish, workerTimeLimitMs);
      const { request, transfer } = workerMessage(subject, ordered);
      started.postMessage(request, transfer);
    } catch {
      finish();
    }
  });
}

export async function evaluateJobs<Job extends BodyJob>(
  subject: BodySubject,
  jobs: readonly Job[],
  workerFile: string,
): Promise<(readonly [Job, Outcome])[]> {
  const large = subject.kind === 'body' && subject.bytes.length > inlineBodyLimit;
  const inline: Job[] = [];
  const offThread: Job[] = [];
  for (const job of jobs) {
    const away = hasJsonPath(job.expression) || (large && readsBody(job.expression));
    (away ? offThread : inline).push(job);
  }
  const answering =
    offThread.length === 0 ? undefined : runInWorker(subject, offThread, workerFile);
  const outcomes = new Map<string, Outcome>();
  runJobs(subject, inline, (name, outcome) => {
    outcomes.set(name, outcome);
  });
  const answered = (await answering) ?? new Map<string, Outcome>();
  return jobs.map((job) => [
    job,
    outcomes.get(job.name) ?? answered.get(job.name) ?? limitOutcome(job),
  ]);
}

export async function evaluateBodyExpressions(
  bytes: Uint8Array,
  contentType: string | undefined,
  definitions: readonly CaptureDefinition[],
  workerFile: string,
): Promise<ReadonlyMap<string, Outcome>> {
  const outcomes = await evaluateJobs(
    { kind: 'body', bytes, contentType },
    definitions.map(({ name, expression, text }) => ({ name, expression, text, known: noneKnown })),
    workerFile,
  );
  return new Map(outcomes.map(([job, outcome]) => [job.name, outcome]));
}
