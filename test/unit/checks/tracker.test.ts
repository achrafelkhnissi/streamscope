import { afterEach, describe, expect, it } from 'vitest';
import { compileCheck, type CheckProgram } from '../../../src/checks/compile';
import { CheckTracker, type CheckResult } from '../../../src/checks/tracker';
import { cutText, shown, verdictOf, type TermState } from '../../../src/checks/verdict';
import type { JsonValue, StreamEvent } from '../../../src/events/model';
import type { SourceNode } from '../../../src/expressions/ast';
import { evaluate, holds, type Outcome } from '../../../src/expressions/evaluate';
import { parseExpression } from '../../../src/expressions/parse';
import type { RunEnd } from '../../../src/runs/observer';
import { captureSliceMs, TaskBudget } from '../../../src/capture/task-budget';
import { startRun } from '../../../src/runs/run';
import type { ResponseHead } from '../../../src/transport/model';
import { startHttpServer, type LocalServer } from '../../support/servers';
import { dependencies, runInput, useSpillArea, withObserver } from '../runs/support';
import { fastestOf } from '../timing';
import { longestStall, useCaptureWorker } from '../capture/worker';

const servers: LocalServer[] = [];
useSpillArea();
const workerFiles = useCaptureWorker();

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function program(text: string): CheckProgram {
  const parsed = parseExpression(text, 'expect');
  if (!parsed.ok) {
    throw new Error(`${text}: ${parsed.error.message}`);
  }
  return compileCheck(parsed.expr, text);
}

async function serve(lines: readonly JsonValue[] | string, headers: Record<string, string> = {}) {
  const body =
    typeof lines === 'string' ? lines : `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
  const server = await startHttpServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson', ...headers });
    response.end(body);
  });
  servers.push(server);
  return `${server.url}/stream`;
}

interface Checked {
  results: Map<number, CheckResult>;
  calls: number[];
  events: number;
  status: string;
}

async function checkRun(url: string, texts: readonly string[]): Promise<Checked> {
  const results = new Map<number, CheckResult>();
  const calls: number[] = [];
  let tracker: CheckTracker | undefined;
  let ended: Promise<void> | undefined;
  const checks = texts.map((text, index) => ({ index, program: program(text) }));
  const observer = {
    head: (head: ResponseHead, access: Parameters<CheckTracker['head']>[1]) => {
      tracker?.head(head, access);
    },
    event: (event: StreamEvent) => {
      tracker?.event(event);
    },
    end: (end: Parameters<CheckTracker['end']>[0]) => {
      ended = tracker?.end(end);
    },
    get backpressure() {
      if (tracker === undefined) {
        throw new Error('no tracker');
      }
      return tracker.backpressure;
    },
  };
  const input = withObserver(runInput([`GET ${url}`]), observer);
  const run = startRun(
    {
      ...input,
      captures: {
        ...input.captures,
        observer: (info) => {
          tracker = new CheckTracker(
            info,
            checks,
            (index, result) => {
              calls.push(index);
              results.set(index, result);
            },
            workerFiles().worker,
          );
          return observer;
        },
      },
    },
    dependencies,
  );
  const snapshot = await run.done;
  await ended;
  const events = snapshot.stream?.store.count ?? 0;
  await run.release();
  return { results, calls, events, status: snapshot.status };
}

const agentStream: JsonValue[] = [
  { type: 'RUN_STARTED', threadId: 't' },
  { type: 'TEXT_MESSAGE_START' },
  { type: 'TEXT_MESSAGE_CONTENT', delta: 'He' },
  { type: 'TEXT_MESSAGE_CONTENT', delta: 'lo' },
  { type: 'TEXT_MESSAGE_CONTENT', delta: '!' },
  { type: 'TOOL_CALL_START', id: 't1' },
  { type: 'RUN_ERROR', code: 500 },
  { type: 'TOOL_CALL_START', id: 't1' },
  { type: 'RUN_FINISHED', ok: true },
];

function matching(events: readonly StreamEvent[], condition: SourceNode | undefined) {
  const node = condition as { condition?: Parameters<typeof holds>[0] } | undefined;
  return events.filter(
    (event) =>
      (event.kind === 'json' || event.kind === 'text') &&
      (node?.condition === undefined ||
        holds(node.condition, { value: event.value, sse: event.sse, malformed: false })),
  );
}

function finalStates(
  compiled: CheckProgram,
  events: readonly StreamEvent[],
  head: ResponseHead,
): Map<number, TermState> {
  const sources = {
    value(node: SourceNode): Outcome {
      if (node.kind === 'source' && node.name === 'status') {
        return { present: true, value: head.status, path: 'status' };
      }
      if (node.kind === 'events' || node.kind === 'nth') {
        const found = matching(events, node);
        const pick =
          node.kind === 'nth'
            ? found[node.position - 1]
            : node.name === 'first'
              ? found[0]
              : node.name === 'last'
                ? found.at(-1)
                : undefined;
        if (node.kind === 'events' && node.name === 'all') {
          return { present: true, value: found.map((event) => event.value), path: 'all' };
        }
        if (node.kind === 'events' && node.name === 'count') {
          return { present: true, value: found.length, path: 'count' };
        }
        return pick === undefined
          ? { present: false, reason: 'no event matched' }
          : { present: true, value: pick.value, path: 'event' };
      }
      return { present: false, reason: 'not scripted' };
    },
  };
  const states = new Map<number, TermState>();
  for (const term of compiled.terms) {
    if (term.kind === 'value') {
      const outcome = evaluate(term.expr, sources);
      states.set(
        term.id,
        outcome.present
          ? { kind: 'value', value: outcome.value, preview: shown(outcome.value) }
          : { kind: 'missing', reason: outcome.reason },
      );
    } else if (term.kind === 'count') {
      states.set(term.id, {
        kind: 'count',
        count: matching(events, {
          kind: 'events',
          name: 'count',
          condition: term.condition,
          span: { start: 0, end: 0 },
        }).length,
        index: undefined,
        final: true,
      });
    } else {
      const index = (condition: typeof term.first) =>
        matching(events, {
          kind: 'events',
          name: 'first',
          condition,
          span: { start: 0, end: 0 },
        })[0]?.index;
      states.set(term.id, {
        kind: 'before',
        first: index(term.first),
        second: index(term.second),
        final: true,
      });
    }
  }
  return states;
}

function scripted(values: readonly JsonValue[]): StreamEvent[] {
  return values.map((value, at) => ({
    index: at + 1,
    time: at,
    offset: 0,
    length: 16,
    line: at + 1,
    kind: 'json',
    value,
    label: undefined,
    sse: undefined,
    marker: undefined,
    error: undefined,
    unterminated: false,
  }));
}

describe('CheckTracker', () => {
  it('settles each check at the earliest event that decides it', async () => {
    const url = await serve(agentStream);
    const texts = [
      'status == 200',
      'exists(first(type == "RUN_STARTED"))',
      'count(type == "TEXT_MESSAGE_CONTENT") > 2',
      '!exists(first(type == "RUN_ERROR"))',
      'before(type == "RUN_STARTED", type == "RUN_FINISHED")',
      'last(type == "RUN_FINISHED").ok == true',
      'unique(all(type == "TOOL_CALL_START").id)',
      'count(type == "TEXT_MESSAGE_CONTENT") <= 2',
      'before(type == "RUN_FINISHED", type == "RUN_STARTED")',
    ];

    const { results } = await checkRun(url, texts);

    expect(texts.map((_, index) => results.get(index))).toEqual([
      { state: 'passed', settledAt: undefined },
      { state: 'passed', settledAt: 1 },
      { state: 'passed', settledAt: 5 },
      { state: 'failed', detail: 'first(type == "RUN_ERROR") matched event 7', settledAt: 7 },
      { state: 'passed', settledAt: 1 },
      { state: 'passed', settledAt: undefined },
      { state: 'failed', detail: '"t1" appears more than once', settledAt: undefined },
      { state: 'failed', detail: 'count(type == "TEXT_MESSAGE_CONTENT") reached 3', settledAt: 5 },
      { state: 'failed', detail: 'type == "RUN_STARTED" matched event 1 first', settledAt: 1 },
    ]);
  });

  it('never changes a result once settled, and reports each check once', async () => {
    const url = await serve(agentStream);
    const texts = [
      'count(type == "TEXT_MESSAGE_CONTENT") > 0',
      'count(type == "TEXT_MESSAGE_CONTENT") <= 1',
      'exists(first(type == "TOOL_CALL_START"))',
      'status == 200 && count() > 3',
    ];

    const { calls } = await checkRun(url, texts);

    expect([...calls].sort()).toEqual([0, 1, 2, 3]);
  });

  it('gives the same verdict live as it would at the end', async () => {
    const atoms = [
      'status == 200',
      'exists(first(type == "RUN_STARTED"))',
      'count(type == "TEXT_MESSAGE_CONTENT") > 2',
      'count(type == "TEXT_MESSAGE_CONTENT") <= 2',
      '!exists(first(type == "RUN_ERROR"))',
      'before(type == "RUN_STARTED", type == "RUN_FINISHED")',
      'before(type == "RUN_ERROR", type == "TEXT_MESSAGE_CONTENT")',
      'last(type == "RUN_FINISHED").ok == true',
      'unique(all(type == "TOOL_CALL_START").id)',
      'count(type == "TOOL_CALL_START") == 1',
      'nth(2, type == "TEXT_MESSAGE_CONTENT").delta == "lo"',
      'first(type == "RUN_ERROR").code != 500',
    ];
    const texts = [...atoms];
    for (let at = 0; at < 9; at += 1) {
      texts.push(`(${atoms[at] ?? ''}) && (${atoms[(at + 5) % 12] ?? ''})`);
      texts.push(`(${atoms[at + 1] ?? ''}) || !(${atoms[(at + 7) % 12] ?? ''})`);
    }
    const streams: JsonValue[][] = [
      [
        { type: 'RUN_STARTED' },
        { type: 'TEXT_MESSAGE_CONTENT', delta: 'He' },
        { type: 'TEXT_MESSAGE_CONTENT', delta: 'lo' },
        { type: 'TEXT_MESSAGE_CONTENT', delta: '!' },
        { type: 'TOOL_CALL_START', id: 't1' },
        { type: 'TOOL_CALL_START', id: 't2' },
        { type: 'RUN_FINISHED', ok: true },
      ],
      [
        { type: 'RUN_STARTED' },
        { type: 'TEXT_MESSAGE_CONTENT', delta: 'a' },
        { type: 'RUN_ERROR', code: 500 },
        { type: 'TEXT_MESSAGE_CONTENT', delta: 'lo' },
        { type: 'TOOL_CALL_START', id: 't1' },
        { type: 'TOOL_CALL_START', id: 't1' },
        { type: 'RUN_FINISHED', ok: false },
      ],
      [
        { type: 'TEXT_MESSAGE_CONTENT', delta: 'x' },
        { type: 'RUN_FINISHED', ok: true },
        { type: 'TEXT_MESSAGE_CONTENT', delta: 'lo' },
        { type: 'RUN_ERROR', code: 404 },
      ],
    ];
    expect(texts).toHaveLength(30);
    const head: ResponseHead = { httpVersion: '1.1', status: 200, statusText: 'OK', headers: [] };
    for (const stream of streams) {
      const url = await serve(stream);
      const { results } = await checkRun(url, texts);
      texts.forEach((text, index) => {
        const compiled = program(text);
        const expected = verdictOf(compiled, finalStates(compiled, scripted(stream), head));
        expect(results.get(index)?.state, `${text} over ${JSON.stringify(stream)}`).toBe(
          expected.state,
        );
      });
    }
  }, 60_000);

  it('reports a count check while the stream is still arriving', async () => {
    const server = await startHttpServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      let sent = 0;
      const timer = setInterval(() => {
        sent += 1;
        response.write(`${JSON.stringify({ type: 'CONTENT', n: sent })}\n`);
        if (sent === 6) {
          clearInterval(timer);
          response.end();
        }
      }, 100);
    });
    servers.push(server);
    const started = performance.now();
    let reportedAt: number | undefined;
    const tracker = new CheckTracker(
      { id: 1, label: 'slow', wallStartedAt: 0, sensitiveValues: [] },
      [{ index: 0, program: program('count(type == "CONTENT") > 1') }],
      () => {
        reportedAt = performance.now() - started;
      },
      workerFiles().worker,
    );
    const run = startRun(
      {
        ...runInput([`GET ${server.url}/slow`]),
        checks: {
          begin: () => undefined,
          observer: () => ({
            head: (head, access) => {
              tracker.head(head, access);
            },
            event: (event) => {
              tracker.event(event);
            },
            end: (end) => {
              void tracker.end(end);
            },
            backpressure: tracker.backpressure,
          }),
        },
      },
      dependencies,
    );
    await run.done;
    const doneAt = performance.now() - started;
    await run.release();

    expect(reportedAt).toBeDefined();
    expect((reportedAt ?? doneAt) + 250).toBeLessThan(doneAt);
  });

  it('keeps the stream going when a check fails', async () => {
    const url = await serve(agentStream);

    const { results, events, status } = await checkRun(url, ['count(type == "RUN_STARTED") == 0']);

    expect(results.get(0)).toMatchObject({ state: 'failed', settledAt: 1 });
    expect(status).toBe('completed');
    expect(events).toBe(agentStream.length);
  });

  it('decides before on a b event larger than 256 KiB without waiting for its value', async () => {
    const url = await serve([{ type: 'B', pad: 'x'.repeat(300_000) }, { type: 'A' }]);

    const { results } = await checkRun(url, ['before(type == "A", type == "B")']);

    expect(results.get(0)).toEqual({
      state: 'failed',
      detail: 'type == "B" matched event 1 first',
      settledAt: 1,
    });
  });

  it('fails pending checks of a cancelled, failed or blocked run with the reasons', async () => {
    const ends = [
      [{ kind: 'cancelled' }, 'the request was stopped before this check settled'],
      [{ kind: 'failed', message: 'socket hang up' }, 'the request failed: socket hang up'],
      [{ kind: 'blocked', message: 'not sent' }, 'the request was not sent'],
    ] as const;
    for (const [end, detail] of ends) {
      const results = new Map<number, CheckResult>();
      const tracker = new CheckTracker(
        { id: 1, label: 'startRun', wallStartedAt: 0, sensitiveValues: [] },
        [
          { index: 0, program: program('status == 200') },
          { index: 1, program: program('count(type == "A") > 5') },
        ],
        (index, result) => results.set(index, result),
        workerFiles().worker,
      );
      tracker.head(
        {
          httpVersion: '1.1',
          status: 200,
          statusText: 'OK',
          headers: [['Content-Type', 'application/x-ndjson']],
        },
        { spillPath: () => Promise.resolve(undefined), signal: new AbortController().signal },
      );
      tracker.event(scripted([{ type: 'A' }])[0] as StreamEvent);
      await tracker.end(end);

      expect(results.get(0)).toEqual({ state: 'passed', settledAt: undefined });
      expect(results.get(1)).toEqual({ state: 'failed', detail, settledAt: undefined });
    }
  });

  it('fails a check whose term is too long to evaluate on its own', async () => {
    const url = await serve(agentStream);
    const key = 'k'.repeat(4_080);

    const { results } = await checkRun(url, [`exists(first().${key})`]);

    expect(results.get(0)).toEqual({
      state: 'failed',
      detail: cutText(
        `first().${key} could not be evaluated: An expression is at most 4,096 characters.`,
        4_096,
      ),
      settledAt: undefined,
    });
  });

  it('masks a sensitive header value in a detail', async () => {
    const url = await serve(agentStream, { 'X-Session-Token': 'synthetic-session-value' });

    const { results } = await checkRun(url, ['headers["x-session-token"] == "x"']);

    expect(results.get(0)).toEqual({
      state: 'failed',
      detail: 'got "••••••"',
      settledAt: undefined,
    });
  });

  it('keeps the host stall under 100 ms with 64 checks over 100,000 events', async () => {
    const lines: string[] = [];
    for (let at = 1; at <= 100_000; at += 1) {
      lines.push(`{"type":"T${String(at % 5)}","n":${String(at)}}`);
    }
    const url = await serve(`${lines.join('\n')}\n`);
    const texts: string[] = [];
    for (let at = 0; at < 16; at += 1) {
      texts.push(`count(type == "T${String(at % 5)}") > ${String(at * 1_000)}`);
      texts.push(`before(type == "T1", type == "T${String(at % 5)}")`);
      texts.push(`exists(first(n == ${String(at * 5_000 + 1)}))`);
      texts.push(`last(type == "T${String(at % 5)}").n > ${String(at)}`);
    }
    expect(texts).toHaveLength(64);

    let checked: Checked | undefined;
    const stallMs = await fastestOf(async () => {
      const { result, stallMs: stall } = await longestStall(() => checkRun(url, texts));
      checked = result;
      return stall;
    });

    expect(checked?.events).toBe(100_000);
    expect(checked?.results.size).toBe(64);
    expect(stallMs).toBeLessThan(100);
  }, 120_000);
});

describe('CheckTracker after the review', () => {
  const okHead: ResponseHead = {
    httpVersion: '1.1',
    status: 200,
    statusText: 'OK',
    headers: [['Content-Type', 'application/x-ndjson']],
  };
  const access = {
    spillPath: () => Promise.resolve(undefined),
    signal: new AbortController().signal,
  };

  function direct(
    texts: readonly string[],
    options: { sensitiveValues?: string[]; secrets?: string[] } = {},
  ) {
    const results = new Map<number, CheckResult>();
    const tracker = new CheckTracker(
      { id: 1, label: 'run', wallStartedAt: 0, sensitiveValues: options.sensitiveValues ?? [] },
      texts.map((text, index) => ({ index, program: program(text) })),
      (index, result) => results.set(index, result),
      workerFiles().worker,
      undefined,
      () => options.secrets ?? [],
    );
    tracker.head(okHead, access);
    let index = 0;
    const send = (value: JsonValue) => {
      index += 1;
      tracker.event({ ...(scripted([value])[0] as StreamEvent), index, line: index });
    };
    return { tracker, results, send };
  }

  function detailOf(result: CheckResult | undefined): string {
    return result?.state === 'failed' ? result.detail : '';
  }

  it("masks the run's secret captures in a detail", () => {
    const { results, send } = direct(['first(type == "AUTH").token == "x"'], {
      secrets: ['sk-synthetic-secret-123'],
    });
    send({ type: 'AUTH', token: 'sk-synthetic-secret-123' });
    expect(results.get(0)).toEqual({ state: 'failed', detail: 'got "••••••"', settledAt: 1 });
  });

  it('masks a secret that straddles the 200-character cut', () => {
    const secret = 'sk-synthetic-0123456789abcdefghij';
    const { results, send } = direct(['first(type == "A").v == "y"'], {
      sensitiveValues: [secret],
    });
    send({ type: 'A', v: `${'x'.repeat(190)}${secret}` });
    const detail = detailOf(results.get(0));
    expect(detail).not.toBe('');
    for (let at = 0; at + 8 <= secret.length; at += 1) {
      expect(detail).not.toContain(secret.slice(at, at + 8));
    }
  });

  it('masks user info in a URL in a detail', () => {
    const { results, send } = direct(['first(type == "A").url == "y"']);
    send({ type: 'A', url: 'https://admin:pw@internal.example/' });
    expect(results.get(0)).toEqual({
      state: 'failed',
      detail: 'got "https://••••••@internal.example/"',
      settledAt: 1,
    });
  });

  it('caps a detail at 4,096 characters', () => {
    const sides = Array.from({ length: 30 }, (_, at) => `first(type == "A").v${String(at)} == "y"`);
    const { results, send } = direct([sides.join(' || ')]);
    const value: Record<string, JsonValue> = { type: 'A' };
    for (let at = 0; at < 30; at += 1) {
      value[`v${String(at)}`] = 'z'.repeat(300);
    }
    send(value);
    expect(results.get(0)?.state).toBe('failed');
    expect(detailOf(results.get(0)).length).toBeLessThanOrEqual(4_096);
  });

  it('fails a negated exists on an event too large to insert, from its match', async () => {
    const url = await serve([
      { type: 'RUN_STARTED' },
      { type: 'RUN_ERROR', pad: 'x'.repeat(1_200_000) },
    ]);
    const { results } = await checkRun(url, ['!exists(first(type == "RUN_ERROR"))']);
    expect(results.get(0)).toEqual({
      state: 'failed',
      detail: 'first(type == "RUN_ERROR") matched event 2',
      settledAt: 2,
    });
  });

  it('fails a before whose condition needs too much work', async () => {
    const url = await serve([
      { type: 'B', items: Array.from({ length: 600_001 }, (_, at) => at + 8) },
      { type: 'A' },
    ]);
    const { results } = await checkRun(url, ['before(type == "A", items contains 7)']);
    expect(results.get(0)).toMatchObject({
      state: 'failed',
      detail:
        'before(type == "A", items contains 7) could not be evaluated: the capture needs too much work for this stream',
    });
  }, 30_000);

  it('settles every check of a completed run', async () => {
    const url = await serve(agentStream);
    const { results } = await checkRun(url, ['/abc/ == "abc"']);
    expect(results.get(0)).toEqual({
      state: 'failed',
      detail: 'the check could not be decided',
      settledAt: undefined,
    });
  });

  it('reports a count of 0 at the headers', () => {
    const { results } = direct(['count(type == "A") >= 0', 'count(type == "A") < 0']);
    expect(results.get(0)).toEqual({ state: 'passed', settledAt: undefined });
    expect(results.get(1)).toEqual({
      state: 'failed',
      detail: 'count(type == "A") reached 0',
      settledAt: undefined,
    });
  });

  it('fails checks beyond 64 internal values', () => {
    const texts = Array.from({ length: 70 }, (_, at) => `first(type == "A").v${String(at)} == 1`);
    const { results } = direct(texts);
    expect(results.get(63)).toBeUndefined();
    for (let at = 64; at < 70; at += 1) {
      expect(results.get(at)).toEqual({
        state: 'failed',
        detail:
          'the checks of this request read more than 64 values, so this check is not evaluated',
        settledAt: undefined,
      });
    }
  });

  it('keeps nothing for a settled check', () => {
    const { tracker, send } = direct([
      'first(type == "A").n == 1',
      'count(type == "A") > 0',
      'before(type == "A", type == "B")',
    ]);
    send({ type: 'A', n: 1 });
    expect(tracker.retained).toBe(0);
  });

  it('does not format a large settled value again on every event', () => {
    const { send, results } = direct([
      'exists(first(type == "A").big) && count(type == "B") > 100000',
    ]);
    send({ type: 'A', big: 'x'.repeat(200_000) });
    const started = performance.now();
    for (let at = 0; at < 3_000; at += 1) {
      send({ type: 'B' });
    }
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(results.get(0)).toBeUndefined();
  });

  it('reports the deciding event of counts that settle after the run ended', async () => {
    let time = 0;
    const tasks: (() => void)[] = [];
    const budget = new TaskBudget({
      now: () => time,
      nextTask: (callback) => {
        tasks.push(callback);
      },
    });
    const results = new Map<number, CheckResult>();
    const tracker = new CheckTracker(
      { id: 1, label: 'run', wallStartedAt: 0, sensitiveValues: [] },
      ['count(type == "A") > 1', '!exists(first(type == "B"))'].map((text, index) => ({
        index,
        program: program(text),
      })),
      (index, result) => results.set(index, result),
      workerFiles().worker,
      budget,
    );
    tracker.head(okHead, access);
    budget.enter();
    time += captureSliceMs;
    budget.leave();
    for (const event of scripted([{ type: 'A' }, { type: 'A' }, { type: 'B' }])) {
      tracker.event(event);
    }
    expect(results.size).toBe(0);
    const completed: RunEnd = {
      kind: 'completed',
      format: 'ndjson',
      contentType: 'application/x-ndjson',
      bodyLength: 0,
      spillPath: () => Promise.resolve(undefined),
      reply: { recognised: false, truncated: false },
      signal: new AbortController().signal,
      readBody: () => Promise.resolve(undefined),
      readReply: () => Promise.resolve(undefined),
    };
    const progress = { ended: false };
    const ending = tracker.end(completed).then(() => {
      progress.ended = true;
    });
    while (!progress.ended) {
      for (const task of tasks.splice(0)) {
        task();
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    await ending;

    expect(results.get(0)).toEqual({ state: 'passed', settledAt: 2 });
    expect(results.get(1)).toEqual({
      state: 'failed',
      detail: 'first(type == "B") matched event 3',
      settledAt: 3,
    });
  });
});
