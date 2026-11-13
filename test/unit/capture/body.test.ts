import { describe, expect, it } from 'vitest';
import { evaluateBodyExpressions } from '../../../src/capture/body';
import type { CaptureDefinition } from '../../../src/capture/tracker';
import { parseExpression } from '../../../src/expressions/parse';
import { insertText } from '../../../src/expressions/insert';
import { missingWorker, useCaptureWorker } from './worker';

const encoder = new TextEncoder();
const mebibyte = 1_048_576;
const bodyLimit = 'evaluating the body took too long or used too much memory';
const jsonPathLimit = 'jsonpath() took too long or used too much memory';

function capture(name: string, text: string): CaptureDefinition {
  const parsed = parseExpression(text, 'capture');
  if (!parsed.ok) {
    throw new Error(`${text}: ${parsed.error.message}`);
  }
  return { name, secret: false, expression: parsed.expr, text };
}

function jsonBody(bytes: number): Uint8Array {
  const items = Array.from({ length: 100 }, (_, id) => ({ id, name: `item-${String(id)}` }));
  const empty = JSON.stringify({ items, padding: '' });
  const body = encoder.encode(JSON.stringify({ items, padding: 'x'.repeat(bytes - empty.length) }));
  expect(body.length).toBe(bytes);
  return body;
}

describe('evaluateBodyExpressions', () => {
  const files = useCaptureWorker();

  it('evaluates a 1 MiB body inline and a 2 MiB body in the worker', async () => {
    const definitions = [capture('id', 'body.items[2].id'), capture('last', 'body.items[-1].name')];
    const small = jsonBody(mebibyte);
    const large = jsonBody(2 * mebibyte);

    const inline = await evaluateBodyExpressions(
      small,
      'application/json',
      definitions,
      missingWorker,
    );
    const offThread = await evaluateBodyExpressions(
      large,
      'application/json',
      definitions,
      files().worker,
    );
    const withoutWorker = await evaluateBodyExpressions(
      large,
      'application/json',
      definitions,
      missingWorker,
    );

    expect(inline.get('id')).toEqual({ present: true, value: 2, path: 'items[2].id' });
    expect(inline.get('last')).toEqual({ present: true, value: 'item-99', path: 'items[-1].name' });
    expect(offThread.get('id')).toEqual({ present: true, value: 2, path: 'items[2].id' });
    expect(offThread.get('last')).toEqual({
      present: true,
      value: 'item-99',
      path: 'items[-1].name',
    });
    expect(withoutWorker.get('id')).toEqual({ present: false, reason: bodyLimit });
    expect(withoutWorker.get('last')).toEqual({ present: false, reason: bodyLimit });
  });

  it("keeps a large integer's digits from a body", async () => {
    const text = '{"id":12345678901234567890123,"price":1.50,"padding":"';
    const small = encoder.encode(`${text}"}`);
    const large = encoder.encode(`${text}${'x'.repeat(2 * mebibyte)}"}`);
    const definitions = [capture('id', 'body.id'), capture('price', 'body.price')];

    for (const [body, worker] of [
      [small, missingWorker],
      [large, files().worker],
    ] as const) {
      const outcomes = await evaluateBodyExpressions(body, 'application/json', definitions, worker);
      const id = outcomes.get('id');

      expect(id).toEqual({ present: true, value: 12345678901234567890123n, path: 'id' });
      expect(id?.present === true && insertText(id.value, mebibyte)).toEqual({
        ok: true,
        text: '12345678901234567890123',
      });
      expect(outcomes.get('price')).toEqual({ present: true, value: 1.5, path: 'price' });
    }
  });

  it('a 50 MB body does not block the calling thread for more than 50 ms', async () => {
    const body = jsonBody(50_000_000);
    const definitions = [capture('id', 'body.items[3].id')];
    let longest = 0;
    let last = performance.now();
    const ticker = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
    }, 5);

    try {
      const started = performance.now();
      const evaluation = evaluateBodyExpressions(
        body,
        'application/json',
        definitions,
        files().worker,
      );
      longest = Math.max(longest, performance.now() - started);
      const outcomes = await evaluation;

      expect(outcomes.get('id')).toBeDefined();
    } finally {
      clearInterval(ticker);
    }

    expect(longest - 5).toBeLessThan(50);
  });

  it('runs jsonpath() in the worker whatever the body size', async () => {
    const body = encoder.encode('{"items":[{"id":"a-1"},{"id":"a-2"}]}');
    const definitions = [
      capture('one', 'jsonpath("$.items[1].id")'),
      capture('id', 'body.items[0].id'),
    ];

    const withoutWorker = await evaluateBodyExpressions(
      body,
      'application/json',
      definitions,
      missingWorker,
    );
    const withWorker = await evaluateBodyExpressions(
      body,
      'application/json',
      definitions,
      files().worker,
    );

    expect(withoutWorker.get('one')).toEqual({ present: false, reason: jsonPathLimit });
    expect(withoutWorker.get('id')).toEqual({ present: true, value: 'a-1', path: 'items[0].id' });
    expect(withWorker.get('one')).toEqual({
      present: true,
      value: 'a-2',
      path: '$.items[1].id',
    });
  });

  it('gives one jsonpath() node as a value, several as a list and none as missing', async () => {
    const body = encoder.encode(
      '{"items":[{"id":"a-1"},{"id":"a-2"}],"total":12345678901234567890}',
    );

    const outcomes = await evaluateBodyExpressions(
      body,
      'application/json',
      [
        capture('one', 'jsonpath("$.total")'),
        capture('several', 'jsonpath("$.items[*].id")'),
        capture('none', 'jsonpath("$.missing")'),
        capture('after', 'jsonpath("$.items[0]").name'),
        capture('invalid', 'jsonpath("$.items[")'),
      ],
      files().worker,
    );

    expect(outcomes.get('one')).toEqual({
      present: true,
      value: 12345678901234567890n,
      path: '$.total',
    });
    expect(outcomes.get('several')).toEqual({
      present: true,
      value: ['a-1', 'a-2'],
      path: '$.items[*].id',
    });
    expect(outcomes.get('none')).toEqual({
      present: false,
      reason: 'the body has no value at $.missing (the query matched nothing)',
    });
    expect(outcomes.get('after')).toEqual({
      present: false,
      reason: 'the body has no value at $.items[0].name ("name" is missing)',
    });
    expect(outcomes.get('invalid')).toEqual({
      present: false,
      reason: expect.stringMatching(/^invalid JSONPath: /) as unknown,
    });
  });

  it('names the body and the segment of a missing path', async () => {
    const outcomes = await evaluateBodyExpressions(
      encoder.encode('{"items":[1,2,3]}'),
      'application/json',
      [capture('item', 'body.items[5]'), capture('fallback', 'body.items[5] | default("none")')],
      missingWorker,
    );

    expect(outcomes.get('item')).toEqual({
      present: false,
      reason: 'the body has no value at items[5] (the list has 3 items)',
    });
    expect(outcomes.get('fallback')).toEqual({ present: true, value: 'none', path: '' });
  });

  it('reads JSON by its type or by its first character, and text otherwise', async () => {
    const read = async (body: string, contentType: string | undefined): Promise<unknown> => {
      const outcomes = await evaluateBodyExpressions(
        encoder.encode(body),
        contentType,
        [capture('body', 'body')],
        missingWorker,
      );
      const outcome = outcomes.get('body');
      return outcome?.present === true ? outcome.value : outcome;
    };

    expect(await read('  {"a":1}', 'text/plain')).toEqual({ a: 1 });
    expect(await read('[1,2]', undefined)).toEqual([1, 2]);
    expect(await read('"quoted"', 'application/problem+json')).toBe('quoted');
    expect(await read('42', 'Application/JSON; charset=utf-8')).toBe(42);
    expect(await read('42', 'text/plain')).toBe('42');
    expect(await read('{oops', 'application/json')).toBe('{oops');
    expect(await read('plain text', undefined)).toBe('plain text');
    expect(await read('﻿{"a":2}', 'application/json')).toEqual({ a: 2 });
  });

  it('decodes text with the charset of the Content-Type, and UTF-8 for an unknown one', async () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
    const utf8 = encoder.encode('café');
    const read = async (bytes: Uint8Array, contentType: string): Promise<unknown> => {
      const outcome = (
        await evaluateBodyExpressions(bytes, contentType, [capture('body', 'body')], missingWorker)
      ).get('body');
      return outcome?.present === true ? outcome.value : outcome;
    };

    expect(await read(latin1, 'text/plain; charset=ISO-8859-1')).toBe('café');
    expect(await read(latin1, 'text/plain; format=flowed; charset="iso-8859-1"')).toBe('café');
    expect(await read(utf8, 'text/plain; charset=x-synthetic-unknown')).toBe('café');
    expect(await read(utf8, 'text/plain')).toBe('café');
  });

  it('says what a body evaluation cannot read', async () => {
    const outcomes = await evaluateBodyExpressions(
      encoder.encode('{"a":1}'),
      'application/json',
      [capture('first', 'first(a == 1)'), capture('reply', 'text'), capture('code', 'status')],
      missingWorker,
    );

    expect(outcomes.get('first')).toEqual({
      present: false,
      reason: 'the response is not an event stream',
    });
    expect(outcomes.get('reply')).toEqual({
      present: false,
      reason: 'the response is not an event stream',
    });
    expect(outcomes.get('code')).toEqual({
      present: false,
      reason: 'status is not available to this evaluation',
    });
  });

  it('fails a value over 1 MiB in the worker instead of sending it back', async () => {
    const outcomes = await evaluateBodyExpressions(
      jsonBody(2 * mebibyte),
      'application/json',
      [capture('whole', 'body'), capture('id', 'body.items[1].id')],
      files().worker,
    );

    expect(outcomes.get('whole')).toEqual({
      present: false,
      reason: 'the value is larger than 1 MiB',
    });
    expect(outcomes.get('id')).toEqual({ present: true, value: 1, path: 'items[1].id' });
  });

  it('stops a worker that runs past 1 s', async () => {
    const hanging = files().script('hanging', 'setInterval(() => undefined, 1000);');
    const started = performance.now();

    const outcomes = await evaluateBodyExpressions(
      jsonBody(2 * mebibyte),
      'application/json',
      [capture('id', 'body.items[1].id'), capture('query', 'jsonpath("$.items[1].id")')],
      hanging,
    );

    expect(performance.now() - started).toBeGreaterThanOrEqual(990);
    expect(outcomes.get('id')).toEqual({ present: false, reason: bodyLimit });
    expect(outcomes.get('query')).toEqual({ present: false, reason: jsonPathLimit });
  });

  it('fails the captures of a worker that exits, throws or runs out of memory', async () => {
    const scripts = [
      files().script('exits', 'process.exit(0);'),
      files().script('throws', "throw new Error('synthetic worker failure');"),
      files().script(
        'allocates',
        'const kept = []; for (;;) { kept.push(new Array(1_000_000).fill(kept.length + 0.5)); }',
      ),
    ];

    for (const script of scripts) {
      const outcomes = await evaluateBodyExpressions(
        jsonBody(2 * mebibyte),
        'application/json',
        [capture('id', 'body.items[1].id'), capture('query', 'jsonpath("$.items[1].id")')],
        script,
      );

      expect(outcomes.get('id')).toEqual({ present: false, reason: bodyLimit });
      expect(outcomes.get('query')).toEqual({ present: false, reason: jsonPathLimit });
    }
  });

  it('keeps the answers a worker sent before it was stopped', async () => {
    const partial = files().script(
      'partial',
      [
        "const { parentPort } = require('node:worker_threads');",
        "parentPort.once('message', () => {",
        "  parentPort.postMessage({ name: 'id', outcome: { present: true, value: 1, path: 'items[1].id' } });",
        '  setInterval(() => undefined, 1000);',
        '});',
      ].join('\n'),
    );

    const outcomes = await evaluateBodyExpressions(
      jsonBody(2 * mebibyte),
      'application/json',
      [capture('id', 'body.items[1].id'), capture('query', 'jsonpath("$.items[1].id")')],
      partial,
    );

    expect(outcomes.get('id')).toEqual({ present: true, value: 1, path: 'items[1].id' });
    expect(outcomes.get('query')).toEqual({ present: false, reason: jsonPathLimit });
  });
});
