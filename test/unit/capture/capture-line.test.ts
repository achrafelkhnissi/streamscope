import { describe, expect, it } from 'vitest';
import {
  captureExpression,
  conditionText,
  eventCondition,
  parseCaptureNameInput,
  suggestedCaptureName,
  type EventCondition,
} from '../../../src/capture/capture-line';
import type { Value } from '../../../src/expressions/ast';
import { evaluate, holds } from '../../../src/expressions/evaluate';
import { captureLine } from '../../../src/http-file/capture-placement';
import { parseExpression } from '../../../src/expressions/parse';

const runStarted: EventCondition = { kind: 'field', field: 'type', value: 'RUN_STARTED' };
const invisible = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function built(result: ReturnType<typeof captureExpression>): string {
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.text;
}

function bodyValue(text: string, body: Value): unknown {
  const parsed = parseExpression(text, 'capture');
  if (!parsed.ok) {
    throw new Error(`${text}: ${parsed.error.message}`);
  }
  const outcome = evaluate(parsed.expr, {
    value: (node) =>
      node.kind === 'source' && node.name === 'body'
        ? { present: true, value: body, path: 'body' }
        : { present: false, reason: 'not the body' },
  });
  return outcome.present ? outcome.value : outcome.reason;
}

function conditionHolds(
  condition: EventCondition,
  value: Value,
  sse?: { event?: string },
): boolean {
  const parsed = parseExpression(conditionText(condition), 'condition');
  if (!parsed.ok) {
    throw new Error(`${conditionText(condition)}: ${parsed.error.message}`);
  }
  return holds(parsed.expr, { value, sse, malformed: false });
}

describe('captureExpression', () => {
  it('builds first and nth expressions with the condition and path', () => {
    expect(
      built(
        captureExpression({ kind: 'event', occurrence: 1, condition: runStarted }, ['threadId']),
      ),
    ).toBe('first(type == "RUN_STARTED").threadId');
    expect(
      built(
        captureExpression({ kind: 'event', occurrence: 3, condition: runStarted }, [
          'result',
          'ids',
          1,
        ]),
      ),
    ).toBe('nth(3, type == "RUN_STARTED").result.ids[1]');
    expect(
      built(captureExpression({ kind: 'event', occurrence: 1, condition: undefined }, [])),
    ).toBe('first()');
    expect(
      built(captureExpression({ kind: 'event', occurrence: 4, condition: undefined }, [])),
    ).toBe('nth(4)');
    expect(
      built(
        captureExpression(
          { kind: 'event', occurrence: 1, condition: { kind: 'sse', value: 'message' } },
          ['id'],
        ),
      ),
    ).toBe('first(@sse.event == "message").id');
    expect(built(captureExpression({ kind: 'body' }, ['items', 0, 'id']))).toBe('body.items[0].id');
    expect(built(captureExpression({ kind: 'body' }, []))).toBe('body');
  });

  it('writes keys that are not plain identifiers as bracketed strings', () => {
    const keys = [
      'true',
      'in',
      'a.b',
      '',
      '__proto__',
      '0',
      'has space',
      'é',
      'x‮y',
      'x y',
      'x\u0085y',
      'zero​width',
      '\ud800',
      'tab\there',
      'quote"and\\slash',
    ];
    for (const key of keys) {
      const body = Object.defineProperty({}, key, {
        value: 'v',
        enumerable: true,
      }) as Value;
      const text = built(captureExpression({ kind: 'body' }, [key]));
      expect(text, JSON.stringify(key)).not.toMatch(invisible);
      expect(bodyValue(text, body), text).toBe('v');
    }
    expect(built(captureExpression({ kind: 'body' }, ['$id', '_a1', 'first', 'body']))).toBe(
      'body.$id._a1.first.body',
    );
  });

  it('writes a non-identifier type field through @', () => {
    const condition: EventCondition = { kind: 'field', field: 'event-type', value: 'A' };
    expect(built(captureExpression({ kind: 'event', occurrence: 1, condition }, []))).toBe(
      'first(@["event-type"] == "A")',
    );
    expect(conditionHolds(condition, { 'event-type': 'A' })).toBe(true);
    expect(conditionHolds(condition, { 'event-type': 'B' })).toBe(false);
    const keyword: EventCondition = { kind: 'field', field: 'in', value: 'x' };
    expect(conditionText(keyword)).toBe('@["in"] == "x"');
    expect(conditionHolds(keyword, { in: 'x' })).toBe(true);
  });

  it('keeps every digit of an integer discriminator', () => {
    const condition: EventCondition = {
      kind: 'field',
      field: 'type',
      value: 12345678901234567890n,
    };
    expect(conditionText(condition)).toBe('type == 12345678901234567890');
    expect(conditionHolds(condition, { type: 12345678901234567890n })).toBe(true);
    expect(conditionHolds(condition, { type: 12345678901234567891n })).toBe(false);
    const decimal: EventCondition = { kind: 'field', field: 'type', value: -1.5 };
    expect(conditionHolds(decimal, { type: -1.5 })).toBe(true);
  });

  it('escapes invisible characters in a discriminator', () => {
    const condition: EventCondition = { kind: 'field', field: 'type', value: 'A‮B ' };
    expect(conditionText(condition)).not.toMatch(invisible);
    expect(conditionHolds(condition, { type: 'A‮B ' })).toBe(true);
    const sse: EventCondition = { kind: 'sse', value: 'x\u0000y' };
    expect(conditionText(sse)).not.toMatch(invisible);
    expect(conditionHolds(sse, {}, { event: 'x\u0000y' })).toBe(true);
  });

  it('picks the discriminator the way eventLabel does', () => {
    const fields = ['type', 'event'];
    expect(eventCondition({ type: '', event: 'A' }, undefined, fields)).toEqual({
      kind: 'field',
      field: 'event',
      value: 'A',
    });
    expect(eventCondition({ type: 5 }, undefined, fields)).toEqual({
      kind: 'field',
      field: 'type',
      value: 5,
    });
    expect(eventCondition({ type: true, event: 'B' }, undefined, fields)).toEqual({
      kind: 'field',
      field: 'event',
      value: 'B',
    });
    const sse = { event: 'x', id: undefined, retry: undefined };
    expect(eventCondition({}, sse, fields)).toEqual({ kind: 'sse', value: 'x' });
    expect(eventCondition('text', sse, fields)).toEqual({ kind: 'sse', value: 'x' });
    expect(eventCondition({}, undefined, fields)).toBeUndefined();
    expect(eventCondition([{ type: 'A' }], undefined, fields)).toBeUndefined();
  });

  it('refuses an expression over 4,096 characters', () => {
    expect(captureExpression({ kind: 'body' }, ['k'.repeat(4_100)])).toEqual({
      ok: false,
      message: 'The path to this value is too long for a capture (more than 4,096 characters).',
    });
    const longest = built(captureExpression({ kind: 'body' }, ['k'.repeat(4_091)]));
    expect(longest.length).toBe(4_096);
  });
});

describe('suggestedCaptureName', () => {
  it('suggests a name from the path, the discriminator or "value"', () => {
    const none = new Set<string>();
    expect(suggestedCaptureName(['threadId'], runStarted, none)).toBe('threadId');
    expect(suggestedCaptureName(['message_id'], undefined, none)).toBe('messageId');
    expect(suggestedCaptureName(['x-session-token'], undefined, none)).toBe('xSessionToken');
    expect(suggestedCaptureName(['ThreadId'], undefined, none)).toBe('threadId');
    expect(suggestedCaptureName(['items', 0], undefined, none)).toBe('items');
    expect(suggestedCaptureName([], runStarted, none)).toBe('runStarted');
    expect(suggestedCaptureName([0], { kind: 'sse', value: 'message' }, none)).toBe('message');
    expect(suggestedCaptureName(['2fa'], undefined, none)).toBe('_2fa');
    expect(suggestedCaptureName(['…'], undefined, none)).toBe('value');
    expect(suggestedCaptureName([], undefined, none)).toBe('value');
    expect(suggestedCaptureName(['a'.repeat(100)], undefined, none)).toBe('a'.repeat(64));
    expect(suggestedCaptureName(['threadId'], undefined, new Set(['threadId', 'threadId2']))).toBe(
      'threadId3',
    );
  });
});

describe('captureLine', () => {
  it('writes the directive with the marker and the secret keyword', () => {
    expect(captureLine('#', 'threadId', false, 'first().threadId')).toBe(
      '# @capture threadId = first().threadId',
    );
    expect(captureLine('//', 'token', true, 'body.token')).toBe(
      '// @capture secret token = body.token',
    );
  });
});

describe('parseCaptureNameInput', () => {
  it('reads secret from the prefix or a credential-looking name', () => {
    expect(parseCaptureNameInput('secret runId')).toEqual({ name: 'runId', secret: true });
    expect(parseCaptureNameInput('  secret   runId ')).toEqual({ name: 'runId', secret: true });
    expect(parseCaptureNameInput('accessToken')).toEqual({ name: 'accessToken', secret: true });
    expect(parseCaptureNameInput('threadId')).toEqual({ name: 'threadId', secret: false });
    expect(parseCaptureNameInput('secret')).toEqual({ name: 'secret', secret: true });
    expect(parseCaptureNameInput('_a1')).toEqual({ name: '_a1', secret: false });
    expect(parseCaptureNameInput('2x')).toBeUndefined();
    expect(parseCaptureNameInput('a b')).toBeUndefined();
    expect(parseCaptureNameInput('a$')).toBeUndefined();
    expect(parseCaptureNameInput('')).toBeUndefined();
  });
});
