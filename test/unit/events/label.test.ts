import { describe, expect, it } from 'vitest';
import { eventLabel } from '../../../src/events/label';
import type { SseFields } from '../../../src/events/model';

const typeFields = ['type', 'event', 'object'] as const;

function sseWithEvent(event: string | undefined): SseFields {
  return { event, id: undefined, retry: undefined };
}

describe('eventLabel', () => {
  it('uses the first configured type field', () => {
    expect(eventLabel({ type: 'RUN_STARTED', threadId: 'thread-1' }, undefined, typeFields)).toBe(
      'RUN_STARTED',
    );
    expect(
      eventLabel({ object: 'chat.completion.chunk', event: 'delta' }, undefined, typeFields),
    ).toBe('delta');
    expect(eventLabel({ type: 'second', event: 'first' }, undefined, ['event', 'type'])).toBe(
      'first',
    );
    expect(eventLabel({ type: 'RUN_STARTED' }, sseWithEvent('message'), typeFields)).toBe(
      'RUN_STARTED',
    );
  });

  it('labels numbers and bigints with their decimal digits', () => {
    expect(eventLabel({ type: 7 }, undefined, typeFields)).toBe('7');
    expect(eventLabel({ type: 0 }, undefined, typeFields)).toBe('0');
    expect(eventLabel({ type: -1.5 }, undefined, typeFields)).toBe('-1.5');
    expect(eventLabel({ type: 12345678901234567890n }, undefined, typeFields)).toBe(
      '12345678901234567890',
    );
  });

  it('falls back to the SSE event name', () => {
    expect(eventLabel({ delta: 'x' }, sseWithEvent('content_block_delta'), typeFields)).toBe(
      'content_block_delta',
    );
    expect(eventLabel('plain text', sseWithEvent('ping'), typeFields)).toBe('ping');
    expect(eventLabel(null, sseWithEvent('message_stop'), typeFields)).toBe('message_stop');
    expect(eventLabel([1, 2], sseWithEvent('batch'), typeFields)).toBe('batch');
    expect(eventLabel({ type: '' }, sseWithEvent('fallback'), typeFields)).toBe('fallback');
    expect(eventLabel({ type: 'ignored' }, sseWithEvent('fallback'), [])).toBe('fallback');
  });

  it('ignores empty strings, objects and missing fields', () => {
    expect(eventLabel({ type: '', event: 'second' }, undefined, typeFields)).toBe('second');
    expect(eventLabel({ type: { name: 'nested' }, event: 'second' }, undefined, typeFields)).toBe(
      'second',
    );
    expect(eventLabel({ type: ['a'], object: 'third' }, undefined, typeFields)).toBe('third');
    expect(eventLabel({ type: true, event: null, object: 'third' }, undefined, typeFields)).toBe(
      'third',
    );
    expect(eventLabel({ other: 'x' }, undefined, typeFields)).toBeUndefined();
    expect(eventLabel({ type: '', event: {} }, undefined, typeFields)).toBeUndefined();
    expect(eventLabel({}, undefined, typeFields)).toBeUndefined();
  });

  it('does not read fields from arrays or scalars', () => {
    expect(eventLabel([1, 2, 3], undefined, ['length'])).toBeUndefined();
    expect(eventLabel(['a'], undefined, ['0'])).toBeUndefined();
    expect(eventLabel('abc', undefined, ['length'])).toBeUndefined();
    expect(eventLabel('type', undefined, typeFields)).toBeUndefined();
    expect(eventLabel(42, undefined, typeFields)).toBeUndefined();
    expect(eventLabel(42n, undefined, typeFields)).toBeUndefined();
    expect(eventLabel(true, undefined, typeFields)).toBeUndefined();
    expect(eventLabel(null, undefined, typeFields)).toBeUndefined();
  });

  it('returns undefined without a type field or an SSE event name', () => {
    expect(eventLabel({ a: 1 }, sseWithEvent(undefined), typeFields)).toBeUndefined();
    expect(eventLabel({ type: 'ignored' }, undefined, [])).toBeUndefined();
  });

  it('cuts long labels to 100 characters', () => {
    expect(eventLabel({ type: 'a'.repeat(250) }, undefined, typeFields)).toBe('a'.repeat(100));
    expect(eventLabel({ type: 'b'.repeat(100) }, undefined, typeFields)).toBe('b'.repeat(100));
    expect(eventLabel({ type: 'c'.repeat(101) }, undefined, typeFields)).toBe('c'.repeat(100));
    expect(eventLabel({ type: 'short' }, undefined, typeFields)).toBe('short');
    expect(eventLabel({}, sseWithEvent('d'.repeat(250)), typeFields)).toBe('d'.repeat(100));
    expect(eventLabel({ type: BigInt('7'.repeat(150)) }, undefined, typeFields)).toBe(
      '7'.repeat(100),
    );
  });
});
