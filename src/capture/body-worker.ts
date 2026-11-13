import { closeSync, openSync, readSync } from 'node:fs';
import type { Outcome } from '../expressions/evaluate';
import { insertText, maxInsertedLength, valueTooLargeReason } from '../expressions/insert';
import { parseExpression } from '../expressions/parse';
import {
  runJobs,
  type BodyJob,
  type BodySubject,
  type WorkerReply,
  type WorkerRequest,
} from './body';

function bounded(outcome: Outcome): Outcome {
  return !outcome.present || insertText(outcome.value, maxInsertedLength).ok
    ? outcome
    : { present: false, reason: valueTooLargeReason };
}

function reply(name: string, outcome: Outcome): void {
  const message: WorkerReply = { name, outcome: bounded(outcome) };
  process.send?.(message);
}

function readFully(path: string, length: number): Uint8Array | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    const bytes = new Uint8Array(length);
    for (let offset = 0; offset < length;) {
      const read = readSync(descriptor, bytes, offset, length - offset, offset);
      if (read === 0) {
        return undefined;
      }
      offset += read;
    }
    return bytes;
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
  const bytes = readFully(subject.path, subject.length);
  return bytes === undefined ? subject : { kind: 'body', bytes, contentType: subject.contentType };
}

process.once('message', ({ subject, jobs }: WorkerRequest) => {
  const parsed: BodyJob[] = [];
  for (const job of jobs) {
    const result = parseExpression(job.text, 'capture');
    if (result.ok) {
      parsed.push({ ...job, expression: result.expr });
    } else {
      reply(job.name, { present: false, reason: result.error.message });
    }
  }
  runJobs(loaded(subject), parsed, reply);
});
