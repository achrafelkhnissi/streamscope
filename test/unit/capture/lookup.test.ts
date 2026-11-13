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
    expect(lookup.bare('threadId')).toEqual({
      kind: 'not-run',
      label: 'startRun',
      producerName: 'startRun',
    });
  });

  it('a bare name reads the capture whose run started most recently, in any document', () => {
    const registry = new CaptureRegistry();
    registry.begin({ id: 7, key: startKey, label: 'startRun', startedAt: 10 }, declared);
    registry.update(7, 'threadId', resolved('thread-1', 7));
    registry.begin(
      { id: 8, key: 'file:///other.http\n@restart', label: 'restart', startedAt: 20 },
      [{ name: 'threadId', secret: false }],
    );
    registry.update(8, 'threadId', resolved('thread-2', 8));

    expect(lookupOf(registry).bare('threadId')).toMatchObject({
      kind: 'value',
      text: 'thread-2',
      label: 'restart',
    });
  });

  it('a bare name nobody captured yet comes from the first request in this file that declares it', () => {
    const lookup = lookupOf(new CaptureRegistry());

    expect(lookup.bare('threadId')).toEqual({
      kind: 'not-run',
      label: 'startRun',
      producerName: 'startRun',
    });
    expect(lookup.bare('note')).toEqual({
      kind: 'not-run',
      label: 'Summarise',
      producerName: 'Summarise',
    });
    expect(lookup.bare('summary')).toEqual({
      kind: 'not-run',
      label: 'POST https://••••••@api.example.test/agent/summary',
      producerName: 'POST https://••••••@api.example.test/agent/summary',
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
    for (const producer of [summarise, untitled]) {
      const name = producer.captures[0]?.name ?? '';
      expect(lookup.bare(name)).toMatchObject({ label: requestLabel(producer) });
    }
  });

  it('a name no request declares and nobody captured is not a capture', () => {
    expect(lookupOf(new CaptureRegistry()).bare('cursor')).toBeUndefined();
  });

  it('response references read the evaluated results and wait for the rest', () => {
    const token: CaptureLookupResult = {
      kind: 'value',
      text: 'synthetic-token',
      secret: false,
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
