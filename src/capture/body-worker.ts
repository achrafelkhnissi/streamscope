import { parentPort } from 'node:worker_threads';
import type { Outcome } from '../expressions/evaluate';
import { insertText, maxInsertedLength, valueTooLargeReason } from '../expressions/insert';
import { parseExpression } from '../expressions/parse';
import { runJobs, type BodyJob, type WorkerReply, type WorkerRequest } from './body';

function bounded(outcome: Outcome): Outcome {
  return !outcome.present || insertText(outcome.value, maxInsertedLength).ok
    ? outcome
    : { present: false, reason: valueTooLargeReason };
}

function reply(name: string, outcome: Outcome): void {
  const message: WorkerReply = { name, outcome: bounded(outcome) };
  parentPort?.postMessage(message);
}

parentPort?.once('message', ({ subject, jobs }: WorkerRequest) => {
  const parsed: BodyJob[] = [];
  for (const job of jobs) {
    const result = parseExpression(job.text, 'capture');
    if (result.ok) {
      parsed.push({ ...job, expression: result.expr });
    } else {
      reply(job.name, { present: false, reason: result.error.message });
    }
  }
  runJobs(subject, parsed, reply);
});
