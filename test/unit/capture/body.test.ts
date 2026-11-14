import { fork } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  captureChildren,
  childTimeLimitMs,
  evaluateBodyExpressions,
  evaluateJobs,
  inlineBodyBytes,
  inlineDigitBodyBytes,
  jobEvaluator,
  sourceKey,
  valuesOnly,
  type BodyJob,
  type BodySubject,
  type Inserted,
  type WorkerRequest,
} from '../../../src/capture/body';
import { hostEvaluationUnits, TaskBudget } from '../../../src/capture/task-budget';
import type { CaptureDefinition } from '../../../src/capture/tracker';
import type { Value } from '../../../src/expressions/ast';
import { parseExpression, sourcesOf } from '../../../src/expressions/parse';
import { WorkBudget } from '../../../src/expressions/work';
import { fastestOf } from '../timing';
import {
  CountedBudget,
  expectNoChild,
  longestStall,
  missingWorker,
  recordingWorker,
  useCaptureWorker,
  type ChildRequest,
} from './worker';

const encoder = new TextEncoder();
const mebibyte = 1_048_576;
const bodyLimit = 'evaluating the body took too long or used too much memory';
const jsonPathLimit = 'jsonpath() took too long or used too much memory';
const largeInteger = '12345678901234567890';

function capture(name: string, text: string): CaptureDefinition {
  const parsed = parseExpression(text, 'capture');
  if (!parsed.ok) {
    throw new Error(`${text}: ${parsed.error.message}`);
  }
  return { name, secret: false, provenance: false, expression: parsed.expr, text };
}

function job(name: string, text: string): BodyJob {
  const { expression } = capture(name, text);
  return { name, expression, text, known: new Map(), collected: new Map() };
}

function found(text: string, path: string): Inserted {
  return { present: true, text, path };
}

function jsonBody(bytes: number): Uint8Array {
  const items = Array.from({ length: 100 }, (_, id) => ({ id, name: `item-${String(id)}` }));
  const empty = JSON.stringify({ items, padding: '' });
  const body = encoder.encode(JSON.stringify({ items, padding: 'x'.repeat(bytes - empty.length) }));
  expect(body.length).toBe(bytes);
  return body;
}

function zerosWithInteger(bytes: number): Uint8Array {
  const tail = `${largeInteger}]`;
  const zeros = Math.floor((bytes - 1 - tail.length) / 2);
  const body = encoder.encode(`[${'0,'.repeat(zeros)}${tail}`.padEnd(bytes, ' '));
  expect(body.length).toBe(bytes);
  return body;
}

describe('evaluateBodyExpressions', () => {
  const files = useCaptureWorker();

  it('evaluates a body of up to 256 KiB inline and a larger one in the child', async () => {
    const definitions = [capture('id', 'body.items[2].id'), capture('last', 'body.items[-1].name')];
    const small = jsonBody(inlineBodyBytes);
    const large = jsonBody(inlineBodyBytes + 1);

    const inline = await evaluateBodyExpressions(
      small,
      'application/json',
      definitions,
      missingWorker,
    );
    const inChild = await evaluateBodyExpressions(
      large,
      'application/json',
      definitions,
      files().worker,
    );
    const withoutChild = await evaluateBodyExpressions(
      large,
      'application/json',
      definitions,
      missingWorker,
    );

    expect(inlineBodyBytes).toBe(262_144);
    expect(inline.get('id')).toEqual(found('2', 'items[2].id'));
    expect(inline.get('last')).toEqual(found('item-99', 'items[-1].name'));
    expect(inChild.get('id')).toEqual(found('2', 'items[2].id'));
    expect(inChild.get('last')).toEqual(found('item-99', 'items[-1].name'));
    expect(withoutChild.get('id')).toEqual({ present: false, reason: bodyLimit });
    expect(withoutChild.get('last')).toEqual({ present: false, reason: bodyLimit });
  });

  it('a 1 MiB body with a large integer is evaluated in the child', async () => {
    const definitions = [capture('last', 'body[-1]')];
    const atLimit = zerosWithInteger(inlineDigitBodyBytes);
    const overLimit = zerosWithInteger(inlineDigitBodyBytes + 1);
    const mebibyteBody = zerosWithInteger(mebibyte);

    const inline = await evaluateBodyExpressions(
      atLimit,
      'application/json',
      definitions,
      missingWorker,
    );
    const over = await evaluateBodyExpressions(
      overLimit,
      'application/json',
      definitions,
      missingWorker,
    );
    const large = await evaluateBodyExpressions(
      mebibyteBody,
      'application/json',
      definitions,
      missingWorker,
    );
    const inChild = await evaluateBodyExpressions(
      mebibyteBody,
      'application/json',
      definitions,
      files().worker,
    );

    expect(inlineDigitBodyBytes).toBe(65_536);
    expect(inline.get('last')).toEqual(found(largeInteger, '[-1]'));
    expect(over.get('last')).toEqual({ present: false, reason: bodyLimit });
    expect(large.get('last')).toEqual({ present: false, reason: bodyLimit });
    expect(inChild.get('last')).toEqual(found(largeInteger, '[-1]'));
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

      expect(outcomes.get('id')).toEqual(found('12345678901234567890123', 'id'));
      expect(outcomes.get('price')).toEqual(found('1.5', 'price'));
    }
  });

  it('a 50 MB body does not block the calling thread', async () => {
    const body = jsonBody(50_000_000);

    const stallMs = await fastestOf(async () => {
      const { result, stallMs: ms } = await longestStall(() =>
        evaluateBodyExpressions(
          body,
          'application/json',
          [capture('id', 'body.items[3].id')],
          files().worker,
        ),
      );
      expect(result.get('id')).toEqual(found('3', 'items[3].id'));
      return ms;
    });

    expect(stallMs).toBeLessThan(100);
  });

  it('runs jsonpath() in the child whatever the body size', async () => {
    const body = encoder.encode('{"items":[{"id":"a-1"},{"id":"a-2"}]}');
    const definitions = [
      capture('one', 'jsonpath("$.items[1].id")'),
      capture('id', 'body.items[0].id'),
    ];

    const withoutChild = await evaluateBodyExpressions(
      body,
      'application/json',
      definitions,
      missingWorker,
    );
    const withChild = await evaluateBodyExpressions(
      body,
      'application/json',
      definitions,
      files().worker,
    );

    expect(withoutChild.get('one')).toEqual({ present: false, reason: jsonPathLimit });
    expect(withoutChild.get('id')).toEqual(found('a-1', 'items[0].id'));
    expect(withChild.get('one')).toEqual(found('a-2', '$.items[1].id'));
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

    expect(outcomes.get('one')).toEqual(found('12345678901234567890', '$.total'));
    expect(outcomes.get('several')).toEqual(found('["a-1","a-2"]', '$.items[*].id'));
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
    expect(outcomes.get('fallback')).toEqual(found('none', ''));
  });

  it('reads JSON by its type or by its first character, and text otherwise', async () => {
    const read = async (body: string, contentType: string | undefined): Promise<unknown> => {
      const outcomes = await evaluateBodyExpressions(
        encoder.encode(body),
        contentType,
        [capture('body', 'body | json')],
        missingWorker,
      );
      const outcome = outcomes.get('body');
      return outcome?.present === true ? outcome.text : outcome;
    };

    expect(await read('  {"a":1}', 'text/plain')).toBe('{"a":1}');
    expect(await read('[1,2]', undefined)).toBe('[1,2]');
    expect(await read('"quoted"', 'application/problem+json')).toBe('"quoted"');
    expect(await read('42', 'Application/JSON; charset=utf-8')).toBe('42');
    expect(await read('42', 'text/plain')).toBe('"42"');
    expect(await read('{oops', 'application/json')).toBe('"{oops"');
    expect(await read('plain text', undefined)).toBe('"plain text"');
    expect(await read('﻿{"a":2}', 'application/json')).toBe('{"a":2}');
  });

  it('decodes text with the charset of the Content-Type, and UTF-8 for an unknown one', async () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
    const utf8 = encoder.encode('café');
    const read = async (bytes: Uint8Array, contentType: string): Promise<unknown> => {
      const outcome = (
        await evaluateBodyExpressions(bytes, contentType, [capture('body', 'body')], missingWorker)
      ).get('body');
      return outcome?.present === true ? outcome.text : outcome;
    };

    expect(await read(latin1, 'text/plain; charset=ISO-8859-1')).toBe('café');
    expect(await read(latin1, 'text/plain; format=flowed; charset="iso-8859-1"')).toBe('café');
    expect(await read(utf8, 'text/plain; charset=x-synthetic-unknown')).toBe('café');
    expect(await read(utf8, 'text/plain')).toBe('café');
  });

  it('says what a body evaluation cannot read, and default(…) does not hide it', async () => {
    const outcomes = await evaluateBodyExpressions(
      encoder.encode('{"a":1}'),
      'application/json',
      [
        capture('first', 'first(a == 1)'),
        capture('fallback', 'first(a == 1).b | default("none")'),
        capture('reply', 'text'),
        capture('code', 'status'),
      ],
      missingWorker,
    );

    const notStream = { present: false, reason: 'the response is not an event stream' };
    expect(outcomes.get('first')).toEqual(notStream);
    expect(outcomes.get('fallback')).toEqual(notStream);
    expect(outcomes.get('reply')).toEqual(notStream);
    expect(outcomes.get('code')).toEqual({
      present: false,
      reason: 'status is not available to this evaluation',
    });
  });

  it('hands the in and regex filters over 256 KiB to the child, quickly', async () => {
    const numbers = Array<string>(1_300).fill('7').join(',');
    const zeros = encoder.encode(`[${'0,'.repeat(inlineBodyBytes / 2 - 2)}0]`);
    const strings = encoder.encode(
      `[${Array.from({ length: Math.floor(inlineBodyBytes / 43) }, () => `"${'a'.repeat(40)}"`).join(',')}]`,
    );
    const words = encoder.encode(
      `[${Array.from({ length: Math.floor(inlineBodyBytes / 9) }, (_, at) => `"w${String(at % 400).padStart(5, '0')}"`).join(',')}]`,
    );
    const wordList = Array.from(
      { length: 400 },
      (_, at) => `"x${String(at).padStart(5, '0')}"`,
    ).join(',');
    expect(zeros.length).toBeLessThanOrEqual(inlineBodyBytes);
    expect(strings.length).toBeLessThanOrEqual(inlineBodyBytes);
    expect(words.length).toBeLessThanOrEqual(inlineBodyBytes);

    for (const [body, text] of [
      [zeros, `body[?@ in [${numbers}]]`],
      [strings, 'body[?@ matches /([a-z]*){40}b/]'],
      [words, `body[?@ in [${wordList}]]`],
    ] as const) {
      const stallMs = await fastestOf(async () => {
        const { result, stallMs: ms } = await longestStall(() =>
          evaluateBodyExpressions(body, 'application/json', [capture('work', text)], missingWorker),
        );
        expect(result.get('work')).toEqual({ present: false, reason: bodyLimit });
        return ms;
      });

      expect(stallMs).toBeLessThan(100);
    }
  });

  it('leaves an ordinary filter over 256 KiB unaffected while the task has time left', async () => {
    const zeros = encoder.encode(`[${'0,'.repeat(inlineBodyBytes / 2 - 2)}0]`);

    const stallMs = await fastestOf(async () => {
      const { result, stallMs: ms } = await longestStall(() =>
        evaluateBodyExpressions(
          zeros,
          'application/json',
          [capture('zeros', 'body[?@ == 0] | json'), capture('count', 'body[*]')],
          files().worker,
          { taskBudget: new TaskBudget({ now: () => 0, nextTask: () => undefined }) },
        ),
      );
      expect(result.get('zeros')?.present).toBe(true);
      expect(result.get('count')?.present).toBe(true);
      return ms;
    });

    expect(stallMs).toBeLessThan(100);
  });

  it('resolves a body capture of 500,000 to 2,000,000 units in the child, as the host did with 2,000,000', async () => {
    const zeros = encoder.encode(`[${'0,'.repeat(inlineBodyBytes / 2 - 2)}0]`);
    const text = 'body[?@ == 0] | json';
    const twoMillionUnits = new WorkBudget({ units: 2_000_000 });
    const onHost = jobEvaluator(
      { kind: 'body', bytes: zeros, contentType: 'application/json' },
      valuesOnly,
    )(job('zeros', text), twoMillionUnits);
    expect(onHost.present).toBe(true);
    expect(twoMillionUnits.spent).toBeGreaterThan(500_000);
    expect(twoMillionUnits.spent).toBeLessThan(2_000_000);

    const stallMs = await fastestOf(async () => {
      const { result, stallMs: ms } = await longestStall(() =>
        evaluateBodyExpressions(
          zeros,
          'application/json',
          [capture('zeros', text)],
          files().worker,
        ),
      );
      expect(result.get('zeros')).toEqual(onHost);
      return ms;
    });
    const withoutChild = await evaluateBodyExpressions(
      zeros,
      'application/json',
      [capture('zeros', text)],
      missingWorker,
    );

    expect(stallMs).toBeLessThan(100);
    expect(withoutChild.get('zeros')).toEqual({ present: false, reason: bodyLimit });
    await expectNoChild();
  });

  it('evaluates a handed-off body capture once on the host and once in the child', async () => {
    const zeros = encoder.encode(`[${'0,'.repeat(inlineBodyBytes / 2 - 2)}0]`);
    const budget = new CountedBudget({ now: () => 0, nextTask: () => undefined });
    const worker = recordingWorker(files(), 'once-body');

    const outcomes = await evaluateBodyExpressions(
      zeros,
      'application/json',
      [capture('zeros', 'body[?@ == 0] | json')],
      worker.file,
      { taskBudget: budget },
    );

    expect(outcomes.get('zeros')?.present).toBe(true);
    expect(budget.entries).toBe(1);
    expect(budget.units).toBeGreaterThanOrEqual(hostEvaluationUnits);
    expect(budget.units).toBeLessThan(2 * hostEvaluationUnits);
    expect(worker.requests()).toEqual([
      { kind: 'body', path: null, query: null, bytes: zeros.length, jobs: ['zeros'] },
    ]);
    await expectNoChild();
  });

  it('sends a hand-off only the subject its jobs can use', async () => {
    const sevens = Array<string>(1_300).fill('7').join(',');
    const strings = Array<string>(1_000).fill('"7"').join(',');
    const headers: Value = Object.fromEntries(
      Array.from({ length: 600 }, (_, at) => [`x-synthetic-${String(at)}`, 'value']),
    );
    const knowing = (name: string, text: string, value: Value): BodyJob => {
      const unknown = job(name, text);
      const [node] = sourcesOf(unknown.expression);
      if (node === undefined) {
        throw new Error(`${text} reads no source`);
      }
      return {
        ...unknown,
        known: new Map([[sourceKey(node), { present: true, value, path: '' }]]),
      };
    };
    const event = knowing('event', `first(type == "A").items[?@ in [${sevens}]] | json`, {
      type: 'A',
      items: [...Array<number>(1_000).fill(0), 7],
    });
    const headerFilter = knowing('headers', `headers[?@ in [${strings}]]`, headers);
    const cases: { name: string; subject: BodySubject; jobs: BodyJob[]; sent: ChildRequest[] }[] = [
      {
        name: 'events',
        subject: {
          kind: 'events',
          format: 'ndjson',
          path: '/synthetic/spill/stream.spill',
          query: { kind: 'values', values: [{ id: 'a-1' }] },
        },
        jobs: [event, job('query', 'jsonpath("$[0].id")')],
        sent: [
          { kind: 'events', path: null, query: null, bytes: null, jobs: ['event'] },
          {
            kind: 'events',
            path: '/synthetic/spill/stream.spill',
            query: 'values',
            bytes: null,
            jobs: ['query'],
          },
        ],
      },
      {
        name: 'file',
        subject: {
          kind: 'file',
          path: '/synthetic/spill/body.spill',
          length: 3 * mebibyte,
          contentType: 'application/json',
        },
        jobs: [headerFilter],
        sent: [{ kind: 'body', path: null, query: null, bytes: 0, jobs: ['headers'] }],
      },
      {
        name: 'body',
        subject: {
          kind: 'body',
          bytes: encoder.encode('{"a":1}'),
          contentType: 'application/json',
        },
        jobs: [headerFilter],
        sent: [{ kind: 'body', path: null, query: null, bytes: 0, jobs: ['headers'] }],
      },
    ];

    for (const { name, subject, jobs, sent } of cases) {
      const worker = recordingWorker(files(), `subject-${name}`);

      const outcomes = new Map(
        (await evaluateJobs(subject, jobs, worker.file)).map(([done, outcome]) => [
          done.name,
          outcome,
        ]),
      );

      expect(
        worker
          .requests()
          .toSorted((left, right) => left.jobs.join().localeCompare(right.jobs.join())),
        name,
      ).toEqual(sent);
      for (const done of jobs) {
        expect(outcomes.get(done.name)?.present, `${name} ${done.name}`).toBe(true);
      }
    }
    await expectNoChild();
  });

  it('applies default(…) to the value the child gives a handed-off capture', async () => {
    const sevens = Array<string>(1_300).fill('7').join(',');
    const body = encoder.encode(JSON.stringify({ items: Array<number>(1_000).fill(0) }));
    const definitions = [
      capture('kept', `body.items[?@ in [${sevens}]] | default("none")`),
      capture('replaced', `body.items[?@ in [${sevens}]][0] | default("none")`),
    ];

    const inChild = await evaluateBodyExpressions(
      body,
      'application/json',
      definitions,
      files().worker,
    );
    const withoutChild = await evaluateBodyExpressions(
      body,
      'application/json',
      definitions,
      missingWorker,
    );

    expect(inChild.get('kept')).toEqual(found('[]', 'items[?…]'));
    expect(inChild.get('replaced')).toEqual(found('none', ''));
    expect(withoutChild.get('kept')).toEqual({ present: false, reason: bodyLimit });
    expect(withoutChild.get('replaced')).toEqual({ present: false, reason: bodyLimit });
    await expectNoChild();
  });

  it('fails a value over 1 MiB in the child', async () => {
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
    expect(outcomes.get('id')).toEqual(found('1', 'items[1].id'));
  });

  it('the child replies with text', async () => {
    const request: WorkerRequest = {
      subject: {
        kind: 'body',
        bytes: encoder.encode('{"items":[{"id":12345678901234567890}],"count":2}'),
        contentType: 'application/json',
      },
      jobs: [
        { name: 'items', text: 'body.items', known: new Map(), collected: new Map() },
        { name: 'count', text: 'jsonpath("$.count")', known: new Map(), collected: new Map() },
      ],
    };
    const child = fork(files().worker, [], {
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const replies: unknown[] = [];
    const answered = new Promise<void>((resolve) => {
      child.on('message', (reply) => {
        replies.push(reply);
        if (replies.length === 2) {
          resolve();
        }
      });
    });
    child.send(request);

    await answered;
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('close', resolve));

    expect(replies).toEqual([
      { name: 'items', result: found('[{"id":12345678901234567890}]', 'items') },
      { name: 'count', result: found('2', '$.count') },
    ]);
    expect(JSON.stringify(replies)).not.toContain('"value"');
    await expectNoChild();
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
        "  process.send({ name: 'id', result: { present: true, text: '1', path: 'items[1].id' } });",
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

    expect(outcomes.get('id')).toEqual(found('1', 'items[1].id'));
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
    const read = async (file: string): Promise<ReadonlyMap<string, Inserted>> =>
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

      expect(outcomes.get('id')).toEqual(found('1', 'items[1].id'));
      expect(outcomes.get('query')).toEqual(found('2', '$.items[2].id'));
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
        '    const text = JSON.stringify({ kind: message.subject.kind, fields: Object.keys(message.subject).sort(), bytes: holdsBytes(message) });',
        "    process.send({ name: job.name, result: { present: true, text, path: '' } });",
        '  }',
        '});',
      ].join('\n'),
    );
    const sent = async (subject: BodySubject): Promise<unknown> => {
      const [answer] = await evaluateJobs(subject, [job('id', 'body.items[1].id')], echo);
      return answer?.[1].present === true ? JSON.parse(answer[1].text) : answer?.[1];
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
        "    process.send({ name: job.name, result: { present: true, text: 'answered', path: '' } });",
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
        Array.from({ length: 5 }, () => found('answered', '')),
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

    expect(answer?.[1]).toEqual(found('answered', ''));
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

    try {
      const answeredMs = await fastestOf(async () => {
        const controller = new AbortController();
        const aborted = new AbortController();
        aborted.abort();
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
        const ms = performance.now() - started;

        expect(answer?.[1]).toEqual(cancelled);
        expect(refused?.[1]).toEqual(cancelled);
        expect(captureChildren.waiting).toBe(0);
        await Promise.all(blockers);
        expect(existsSync(marker)).toBe(false);
        await expectNoChild();
        return ms;
      });

      expect(answeredMs).toBeLessThan(250);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('kills the child of a running job whose signal aborts', async () => {
    const answeredMs = await fastestOf(async () => {
      const controller = new AbortController();
      const started = performance.now();
      const running = evaluateJobs(subject, [job('query', 'jsonpath("$.a")')], hanging(), {
        signal: controller.signal,
      });
      setTimeout(() => {
        controller.abort();
      }, 100);

      const [answer] = await running;
      const ms = performance.now() - started;

      expect(answer?.[1]).toEqual(cancelled);
      expect(captureChildren.running).toBe(0);
      await expectNoChild();
      return ms;
    });

    expect(answeredMs).toBeLessThan(2000);
  });
});

describe('host work on an inline body', () => {
  const zeros = encoder.encode(`[${'0,'.repeat(inlineBodyBytes / 2 - 2)}0]`);

  function chain(operand: string): string {
    const parts = [operand];
    while ((parts.length + 1) * (operand.length + 2) < 4_000) {
      parts.push(operand);
    }
    return parts.join('||');
  }

  function objectBody(): Uint8Array {
    const members: string[] = [];
    let size = 8;
    for (let at = 0; size + 12 < inlineBodyBytes; at += 1) {
      const member = `"${at.toString(36)}":0`;
      members.push(member);
      size += member.length + 1;
    }
    return encoder.encode(`{"o":{${members.join(',')}}}`);
  }

  function stallOf(body: Uint8Array, text: string): Promise<number> {
    expect(body.length).toBeLessThanOrEqual(inlineBodyBytes);
    expect(text.length).toBeLessThanOrEqual(4_096);
    return fastestOf(async () => {
      const { result, stallMs } = await longestStall(() =>
        evaluateBodyExpressions(body, 'application/json', [capture('work', text)], missingWorker),
      );
      const outcome = result.get('work');
      expect(['resolved', bodyLimit], text.slice(0, 40)).toContain(
        outcome?.present === true ? 'resolved' : outcome?.reason,
      );
      return stallMs;
    });
  }

  function differingLists(length: number): Uint8Array {
    const zeros = '0,'.repeat(length - 1);
    return encoder.encode(`{"a":[${zeros}0],"b":[${zeros}1]}`);
  }

  function differingObjects(count: number): Uint8Array {
    const members = Array.from({ length: count - 1 }, (_, at) => `"k${String(at)}":0`).join(',');
    return encoder.encode(`[{"a":{${members},"last":0},"b":{${members},"other":0}}]`);
  }

  it('a join chain over a list of one long list', async () => {
    const nested = encoder.encode(`[[${'0,'.repeat(inlineBodyBytes / 2 - 3)}0]]`);
    expect(await stallOf(nested, chain('(body|join(","))=="x"'))).toBeLessThan(100);
  });

  it('a contains chain over a 256 KiB string', async () => {
    const text = encoder.encode(`{"s":"${'a'.repeat(inlineBodyBytes - 8)}"}`);
    expect(await stallOf(text, chain('body.s contains "ab"'))).toBeLessThan(100);
  });

  it('a chain of default filters per item', async () => {
    const filters = '|default(0)'.repeat(371);
    expect(await stallOf(zeros, `body[?@${filters}]`)).toBeLessThan(100);
  });

  it('a chain of [*] over an object of many keys', async () => {
    expect(await stallOf(objectBody(), chain('body.o[*][0]==1'))).toBeLessThan(100);
  });

  it('a chain of json filters', async () => {
    expect(await stallOf(zeros, chain('(body|json)=="x"'))).toBeLessThan(100);
  });

  it('a chain of field reads per item', async () => {
    const empties = encoder.encode(`[${'{},'.repeat((inlineBodyBytes - 4) / 3)}{}]`);
    expect(await stallOf(empties, `body[?${chain('@.f')}]`)).toBeLessThan(100);
  });

  it('a chain of deep comparisons of two 128 KiB lists', async () => {
    const items = Array<string>(16_000).fill('{"a":0}').join(',');
    const pair = encoder.encode(`{"x":[${items}],"y":[${items}]}`);
    expect(await stallOf(pair, chain('body.x!=body.y'))).toBeLessThan(100);
  });

  it('a chain of == over two lists of 65,526 items that differ only in the last item', async () => {
    expect(await stallOf(differingLists(65_526), chain('body.a==body.b'))).toBeLessThan(100);
  });

  it('a chain of <= over two lists of 65,526 items that differ only in the last item', async () => {
    expect(await stallOf(differingLists(65_526), chain('body.a<=body.b'))).toBeLessThan(100);
  });

  it('a chain of == in a filter over two objects of 11,000 keys that differ at the last key', async () => {
    expect(await stallOf(differingObjects(11_000), `body[?${chain('a==b')}]`)).toBeLessThan(100);
  });

  it('a membership test against a list of 1,300 numbers per item', async () => {
    const sevens = Array<string>(1_300).fill('7').join(',');
    expect(await stallOf(zeros, `body[?@ in [${sevens}]]`)).toBeLessThan(100);
  });
});
