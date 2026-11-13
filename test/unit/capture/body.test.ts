import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  captureChildren,
  childTimeLimitMs,
  evaluateBodyExpressions,
  evaluateJobs,
  type BodyJob,
  type BodySubject,
} from '../../../src/capture/body';
import type { CaptureDefinition } from '../../../src/capture/tracker';
import { parseExpression } from '../../../src/expressions/parse';
import type { Outcome } from '../../../src/expressions/evaluate';
import { insertText } from '../../../src/expressions/insert';
import { expectNoChild, missingWorker, useCaptureWorker } from './worker';

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

function job(name: string, text: string): BodyJob {
  const { expression } = capture(name, text);
  return { name, expression, text, known: new Map() };
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

  it('kills a child that hangs after the time limit and fails its captures', async () => {
    const hanging = files().script('hanging', 'setInterval(() => undefined, 1000);');
    const started = performance.now();

    const outcomes = await evaluateBodyExpressions(
      jsonBody(2 * mebibyte),
      'application/json',
      [capture('id', 'body.items[1].id'), capture('query', 'jsonpath("$.items[1].id")')],
      hanging,
      { timeLimitMs: 300 },
    );

    expect(performance.now() - started).toBeGreaterThanOrEqual(290);
    expect(outcomes.get('id')).toEqual({ present: false, reason: bodyLimit });
    expect(outcomes.get('query')).toEqual({ present: false, reason: jsonPathLimit });
    await expectNoChild();
  });

  it('fails the captures of a child that exits, throws or cannot start, and leaves no child', async () => {
    const scripts = [
      files().script('exits', 'process.exit(0);'),
      files().script('throws', "throw new Error('synthetic child failure');"),
      missingWorker,
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
    await expectNoChild();
  });

  it('keeps the answers a child sent before it was killed', async () => {
    const partial = files().script(
      'partial',
      [
        "process.once('message', () => {",
        "  process.send({ name: 'id', outcome: { present: true, value: 1, path: 'items[1].id' } });",
        '  setInterval(() => undefined, 1000);',
        '});',
      ].join('\n'),
    );

    const outcomes = await evaluateBodyExpressions(
      jsonBody(2 * mebibyte),
      'application/json',
      [capture('id', 'body.items[1].id'), capture('query', 'jsonpath("$.items[1].id")')],
      partial,
      { timeLimitMs: 300 },
    );

    expect(outcomes.get('id')).toEqual({ present: true, value: 1, path: 'items[1].id' });
    expect(outcomes.get('query')).toEqual({ present: false, reason: jsonPathLimit });
    await expectNoChild();
  });

  it('lets the child read a large body from its file', async () => {
    const body = jsonBody(2 * mebibyte);
    const folder = mkdtempSync(path.join(tmpdir(), 'streamscope-body-file-'));
    const whole = path.join(folder, 'whole.spill');
    const short = path.join(folder, 'short.spill');
    writeFileSync(whole, body);
    writeFileSync(short, body.subarray(0, mebibyte));
    const read = async (file: string): Promise<ReadonlyMap<string, Outcome>> =>
      new Map(
        (
          await evaluateJobs(
            { kind: 'file', path: file, length: body.length, contentType: 'application/json' },
            [job('id', 'body.items[1].id'), job('query', 'jsonpath("$.items[2].id")')],
            files().worker,
          )
        ).map(([done, outcome]) => [done.name, outcome]),
      );

    try {
      const outcomes = await read(whole);
      const truncated = await read(short);
      const missing = await read(path.join(folder, 'missing.spill'));

      expect(outcomes.get('id')).toEqual({ present: true, value: 1, path: 'items[1].id' });
      expect(outcomes.get('query')).toEqual({ present: true, value: 2, path: '$.items[2].id' });
      for (const outcomes of [truncated, missing]) {
        expect(outcomes.get('id')).toEqual({
          present: false,
          reason: 'the body is no longer available',
        });
        expect(outcomes.get('query')).toEqual({
          present: false,
          reason: 'the body is no longer available',
        });
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('sends a file body to the child by its path and other bodies by their bytes', async () => {
    const echo = files().script(
      'echo',
      [
        'const holdsBytes = (value) =>',
        '  value instanceof Uint8Array ||',
        '  (Array.isArray(value) ? value.some(holdsBytes) :',
        "    value !== null && typeof value === 'object' && !(value instanceof Map) && Object.values(value).some(holdsBytes));",
        "process.once('message', (message) => {",
        '  for (const job of message.jobs) {',
        '    const value = { kind: message.subject.kind, fields: Object.keys(message.subject).sort(), bytes: holdsBytes(message) };',
        "    process.send({ name: job.name, outcome: { present: true, value, path: '' } });",
        '  }',
        '});',
      ].join('\n'),
    );
    const sent = async (subject: Parameters<typeof evaluateJobs>[0]): Promise<unknown> => {
      const [answer] = await evaluateJobs(subject, [job('id', 'body.items[1].id')], echo);
      return answer?.[1].present === true ? answer[1].value : answer?.[1];
    };

    expect(
      await sent({
        kind: 'file',
        path: '/synthetic/spill/body.spill',
        length: 3 * mebibyte,
        contentType: 'application/json',
      }),
    ).toEqual({ kind: 'file', fields: ['contentType', 'kind', 'length', 'path'], bytes: false });
    expect(
      await sent({ kind: 'body', bytes: jsonBody(2 * mebibyte), contentType: 'application/json' }),
    ).toEqual({ kind: 'body', fields: ['bytes', 'contentType', 'kind'], bytes: true });
    await expectNoChild();
  });
});

describe('capture children', () => {
  const files = useCaptureWorker();
  const subject: BodySubject = {
    kind: 'body',
    bytes: encoder.encode('{"a":1}'),
    contentType: 'application/json',
  };
  const cancelled = { present: false, reason: 'evaluating the capture was cancelled' };
  const answering = (name: string, delayMs: number): string =>
    files().script(
      name,
      [
        "process.once('message', (message) => setTimeout(() => {",
        '  for (const job of message.jobs) {',
        "    process.send({ name: job.name, outcome: { present: true, value: 'answered', path: '' } });",
        '  }',
        `}, ${String(delayMs)}));`,
      ].join('\n'),
    );
  const hanging = (): string => files().script('hanging', 'setInterval(() => undefined, 1000);');

  it('the default limit is 5,000 ms', () => {
    expect(childTimeLimitMs).toBe(5000);
  });

  it('runs at most two children at once', async () => {
    const slow = answering('slow', 150);
    let running = 0;
    let waiting = 0;
    let processes = 0;
    const sampler = setInterval(() => {
      running = Math.max(running, captureChildren.running);
      waiting = Math.max(waiting, captureChildren.waiting);
      processes = Math.max(
        processes,
        process.getActiveResourcesInfo().filter((resource) => resource === 'ProcessWrap').length,
      );
    }, 2);

    try {
      const answers = await Promise.all(
        Array.from({ length: 5 }, (_, at) =>
          evaluateJobs(subject, [job(`id${String(at)}`, 'jsonpath("$.a")')], slow),
        ),
      );

      expect(answers.map((answer) => answer[0]?.[1])).toEqual(
        Array.from({ length: 5 }, () => ({ present: true, value: 'answered', path: '' })),
      );
    } finally {
      clearInterval(sampler);
    }

    expect(running).toBe(2);
    expect(waiting).toBe(3);
    expect(processes).toBeLessThanOrEqual(2);
    expect(captureChildren.running).toBe(0);
    expect(captureChildren.waiting).toBe(0);
    await expectNoChild();
  });

  it('a queued job starts when a running one ends, and its limit starts with its child', async () => {
    const quick = answering('quick', 0);
    const started = performance.now();
    const blockers = [0, 1].map(() =>
      evaluateJobs(subject, [job('blocked', 'jsonpath("$.a")')], hanging(), { timeLimitMs: 300 }),
    );
    const queued = evaluateJobs(subject, [job('queued', 'jsonpath("$.a")')], quick, {
      timeLimitMs: 300,
    });

    expect(captureChildren.waiting).toBe(1);
    const [answer] = await queued;
    const waited = performance.now() - started;
    await Promise.all(blockers);

    expect(answer?.[1]).toEqual({ present: true, value: 'answered', path: '' });
    expect(waited).toBeGreaterThanOrEqual(290);
    await expectNoChild();
  });

  it('a cancelled queued job never starts a child', async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'streamscope-children-'));
    const marker = path.join(folder, 'started');
    const marking = files().script(
      'marking',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, ''); setInterval(() => undefined, 1000);`,
    );
    const controller = new AbortController();
    const aborted = new AbortController();
    aborted.abort();

    try {
      const started = performance.now();
      const blockers = [0, 1].map(() =>
        evaluateJobs(subject, [job('blocked', 'jsonpath("$.a")')], hanging(), {
          timeLimitMs: 300,
        }),
      );
      const queued = evaluateJobs(subject, [job('queued', 'jsonpath("$.a")')], marking, {
        signal: controller.signal,
      });
      const never = evaluateJobs(subject, [job('never', 'jsonpath("$.a")')], marking, {
        signal: aborted.signal,
      });
      expect(captureChildren.waiting).toBe(1);
      controller.abort();
      const [answer] = await queued;
      const [refused] = await never;

      expect(performance.now() - started).toBeLessThan(250);
      expect(answer?.[1]).toEqual(cancelled);
      expect(refused?.[1]).toEqual(cancelled);
      expect(captureChildren.waiting).toBe(0);
      await Promise.all(blockers);
      expect(existsSync(marker)).toBe(false);
      await expectNoChild();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('kills the child of a running job whose signal aborts', async () => {
    const controller = new AbortController();
    const started = performance.now();
    const running = evaluateJobs(subject, [job('query', 'jsonpath("$.a")')], hanging(), {
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 100);

    const [answer] = await running;

    expect(performance.now() - started).toBeLessThan(2000);
    expect(answer?.[1]).toEqual(cancelled);
    expect(captureChildren.running).toBe(0);
    await expectNoChild();
  });
});
