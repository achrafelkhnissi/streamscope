import { describe, expect, it } from 'vitest';
import { captureCompletions, captureHint } from '../../../src/capture/hints';
import { captureLookup } from '../../../src/capture/lookup';
import { CaptureRegistry, type CaptureEntry } from '../../../src/capture/registry';
import type { CaptureResult } from '../../../src/capture/tracker';
import { parseHttpFile } from '../../../src/http-file/parse';
import { requestKey } from '../../../src/runs/run';

const time = new Date(2026, 10, 13, 10, 20, 30).getTime();
const startKey = 'file:///agent.http\n@startRun';

function entry(
  result: CaptureResult,
  options: { name?: string; secret?: boolean } = {},
): CaptureEntry {
  return {
    request: startKey,
    label: 'startRun',
    name: options.name ?? 'threadId',
    secret: options.secret ?? false,
    runId: 7,
    runStartedAt: time,
    result,
  };
}

function resolved(text: string, secret = false): CaptureResult {
  return {
    state: 'resolved',
    text,
    secret,
    provenance: { runId: 7, event: 5, path: 'threadId', time },
  };
}

describe('captureHint', () => {
  it('resolved, pending and failed texts', () => {
    expect(captureHint(entry(resolved('thread-1')))).toEqual({
      label: '= thread-1',
      tooltip: '= thread-1\nstartRun › threadId · run 7 · event 5 at threadId · 10:20:30',
    });
    expect(captureHint(entry({ state: 'pending' }))).toEqual({
      label: '…',
      tooltip: '… has not arrived yet\nstartRun › threadId · run 7',
    });
    expect(captureHint(entry({ state: 'failed', reason: 'the response has no headers' }))).toEqual({
      label: '✗ the response has no headers',
      tooltip: '✗ the response has no headers\nstartRun › threadId · run 7',
    });
  });

  it('shows nothing for a request that has not run', () => {
    expect(captureHint(undefined)).toBeUndefined();
  });

  it('values are cut at 60 characters', () => {
    const long = 'x'.repeat(100);
    const reason = `no event matched first(type == "RUN_STARTED") ${'(12 events, 1 malformed) '.repeat(3)}`;

    expect(captureHint(entry(resolved(long)))?.label).toBe(`= ${'x'.repeat(59)}…`);
    expect(captureHint(entry(resolved(long)))?.tooltip.split('\n')[0]).toBe(`= ${long}`);
    expect(captureHint(entry(resolved('y'.repeat(60))))?.label).toBe(`= ${'y'.repeat(60)}`);
    expect(captureHint(entry({ state: 'failed', reason }))?.label).toBe(
      `✗ ${reason.slice(0, 59)}…`,
    );
    expect(captureHint(entry({ state: 'failed', reason }))?.tooltip.split('\n')[0]).toBe(
      `✗ ${reason}`,
    );
    expect(captureHint(entry(resolved('😀'.repeat(40))))?.label).toBe(`= ${'😀'.repeat(29)}…`);
  });

  it('a 1 MiB value becomes a short label', () => {
    const hint = captureHint(entry(resolved('z'.repeat(1_048_576))));

    expect(hint?.label).toBe(`= ${'z'.repeat(59)}…`);
    expect(hint?.tooltip.length).toBeGreaterThan(1_048_576);
  });

  it('line breaks in a value show as spaces in the label', () => {
    expect(captureHint(entry(resolved('first line\r\nsecond\nthird')))?.label).toBe(
      '= first line second third',
    );
  });

  it('a secret value is •••••• in the label and the tooltip', () => {
    const declared = captureHint(entry(resolved('synthetic-secret-value'), { secret: true }));
    const evaluated = captureHint(entry(resolved('synthetic-secret-value', true)));

    for (const hint of [declared, evaluated]) {
      expect(hint?.label).toBe('= ••••••');
      expect(hint?.tooltip).toBe(
        '= ••••••\nstartRun › threadId · run 7 · event 5 at threadId · 10:20:30',
      );
    }
  });

  it('masks credential-like names and URL user info as the hover does', () => {
    const token = captureHint(entry(resolved('synthetic-token'), { name: 'sessionToken' }));
    const url = captureHint(entry(resolved('postgres://admin:synthetic-pass@db.example.test/app')));

    expect(token?.label).toBe('= ••••••');
    expect(token?.tooltip).not.toContain('synthetic-token');
    expect(url?.label).toBe('= postgres://••••••@db.example.test/app');
    expect(url?.tooltip).not.toContain('synthetic-pass');
  });

  it('the tooltip names the run, event and time', () => {
    const tooltip = captureHint(entry(resolved('thread-1')))?.tooltip ?? '';

    expect(tooltip.split('\n')[1]).toBe(
      'startRun › threadId · run 7 · event 5 at threadId · 10:20:30',
    );
    expect(tooltip).toContain('run 7');
    expect(tooltip).toContain('event 5');
    expect(tooltip).toContain('10:20:30');
  });
});

describe('captureCompletions', () => {
  const documentUri = 'file:///agent.http';
  const file = parseHttpFile(
    [
      '### Start agent run',
      '# @name startRun',
      '# @capture threadId = first(type == "RUN_STARTED").threadId',
      '# @capture secret sessionToken = headers["x-session-token"]',
      'POST https://api.example.test/agent/run',
      '',
      '### Summarise',
      '# @capture threadId = body.threadId',
      '# @capture summary = body.summary',
      'POST https://api.example.test/agent/summary',
      '',
      '###',
      'GET https://api.example.test/agent/{{',
    ].join('\n'),
  );
  const [startRun] = file.requests;
  if (!startRun) {
    throw new Error('expected a producer');
  }
  const startRunKey = requestKey(documentUri, startRun, 0);
  const definitions = [
    { name: 'threadId', secret: false },
    { name: 'sessionToken', secret: true },
  ];

  it("offers request.name and bare names for the file's captures, before other variables", () => {
    const registry = new CaptureRegistry();

    expect(captureCompletions(file, captureLookup(registry, documentUri, file, new Map()))).toEqual(
      [
        { label: 'startRun.threadId', detail: 'startRun › threadId · not run yet' },
        { label: 'threadId', detail: 'startRun › threadId · not run yet' },
        { label: 'startRun.sessionToken', detail: 'startRun › sessionToken · not run yet' },
        { label: 'sessionToken', detail: 'startRun › sessionToken · not run yet' },
        { label: 'summary', detail: 'Summarise › summary · not run yet' },
      ],
    );
  });

  it('details show each capture state, masked when secret, never the secret value', () => {
    const registry = new CaptureRegistry();
    registry.begin({ id: 3, key: startRunKey, label: 'startRun', startedAt: time }, definitions);
    registry.update(3, 'threadId', resolved('thread-1'));
    registry.update(3, 'sessionToken', resolved('synthetic-session', true));
    const lookup = captureLookup(registry, documentUri, file, new Map());

    const resolvedItems = captureCompletions(file, lookup);
    expect(resolvedItems.slice(0, 4)).toEqual([
      { label: 'startRun.threadId', detail: 'startRun › threadId = thread-1' },
      { label: 'threadId', detail: 'startRun › threadId = thread-1' },
      { label: 'startRun.sessionToken', detail: 'startRun › sessionToken = ••••••' },
      { label: 'sessionToken', detail: 'startRun › sessionToken = ••••••' },
    ]);
    expect(JSON.stringify(resolvedItems)).not.toContain('synthetic-session');

    registry.begin(
      { id: 4, key: startRunKey, label: 'startRun', startedAt: time + 1 },
      definitions,
    );
    registry.update(4, 'sessionToken', { state: 'failed', reason: 'the response has no headers' });
    expect(captureCompletions(file, lookup).slice(0, 4)).toEqual([
      { label: 'startRun.threadId', detail: 'startRun › threadId …' },
      { label: 'threadId', detail: 'startRun › threadId …' },
      {
        label: 'startRun.sessionToken',
        detail: '✗ startRun › sessionToken failed: the response has no headers.',
      },
      {
        label: 'sessionToken',
        detail: '✗ startRun › sessionToken failed: the response has no headers.',
      },
    ]);
  });

  it('cuts a long value in a detail at 60 characters', () => {
    const registry = new CaptureRegistry();
    registry.begin({ id: 5, key: startRunKey, label: 'startRun', startedAt: time }, definitions);
    registry.update(5, 'threadId', resolved('t'.repeat(1_048_576)));

    expect(
      captureCompletions(file, captureLookup(registry, documentUri, file, new Map()))[0],
    ).toEqual({
      label: 'startRun.threadId',
      detail: `startRun › threadId = ${'t'.repeat(59)}…`,
    });
  });
});
