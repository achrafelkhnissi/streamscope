import { fork, type ChildProcess } from 'node:child_process';
import type { Expr, SourceNode, Value } from '../expressions/ast';
import { evaluate, type Outcome } from '../expressions/evaluate';
import { queryJsonPath } from '../expressions/jsonpath';
import { sourcesOf } from '../expressions/parse';
import { parseJson } from '../streaming/json';
import {
  bodyLimitReason,
  bodyUnavailableReason,
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
  | { kind: 'file'; path: string; length: number; contentType: string | undefined }
  | { kind: 'events'; values: readonly Value[] };

export interface EvaluationOptions {
  timeLimitMs?: number;
}

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

export const inlineBodyLimit = 1_048_576;

const childTimeLimitMs = 5000;
const childHeapLimit = '--max-old-space-size=1024';
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
  const subjectValue = (): Value | undefined => {
    if (subject.kind === 'file') {
      return undefined;
    }
    target ??= {
      value:
        subject.kind === 'body' ? bodyValue(subject.bytes, subject.contentType) : subject.values,
    };
    return target.value;
  };
  const unavailable: Outcome = { present: false, reason: bodyUnavailableReason };
  const computed = (node: SourceNode, text: string): Outcome => {
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
    return subject.kind === 'events'
      ? {
          present: false,
          reason: unavailableSourceReason(text.slice(node.span.start, node.span.end)),
        }
      : { present: false, reason: notAnEventStreamReason };
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

function runInChild(
  subject: BodySubject,
  jobs: readonly BodyJob[],
  workerFile: string,
  timeLimitMs: number,
): Promise<Map<string, Outcome>> {
  const ordered = jobs.toSorted(
    (left, right) => Number(hasJsonPath(left.expression)) - Number(hasJsonPath(right.expression)),
  );
  const request: WorkerRequest = {
    subject,
    jobs: ordered.map(({ name, text, known }) => ({ name, text, known })),
  };
  return new Promise((resolve) => {
    const answers = new Map<string, Outcome>();
    let child: ChildProcess | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = (): void => {
      clearTimeout(timer);
      child?.removeAllListeners();
      resolve(answers);
    };
    const stop = (): void => {
      clearTimeout(timer);
      child?.kill('SIGKILL');
    };
    try {
      const started = fork(workerFile, [], {
        execArgv: [childHeapLimit],
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      child = started;
      started.on('message', (reply: WorkerReply) => {
        answers.set(reply.name, reply.outcome);
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
      timer = setTimeout(stop, timeLimitMs);
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

export async function evaluateJobs<Job extends BodyJob>(
  subject: BodySubject,
  jobs: readonly Job[],
  workerFile: string,
  options: EvaluationOptions = {},
): Promise<(readonly [Job, Outcome])[]> {
  const large =
    subject.kind === 'file' || (subject.kind === 'body' && subject.bytes.length > inlineBodyLimit);
  const inline: Job[] = [];
  const offThread: Job[] = [];
  for (const job of jobs) {
    const away = hasJsonPath(job.expression) || (large && readsBody(job.expression));
    (away ? offThread : inline).push(job);
  }
  const answering =
    offThread.length === 0
      ? undefined
      : runInChild(subject, offThread, workerFile, options.timeLimitMs ?? childTimeLimitMs);
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
  options: EvaluationOptions = {},
): Promise<ReadonlyMap<string, Outcome>> {
  const outcomes = await evaluateJobs(
    { kind: 'body', bytes, contentType },
    definitions.map(({ name, expression, text }) => ({ name, expression, text, known: noneKnown })),
    workerFile,
    options,
  );
  return new Map(outcomes.map(([job, outcome]) => [job.name, outcome]));
}
