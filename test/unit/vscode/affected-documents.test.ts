import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureChanges } from '../../../src/capture/changes';
import { CaptureRegistry } from '../../../src/capture/registry';
import type { HttpFile } from '../../../src/http-file/model';
import { parseHttpFile } from '../../../src/http-file/parse';
import { affectedDocuments } from '../../../src/vscode/language/affected-documents';

const agentUri = 'file:///agent.http';
const consumerUri = 'file:///consumer.http';
const unrelatedUri = 'file:///unrelated.http';
const closedUri = 'file:///closed.http';
const startKey = `${agentUri}\n@startRun`;
const continueKey = `${agentUri}\n@continue`;
const closedKey = `${closedUri}\n@seed`;
const threadId = { name: 'threadId', secret: false };
const messageId = { name: 'messageId', secret: false };

const agent = parseHttpFile(
  [
    '# @name startRun',
    '# @capture threadId = first(type == "RUN_STARTED").threadId',
    '# @capture messageId = first(type == "TEXT_MESSAGE_START").messageId',
    'POST https://api.example.test/agent/run',
    '',
    '###',
    '# @name continue',
    '# @capture runHandle = first(type == "RUN_STARTED").runId',
    'POST https://api.example.test/agent/continue?thread={{startRun.threadId}}',
  ].join('\n'),
);
const consumer = parseHttpFile(
  'GET https://api.example.test/messages/{{messageId}}?thread={{threadId}}',
);
const unrelated = parseHttpFile('GET https://api.example.test/health?thread={{threadName}}');

type Affected = ReturnType<typeof affectedDocuments>;

function watch(registry: CaptureRegistry, open: ReadonlyMap<string, HttpFile>): Affected[] {
  const results: Affected[] = [];
  new CaptureChanges(registry, (requests, names) => {
    results.push(affectedDocuments(requests, names, open));
  });
  return results;
}

const allOpen = new Map([
  [agentUri, agent],
  [consumerUri, consumer],
  [unrelatedUri, unrelated],
]);

describe('affectedDocuments', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("an update refreshes the producer's hints and the diagnostics of documents that use the name", () => {
    const registry = new CaptureRegistry();
    registry.begin({ id: 1, key: startKey, label: 'startRun', startedAt: 0 }, [threadId]);
    const results = watch(registry, allOpen);

    registry.update(1, 'threadId', {
      state: 'resolved',
      text: 'thread-1',
      secret: false,
      provenance: { runId: 1, event: 1, path: 'threadId', time: 0 },
    });
    vi.advanceTimersByTime(200);

    expect(results).toEqual([{ hints: [agentUri], diagnostics: [consumerUri] }]);
  });

  it('a re-run that declares no captures refreshes hints and diagnostics', () => {
    const registry = new CaptureRegistry();
    registry.begin({ id: 1, key: startKey, label: 'startRun', startedAt: 0 }, [messageId]);
    const results = watch(registry, allOpen);

    registry.begin({ id: 2, key: startKey, label: 'startRun', startedAt: 1 }, []);
    vi.advanceTimersByTime(200);

    expect(results).toEqual([{ hints: [agentUri], diagnostics: [consumerUri] }]);
  });

  it('an eviction refreshes hints and diagnostics', () => {
    const registry = new CaptureRegistry(1);
    registry.begin({ id: 1, key: startKey, label: 'startRun', startedAt: 0 }, [threadId]);
    const results = watch(registry, new Map([[consumerUri, consumer]]));

    registry.begin({ id: 2, key: closedKey, label: 'seed', startedAt: 1 }, [
      { name: 'seeded', secret: false },
    ]);
    vi.advanceTimersByTime(200);

    expect(registry.get(startKey, 'threadId')).toBeUndefined();
    expect(results).toEqual([{ hints: [], diagnostics: [consumerUri] }]);
  });

  it('a re-run that drops a capture refreshes hints and diagnostics', () => {
    const registry = new CaptureRegistry();
    registry.begin({ id: 1, key: continueKey, label: 'continue', startedAt: 0 }, [
      { name: 'runHandle', secret: false },
      messageId,
    ]);
    const results = watch(registry, allOpen);

    registry.begin({ id: 2, key: continueKey, label: 'continue', startedAt: 1 }, [
      { name: 'runHandle', secret: false },
    ]);
    vi.advanceTimersByTime(200);

    expect(registry.get(continueKey, 'messageId')).toBeUndefined();
    expect(results).toEqual([{ hints: [agentUri], diagnostics: [consumerUri] }]);
  });

  it('a change for a document that is not open refreshes no hints', () => {
    const registry = new CaptureRegistry();
    const results = watch(registry, allOpen);

    registry.begin({ id: 1, key: closedKey, label: 'seed', startedAt: 0 }, [
      { name: 'seeded', secret: false },
    ]);
    vi.advanceTimersByTime(200);

    expect(results).toEqual([{ hints: [], diagnostics: [] }]);
  });

  it('a bare-name change from a closed document affects only the diagnostics that use it', () => {
    const registry = new CaptureRegistry();
    const results = watch(registry, allOpen);

    registry.begin({ id: 1, key: closedKey, label: 'seed', startedAt: 0 }, [threadId]);
    vi.advanceTimersByTime(200);

    expect(results).toEqual([{ hints: [], diagnostics: [consumerUri] }]);
  });
});
