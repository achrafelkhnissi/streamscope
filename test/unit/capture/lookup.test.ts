import { describe, expect, it } from 'vitest';
import { captureLookup, responseKey } from '../../../src/capture/lookup';
import { CaptureRegistry } from '../../../src/capture/registry';
import type { CaptureResult } from '../../../src/capture/tracker';
import { parseHttpFile } from '../../../src/http-file/parse';
import { requestLabel } from '../../../src/response/labels';
import { requestKey } from '../../../src/runs/run';
import type { CaptureLookupResult } from '../../../src/variables/sources';

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
    '# @capture note = body.note',
    'POST https://api.example.test/agent/summary',
    '',
    '###',
    '# @capture summary = body.summary',
    'POST https://admin:synthetic@api.example.test/agent/summary',
    '',
    '###',
    'POST https://api.example.test/agent/continue',
  ].join('\n'),
);
const [startRun, summarise, untitled] = file.requests;
if (!startRun || !summarise || !untitled) {
  throw new Error('expected three producers');
}
const startKey = requestKey(documentUri, startRun, 0);
const declared = [
  { name: 'threadId', secret: false },
  { name: 'sessionToken', secret: true },
];

function resolved(text: string, runId: number, secret = false): CaptureResult {
  return {
    state: 'resolved',
    text,
    secret,
    sensitive: [],
    provenance: { runId, event: 1, path: 'threadId', time: 1_700_000_000_000 },
  };
}

function lookupOf(
  registry: CaptureRegistry,
  responses: ReadonlyMap<string, CaptureLookupResult> = new Map(),
) {
  return captureLookup(registry, documentUri, file, responses);
}

describe('captureLookup', () => {
  it("{{startRun.threadId}} reads that request's capture in this document", () => {
    const registry = new CaptureRegistry();
    registry.begin({ id: 7, key: startKey, label: 'startRun', startedAt: 10 }, declared);
    const lookup = lookupOf(registry);

    expect(lookup.request('startRun', 'threadId')).toEqual({
      kind: 'pending',
      request: startKey,
      label: 'startRun',
      name: 'threadId',
    });

    registry.update(7, 'threadId', resolved('thread-1', 7));
    registry.update(7, 'sessionToken', resolved('synthetic-session', 7, true));

    expect(lookup.request('startRun', 'threadId')).toEqual({
      kind: 'value',
      text: 'thread-1',
      secret: false,
      sensitive: [],
      label: 'startRun',
      provenance: { runId: 7, event: 1, path: 'threadId', time: 1_700_000_000_000 },
    });
    expect(lookup.request('startRun', 'sessionToken')).toMatchObject({
      kind: 'value',
      text: 'synthetic-session',
      secret: true,
    });
  });

  it('a failed capture reads startRun › threadId failed: <reason>.', () => {
    const registry = new CaptureRegistry();
    registry.begin({ id: 7, key: startKey, label: 'startRun', startedAt: 10 }, declared);
    registry.update(7, 'threadId', {
      state: 'failed',
      reason: 'no event matched first(type == "RUN_STARTED") (12 events, 1 malformed)',
    });

    expect(lookupOf(registry).request('startRun', 'threadId')).toEqual({
      kind: 'failed',
      message:
        'startRun › threadId failed: no event matched first(type == "RUN_STARTED") (12 events, 1 malformed).',
    });
  });

  it('a request that has not run reads as not run', () => {
    const lookup = lookupOf(new CaptureRegistry());

    expect(lookup.request('startRun', 'threadId')).toBeUndefined();
  });

  it('a producer that ran without declaring the name is not run, never a wait', () => {
    const registry = new CaptureRegistry();
    registry.begin({ id: 7, key: startKey, label: 'startRun', startedAt: 10 }, [
      { name: 'messageId', secret: false },
    ]);
    const lookup = lookupOf(registry);

    expect(lookup.request('startRun', 'threadId')).toBeUndefined();
    expect(lookup.bare('threadId')).toBeUndefined();
    expect(lookup.elsewhere('threadId')).toEqual({
      kind: 'not-run',
      label: 'startRun',
      producerName: 'startRun',
    });
  });

  it('a bare name reads the newest capture of a request this file declares it on, and elsewhere reads every other one', () => {
    const twice = parseHttpFile(
      [
        '# @name startRun',
        '# @capture threadId = body.a',
        'POST https://api.example.test/a',
        '',
        '###',
        '# @name again',
        '# @capture threadId = body.b',
        'POST https://api.example.test/b',
      ].join('\n'),
    );
    const registry = new CaptureRegistry();
    const threadOnly = [{ name: 'threadId', secret: false }];
    const runs: [number, string, string][] = [
      [7, startKey, 'thread-1'],
      [8, 'file:///other.http\n@restart', 'thread-2'],
      [9, `${documentUri}\n@again`, 'thread-3'],
      [10, `${documentUri}\n@removed`, 'thread-4'],
    ];
    const lookup = captureLookup(registry, documentUri, twice, new Map());
    const seen: [string | undefined, string | undefined][] = [];
    for (const [id, key, text] of runs) {
      registry.begin({ id, key, label: key, startedAt: id }, threadOnly);
      registry.update(id, 'threadId', resolved(text, id));
      const bare = lookup.bare('threadId');
      const elsewhere = lookup.elsewhere('threadId');
      seen.push([
        bare?.kind === 'value' ? bare.text : undefined,
        elsewhere?.kind === 'value' ? elsewhere.text : undefined,
      ]);
    }

    expect(seen).toEqual([
      ['thread-1', undefined],
      ['thread-1', 'thread-2'],
      ['thread-3', 'thread-2'],
      ['thread-3', 'thread-4'],
    ]);
  });

  it('a bare name nobody captured yet comes from the first request in this file that declares it', () => {
    const lookup = lookupOf(new CaptureRegistry());

    expect(lookup.bare('threadId')).toBeUndefined();
    expect(lookup.elsewhere('threadId')).toEqual({
      kind: 'not-run',
      label: 'startRun',
      producerName: 'startRun',
    });
    expect(lookup.elsewhere('note')).toEqual({
      kind: 'not-run',
      label: 'Summarise',
      producerName: 'file:///agent.http\n#1 POST https://api.example.test/agent/summary',
    });
    expect(lookup.elsewhere('summary')).toEqual({
      kind: 'not-run',
      label: 'POST https://••••••@api.example.test/agent/summary',
      producerName:
        'file:///agent.http\n#2 POST https://admin:synthetic@api.example.test/agent/summary',
    });
  });

  it('names producers and keys requests the way runs do', () => {
    const registry = new CaptureRegistry();
    const lookup = lookupOf(registry);
    registry.begin(
      { id: 7, key: startKey, label: requestLabel(startRun), startedAt: 10 },
      declared,
    );

    expect(lookup.request('startRun', 'threadId')).toMatchObject({ kind: 'pending' });
    for (const [index, producer] of [summarise, untitled].entries()) {
      const name = producer.captures[0]?.name ?? '';
      expect(lookup.elsewhere(name)).toMatchObject({
        label: requestLabel(producer),
        producerName: requestKey(documentUri, producer, index + 1),
      });
    }
  });

  it('a name no request declares and nobody captured is not a capture', () => {
    const lookup = lookupOf(new CaptureRegistry());

    expect(lookup.bare('cursor')).toBeUndefined();
    expect(lookup.elsewhere('cursor')).toBeUndefined();
  });

  it('response references read the evaluated results and wait for the rest', () => {
    const token: CaptureLookupResult = {
      kind: 'value',
      text: 'synthetic-token',
      secret: false,
      sensitive: [],
      label: 'startRun',
      provenance: { runId: 7, event: undefined, path: 'response.body.$.token', time: 0 },
    };
    const lookup = lookupOf(
      new CaptureRegistry(),
      new Map([[responseKey('startRun', 'response.body.$.token'), token]]),
    );

    expect(lookup.response('startRun', 'response.body.$.token')).toBe(token);
    expect(lookup.response('startRun', 'response.headers.X-Session')).toBeUndefined();
  });
});
