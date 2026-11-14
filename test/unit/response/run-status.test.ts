import { describe, expect, it } from 'vitest';
import {
  describeRunning,
  historyItems,
  panelTitle,
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

  it('says what a waiting run waits for', () => {
    const waiting = running({
      status: 'waiting',
      head: undefined,
      sent: undefined,
      waitingFor: 'startRun › threadId',
      elapsedMs: 3400,
    });

    expect(describeRunning(waiting)).toBe('items · waiting for startRun › threadId');
    expect(runStatusTooltip([waiting])).toBe('Stop items (Waiting for startRun › threadId · 3 s)');
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

describe('history items', () => {
  const at = (hours: number, minutes: number, seconds: number): number =>
    new Date(2026, 10, 12, hours, minutes, seconds).getTime();

  it('lists the runs as given with label, outcome and start time', () => {
    const items = historyItems([
      snapshot({ id: 7, ...events, stream: streamOf(34), wallStartedAt: at(10, 21, 33) }),
      snapshot({
        id: 6,
        label: 'login',
        status: 'failed',
        head: undefined,
        failure: { kind: 'refused', message: 'Connection refused.' },
        wallStartedAt: at(9, 5, 7),
      }),
    ]);

    expect(items).toEqual([
      { id: 7, label: 'items', description: '200 OK · 34 events · 120 ms', detail: '10:21:33' },
      { id: 6, label: 'login', description: 'Failed: Connection refused.', detail: '09:05:07' },
    ]);
  });

  it('describes a run that is still running by its live state', () => {
    const [item] = historyItems([
      running({ id: 3, ...events, stream: streamOf(2), wallStartedAt: at(8, 0, 0) }),
    ]);

    expect(item).toEqual({
      id: 3,
      label: 'items',
      description: 'Running · 2 events · 2.1 s',
      detail: '08:00:00',
    });
  });

  it('masks the sensitive values in the label and the outcome', () => {
    const [item] = historyItems([
      snapshot({
        label: 'GET https://synthetic-secret.example.test/items',
        status: 'failed',
        head: undefined,
        failure: { kind: 'refused', message: 'Could not reach synthetic-secret.example.test.' },
        sensitiveValues: ['synthetic-secret'],
      }),
    ]);

    expect(item?.label).toBe('GET https://••••••.example.test/items');
    expect(item?.description).toBe('Failed: Could not reach ••••••.example.test.');
    expect(`${item?.label ?? ''}${item?.description ?? ''}${item?.detail ?? ''}`).not.toContain(
      'synthetic-secret',
    );
  });

  it('lists nothing for no runs', () => {
    expect(historyItems([])).toEqual([]);
  });
});

describe('panelTitle', () => {
  it('is the masked label of a live panel', () => {
    expect(panelTitle(snapshot(), false)).toBe('items');
    expect(
      panelTitle(
        snapshot({ label: 'login synthetic-secret', sensitiveValues: ['synthetic-secret'] }),
        false,
      ),
    ).toBe('login ••••••');
  });

  it('adds the start time to the title of a run reopened read-only', () => {
    const reopened = snapshot({ wallStartedAt: new Date(2026, 10, 12, 10, 21, 33).getTime() });

    expect(panelTitle(reopened, true)).toBe('items · 10:21:33');
    expect(
      panelTitle(
        { ...reopened, label: 'login synthetic-secret', sensitiveValues: ['synthetic-secret'] },
        true,
      ),
    ).toBe('login •••••• · 10:21:33');
  });
});
