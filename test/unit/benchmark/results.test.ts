import { describe, expect, it } from 'vitest';
import {
  checkSurfaceResult,
  expectedEvents,
  readDriverResult,
  type DriverResult,
} from '../../benchmark/view/results';

const latency = { count: 10, p50Ms: 20, p95Ms: 40, p99Ms: 45, maxMs: 50 };

describe('readDriverResult', () => {
  it('reports a driver that wrote nothing', () => {
    expect(readDriverResult(undefined, 'stream').error).toBe(
      'The benchmark driver wrote no result.',
    );
  });

  it('reports a result it cannot read', () => {
    const result = readDriverResult('{', 'walkthrough');

    expect(result.error).toBe('The benchmark driver wrote an unreadable result.');
    expect(result.mode).toBe('walkthrough');
  });

  it('returns a written result unchanged', () => {
    const written: DriverResult = {
      mode: 'stream',
      vscodeVersion: '1.106.0',
      surface: { surface: 'webview', events: 10, visible: 10, latency, endedBy: 'completed' },
      extensionHost: {
        longTasks: { count: 0, maxMs: 0, totalMs: 0 },
        cpuPercent: 12.5,
        baselineHeapBytes: 1,
        maxHeapBytes: 2,
        maxArrayBuffersBytes: 3,
        baselineRssBytes: 4,
        maxRssBytes: 5,
      },
      typing: latency,
      error: undefined,
    };

    expect(readDriverResult(JSON.stringify(written), 'stream')).toEqual(
      JSON.parse(JSON.stringify(written)),
    );
  });
});

describe('expectedEvents', () => {
  it('counts the content events plus RUN_STARTED and RUN_FINISHED', () => {
    expect(expectedEvents(500, 30)).toBe(15_002);
    expect(expectedEvents(20, 0.25)).toBe(7);
  });
});

describe('checkSurfaceResult', () => {
  const passing = {
    surface: 'webview',
    events: 10,
    visible: 10,
    latency,
    endedBy: 'completed',
  } as const;

  it('accepts a complete run in which every event became visible with a latency', () => {
    expect(checkSurfaceResult(passing, 10)).toBeUndefined();
  });

  it('fails a run in which the surface returned nothing', () => {
    expect(checkSurfaceResult(undefined, 10)).toBe('The surface returned no result.');
  });

  it('fails a run whose stream did not complete', () => {
    expect(checkSurfaceResult({ ...passing, endedBy: 'failed' }, 10)).toBe(
      'The stream ended failed instead of completed.',
    );
  });

  it('fails a run with a different number of events than the server sends', () => {
    expect(checkSurfaceResult({ ...passing, events: 9, visible: 9 }, 10)).toBe(
      'Expected 10 events, got 9.',
    );
  });

  it('fails a run in which events never became visible', () => {
    expect(checkSurfaceResult({ ...passing, visible: 7 }, 10)).toBe(
      '3 events never became visible.',
    );
  });

  it('fails a run in which visible events have no latency', () => {
    expect(checkSurfaceResult({ ...passing, latency: { ...latency, count: 8 } }, 10)).toBe(
      '2 visible events have no latency.',
    );
  });
});
