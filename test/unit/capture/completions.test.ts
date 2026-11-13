import { describe, expect, it } from 'vitest';
import { captureCompletions } from '../../../src/capture/completions';
import { captureLookup } from '../../../src/capture/lookup';
import { CaptureRegistry } from '../../../src/capture/registry';
import type { CaptureResult } from '../../../src/capture/tracker';
import { parseHttpFile } from '../../../src/http-file/parse';
import { requestKey } from '../../../src/runs/run';

const time = new Date(2026, 10, 13, 10, 20, 30).getTime();

function resolved(text: string, secret = false): CaptureResult {
  return {
    state: 'resolved',
    text,
    secret,
    sensitive: [],
    provenance: { runId: 7, event: 5, path: 'threadId', time },
  };
}

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
