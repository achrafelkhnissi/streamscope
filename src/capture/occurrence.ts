import type { StreamEvent } from '../events/model';
import type { EventSummary } from '../events/store';
import type { Expr } from '../expressions/ast';
import { holds } from '../expressions/evaluate';
import { captureSliceMs, type TaskClock } from './task-budget';

export interface OccurrenceEvents {
  readonly count: number;
  summary(index: number): EventSummary | undefined;
  read(index: number): Promise<StreamEvent | undefined>;
}

export type OccurrenceResult =
  { ok: true; occurrence: number } | { ok: false; reason: 'events-gone' | 'cancelled' };

const realClock: TaskClock = {
  now: () => performance.now(),
  nextTask: (callback) => {
    setImmediate(callback);
  },
};

const gone: OccurrenceResult = { ok: false, reason: 'events-gone' };
const cancelled: OccurrenceResult = { ok: false, reason: 'cancelled' };

export async function countOccurrence(input: {
  events: OccurrenceEvents;
  index: number;
  condition: Expr | undefined;
  label: string | undefined;
  signal: AbortSignal;
  clock?: TaskClock;
}): Promise<OccurrenceResult> {
  const { events, index, condition, label, signal } = input;
  const clock = input.clock ?? realClock;
  let matched = 0;
  let sliceStart = clock.now();
  for (let at = 1; at < index; at += 1) {
    if (clock.now() - sliceStart >= captureSliceMs) {
      await new Promise<void>((resolve) => {
        clock.nextTask(resolve);
      });
      sliceStart = clock.now();
    }
    if (signal.aborted) {
      return cancelled;
    }
    const summary = events.summary(at);
    if (summary === undefined) {
      return gone;
    }
    if (summary.kind !== 'json' && summary.kind !== 'text') {
      continue;
    }
    if (condition === undefined) {
      matched += 1;
      continue;
    }
    if (label !== undefined && summary.label !== undefined && summary.label !== label) {
      continue;
    }
    const event = await events.read(at);
    if (event === undefined) {
      return gone;
    }
    if (holds(condition, { value: event.value, sse: event.sse, malformed: false })) {
      matched += 1;
    }
  }
  return signal.aborted ? cancelled : { ok: true, occurrence: matched + 1 };
}
