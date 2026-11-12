import { describe, expect, it } from 'vitest';
import {
  checkSurfaceResult,
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
      },
      typing: latency,
      error: undefined,
    };

    expect(readDriverResult(JSON.stringify(written), 'stream')).toEqual(
      JSON.parse(JSON.stringify(written)),
    );
  });
});

describe('checkSurfaceResult', () => {
  it('fails a run in which events never became visible', () => {
    expect(
      checkSurfaceResult({
        surface: 'webview',
        events: 10,
        visible: 7,
        latency,
        endedBy: 'completed',
      }),
    ).toBe('3 events never became visible.');
  });

  it('accepts a run in which every event became visible', () => {
    expect(
      checkSurfaceResult({
        surface: 'webview',
        events: 10,
        visible: 10,
        latency,
        endedBy: 'completed',
      }),
    ).toBeUndefined();
  });
});
