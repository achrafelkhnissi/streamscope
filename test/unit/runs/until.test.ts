import { describe, expect, it } from 'vitest';
import type { Expr } from '../../../src/expressions/ast';
import type { JsonValue, StreamEvent } from '../../../src/events/model';
import { parseExpression } from '../../../src/expressions/parse';
import { parseHttpFile } from '../../../src/http-file/parse';
import { UntilWatch, untilCondition } from '../../../src/runs/until';

function condition(text: string): Expr {
  const parsed = parseExpression(text, 'condition');
  if (!parsed.ok) {
    throw new Error(`${text}: ${parsed.error.message}`);
  }
  return parsed.expr;
}

function event(value: JsonValue, overrides: Partial<StreamEvent> = {}): StreamEvent {
  return {
    index: 1,
    time: 0,
    offset: 0,
    length: 16,
    line: 1,
    kind: 'json',
    value,
    label: undefined,
    sse: undefined,
    marker: undefined,
    error: undefined,
    unterminated: false,
    ...overrides,
  };
}

describe('UntilWatch', () => {
  it('matches a json event by its fields and a text event by @', () => {
    const fields = new UntilWatch(condition('type == "DONE"'));
    expect(fields.test(event({ type: 'STEP' }))).toBe('no-match');
    expect(fields.test(event({ type: 'DONE' }))).toBe('match');

    const text = new UntilWatch(condition('@ contains "[DONE]"'));
    expect(text.test(event('more', { kind: 'text' }))).toBe('no-match');
    expect(text.test(event('[DONE]', { kind: 'text' }))).toBe('match');
  });

  it('matches an SSE event by @sse.event', () => {
    const watch = new UntilWatch(condition('@sse.event == "done"'));
    const sse = { event: 'done', id: undefined, retry: undefined };
    expect(watch.test(event({ n: 1 }, { sse: { ...sse, event: 'step' } }))).toBe('no-match');
    expect(watch.test(event({ n: 2 }, { sse }))).toBe('match');
  });

  it('never matches malformed, oversize or comment events', () => {
    const watch = new UntilWatch(condition('type == "DONE"'));
    for (const kind of ['malformed', 'oversize', 'comment'] as const) {
      expect(watch.test(event({ type: 'DONE' }, { kind }))).toBe('no-match');
    }
  });

  it('reports too-much-work for a condition over 500,000 units', () => {
    const sevens = Array<string>(1_300).fill('7').join(',');
    const watch = new UntilWatch(condition(`items[?@ in [${sevens}]]`));
    const items = [...Array<number>(400).fill(0), 7];
    expect(watch.test(event({ items }))).toBe('too-much-work');
    expect(watch.test(event({ items: [7] }))).toBe('match');
  });

  it('takes the last # @until line of a request', () => {
    const file = parseHttpFile(
      ['# @until type == "A"', '# @until type == "B"', 'GET https://example.test/'].join('\n'),
    );
    const request = file.requests[0];
    if (request === undefined) {
      throw new Error('no request');
    }
    const parsed = untilCondition(request);
    expect(parsed).toBeDefined();
    const watch = new UntilWatch(parsed as Expr);
    expect(watch.test(event({ type: 'A' }))).toBe('no-match');
    expect(watch.test(event({ type: 'B' }))).toBe('match');

    const plain = parseHttpFile('GET https://example.test/').requests[0];
    expect(plain === undefined ? 'missing' : untilCondition(plain)).toBeUndefined();
  });
});
