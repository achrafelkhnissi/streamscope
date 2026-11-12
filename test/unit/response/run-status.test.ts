import { describe, expect, it } from 'vitest';
import {
  describeRunning,
  runPickItems,
  runStatusText,
  runStatusTooltip,
} from '../../../src/response/run-status';
import { snapshot, streamOf } from './fixtures';

const events = { body: new Uint8Array(), bodyKept: false };

function running(overrides: Parameters<typeof snapshot>[0] = {}) {
  return snapshot({ status: 'receiving', elapsedMs: 2100, ...overrides });
}

describe('run status text', () => {
  it('counts the events of a running stream', () => {
    expect(describeRunning(running({ ...events, stream: streamOf(34) }))).toBe('items · 34 events');
    expect(describeRunning(running({ ...events, stream: streamOf(1) }))).toBe('items · 1 event');
  });

  it('shows the time while there are no events to count', () => {
    expect(describeRunning(running())).toBe('items · 2.1 s');
    expect(describeRunning(running({ status: 'sending', head: undefined, elapsedMs: 300 }))).toBe(
      'items · 300 ms',
    );
    expect(describeRunning(running({ stream: streamOf(0) }))).toBe('items · 2.1 s');
  });

  it('masks the sensitive values of the run in the label', () => {
    const secret = running({
      label: 'GET https://synthetic-secret.example.test/items',
      sensitiveValues: ['synthetic-secret'],
    });

    expect(describeRunning(secret)).toBe('GET https://••••••.example.test/items · 2.1 s');
  });

  it('shows nothing without a running request', () => {
    expect(runStatusText([])).toBeUndefined();
    expect(runStatusTooltip([])).toBeUndefined();
  });

  it('names the request when one is running', () => {
    const only = running({ ...events, stream: streamOf(34) });

    expect(runStatusText([only])).toBe('$(debug-stop) items · 34 events');
    expect(runStatusTooltip([only])).toBe('Stop items (Running · 34 events · 2.1 s)');
  });

  it('counts the requests when several are running', () => {
    const several = [running(), running({ id: 2, label: 'login' }), running({ id: 3 })];

    expect(runStatusText(several)).toBe('$(debug-stop) 3 running');
    expect(runStatusTooltip(several)).toBe('Stop one of the 3 running requests');
  });

  it('masks the tooltip and the pick items like the text', () => {
    const secret = running({
      label: 'login synthetic-secret',
      sensitiveValues: ['synthetic-secret'],
      key: 'file:///requests.http\n@login',
    });

    expect(runStatusText([secret])).toBe('$(debug-stop) login •••••• · 2.1 s');
    expect(runStatusTooltip([secret])).toBe('Stop login •••••• (Running · 2.1 s)');
    expect(runPickItems([secret])).toEqual([
      {
        label: 'login ••••••',
        description: 'Running · 2.1 s',
        key: 'file:///requests.http\n@login',
      },
    ]);
  });

  it('lists each running request with its live text for picking', () => {
    const pick = runPickItems([
      running({ ...events, stream: streamOf(34), key: 'a' }),
      running({ id: 2, label: 'login', key: 'b' }),
    ]);

    expect(pick).toEqual([
      { label: 'items', description: 'Running · 34 events · 2.1 s', key: 'a' },
      { label: 'login', description: 'Running · 2.1 s', key: 'b' },
    ]);
  });
});
