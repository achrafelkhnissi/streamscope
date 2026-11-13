import { closeSync, openSync, readSync } from 'node:fs';
import type { Value } from '../expressions/ast';
import { parseExpression } from '../expressions/parse';
import { WorkBudget } from '../expressions/work';
import { parseEventBytes } from '../streaming/parser';
import {
  childWorkUnits,
  jobEvaluator,
  valuesOnly,
  type BodySubject,
  type Inserted,
  type ReadCollected,
  type WorkerReply,
  type WorkerRequest,
} from './body';

function readAt(descriptor: number, offset: number, length: number): Uint8Array | undefined {
  const bytes = new Uint8Array(length);
  for (let read = 0; read < length;) {
    const count = readSync(descriptor, bytes, read, length - read, offset + read);
    if (count === 0) {
      return undefined;
    }
    read += count;
  }
  return bytes;
}

function withFile<T>(path: string, use: (descriptor: number) => T | undefined): T | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    return use(descriptor);
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function loaded(subject: BodySubject): BodySubject {
  if (subject.kind !== 'file') {
    return subject;
  }
  const bytes = withFile(subject.path, (descriptor) => readAt(descriptor, 0, subject.length));
  return bytes === undefined ? subject : { kind: 'body', bytes, contentType: subject.contentType };
}

function rangeReader(subject: BodySubject): ReadCollected {
  if (subject.kind !== 'events' || subject.path === undefined) {
    return valuesOnly;
  }
  const { path, format } = subject;
  return (collected) => {
    if (collected.kind === 'values') {
      return collected.values;
    }
    return withFile(path, (descriptor) => {
      const values: Value[] = [];
      const { ranges } = collected;
      for (let at = 0; at + 1 < ranges.length; at += 2) {
        const offset = ranges[at] ?? 0;
        const length = ranges[at + 1] ?? 0;
        const bytes = readAt(descriptor, offset, length);
        const event =
          bytes === undefined
            ? undefined
            : parseEventBytes(bytes, format, { maxEventSize: length + 1, typeFields: [] });
        if (event === undefined || (event.kind !== 'json' && event.kind !== 'text')) {
          return undefined;
        }
        values.push(event.value);
      }
      return values;
    });
  };
}

function reply(name: string, result: Inserted): void {
  const message: WorkerReply = { name, result };
  process.send?.(message);
}

process.once('message', ({ subject, jobs }: WorkerRequest) => {
  const evaluateJob = jobEvaluator(
    loaded(subject),
    rangeReader(subject),
    () => new WorkBudget({ units: childWorkUnits }),
  );
  for (const job of jobs) {
    const parsed = parseExpression(job.text, 'capture');
    reply(
      job.name,
      parsed.ok
        ? evaluateJob({ ...job, expression: parsed.expr })
        : { present: false, reason: parsed.error.message },
    );
  }
});
