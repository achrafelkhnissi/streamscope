import type { JsonValue, StreamEvent } from '../events/model';
import { parseExpression } from '../expressions/parse';
import type { PathSegment, PositionProblem } from '../response/json-position';
import {
  captureExpression,
  conditionText,
  eventCondition,
  suggestedCaptureName,
  type BuiltExpression,
  type EventCondition,
} from './capture-line';
import { countOccurrence, type OccurrenceEvents } from './occurrence';
import type { TaskClock } from './task-budget';

export type ValueTarget = { kind: 'event'; event: StreamEvent } | { kind: 'body' };

export type ValuePlan =
  | {
      ok: true;
      expression: string;
      condition: EventCondition | undefined;
      suggestedName: string;
    }
  | { ok: false; message: string }
  | { ok: false; cancelled: true };

const noValueMessage = 'There is no value at this position.';
const streamBodyMessage =
  'This response is an event stream; capture a value from one of its events instead.';
const invalidMessage = 'Streamscope could not write a valid capture for this value.';

const positionMessages: Record<PositionProblem, string> = {
  'not-json': 'Capture This Value needs a JSON value, and the text here is not JSON.',
  'no-value': noValueMessage,
  'too-deep': 'This value is nested too deeply to capture (more than 256 levels).',
};

export function positionMessage(problem: PositionProblem): string {
  return positionMessages[problem];
}

function unreadableMessage(event: StreamEvent): string | undefined {
  const index = String(event.index);
  switch (event.kind) {
    case 'malformed':
      return `Event ${index} is not valid JSON, so a capture cannot read it.`;
    case 'oversize':
      return `Event ${index} was cut at streamscope.stream.maxEventSize, so a capture cannot read it.`;
    case 'comment':
      return `Event ${index} is an SSE comment, and captures do not see comments.`;
    default:
      return undefined;
  }
}

function goneMessage(index: number): string {
  return `The events before event ${String(index)} are no longer kept, so Streamscope cannot tell which occurrence it is. Write this capture by hand.`;
}

function hasPath(value: JsonValue, segments: readonly PathSegment[]): boolean {
  let node = value;
  for (const segment of segments) {
    if (typeof segment === 'number') {
      if (!Array.isArray(node) || segment >= node.length) {
        return false;
      }
      node = (node as readonly JsonValue[])[segment] ?? null;
    } else {
      if (node === null || typeof node !== 'object' || Array.isArray(node)) {
        return false;
      }
      const fields = node as { readonly [key: string]: JsonValue };
      if (!Object.hasOwn(fields, segment)) {
        return false;
      }
      node = fields[segment] ?? null;
    }
  }
  return true;
}

function finish(
  built: BuiltExpression,
  segments: readonly PathSegment[],
  condition: EventCondition | undefined,
  taken: ReadonlySet<string>,
): ValuePlan {
  if (!built.ok) {
    return built;
  }
  if (!parseExpression(built.text, 'capture').ok) {
    return { ok: false, message: invalidMessage };
  }
  return {
    ok: true,
    expression: built.text,
    condition,
    suggestedName: suggestedCaptureName(segments, condition, taken),
  };
}

export async function planValueCapture(input: {
  target: ValueTarget;
  segments: readonly PathSegment[];
  stream: { events: OccurrenceEvents; typeFields: readonly string[] } | undefined;
  taken: ReadonlySet<string>;
  signal: AbortSignal;
  clock?: TaskClock;
}): Promise<ValuePlan> {
  const { target, stream, taken, signal } = input;
  if (target.kind === 'body') {
    return stream === undefined
      ? finish(
          captureExpression({ kind: 'body' }, input.segments),
          input.segments,
          undefined,
          taken,
        )
      : { ok: false, message: streamBodyMessage };
  }
  const { event } = target;
  const unreadable = unreadableMessage(event);
  if (unreadable !== undefined) {
    return { ok: false, message: unreadable };
  }
  const segments = event.kind === 'text' ? [] : input.segments;
  if (stream === undefined || !hasPath(event.value, segments)) {
    return { ok: false, message: noValueMessage };
  }
  const condition = eventCondition(event.value, event.sse, stream.typeFields);
  let parsed;
  if (condition !== undefined) {
    const result = parseExpression(conditionText(condition), 'condition');
    if (!result.ok) {
      return { ok: false, message: invalidMessage };
    }
    parsed = result.expr;
  }
  const counted = await countOccurrence({
    events: stream.events,
    index: event.index,
    condition: parsed,
    label:
      condition?.kind === 'field' && condition.field === stream.typeFields[0]
        ? stream.events.summary(event.index)?.label
        : undefined,
    signal,
    clock: input.clock,
  });
  if (!counted.ok) {
    return counted.reason === 'cancelled'
      ? { ok: false, cancelled: true }
      : { ok: false, message: goneMessage(event.index) };
  }
  return finish(
    captureExpression({ kind: 'event', occurrence: counted.occurrence, condition }, segments),
    segments,
    condition,
    taken,
  );
}
