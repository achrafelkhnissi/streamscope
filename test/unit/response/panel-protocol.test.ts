import { describe, expect, expectTypeOf, it } from 'vitest';
import type { EventKind } from '../../../src/events/model';
import {
  panelLimits,
  panelViews,
  parsePanelMessage,
  type PanelEventKind,
  type PanelRunState,
  type PanelView,
} from '../../../src/response/panel-protocol';
import type { RunStatus } from '../../../src/runs/run';

const eventCount = 1000;

function parse(value: unknown, count = eventCount) {
  return parsePanelMessage(value, count);
}

describe('panel protocol', () => {
  it('lists the same event kinds and run states as the extension side', () => {
    expectTypeOf<PanelEventKind>().toEqualTypeOf<EventKind>();
    expectTypeOf<PanelRunState>().toEqualTypeOf<RunStatus>();
  });

  it('names every view the page can show', () => {
    expectTypeOf(panelViews).toEqualTypeOf<readonly PanelView[]>();
    expect(panelViews).toEqual(['events', 'reply', 'raw', 'headers', 'body', 'checks']);
  });

  it('pins the limits the two sides share', () => {
    expect(panelLimits).toEqual({
      rowsPerMessage: 500,
      messageBytes: 1_048_576,
      inlineEventBytes: 65_536,
      inlineBodyBytes: 1_048_576,
      previewLines: 200,
      rawTailChars: 2_097_152,
      windowRows: 400,
    });
  });
});

describe('parsePanelMessage', () => {
  it('accepts every message the page may send', () => {
    expect(parse({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(parse({ type: 'stop' })).toEqual({ type: 'stop' });
    expect(parse({ type: 'save', run: 3 })).toEqual({ type: 'save', run: 3 });
    expect(parse({ type: 'window', run: 3, start: 10, end: 60, following: true })).toEqual({
      type: 'window',
      run: 3,
      start: 10,
      end: 60,
      following: true,
    });
    expect(parse({ type: 'rendered', run: 3, newest: 1000 })).toEqual({
      type: 'rendered',
      run: 3,
      newest: 1000,
    });
    expect(parse({ type: 'detail', run: 3, index: 1 })).toEqual({
      type: 'detail',
      run: 3,
      index: 1,
    });
    expect(parse({ type: 'openEvent', run: 3, index: 1000 })).toEqual({
      type: 'openEvent',
      run: 3,
      index: 1000,
    });
    expect(parse({ type: 'open', run: 3, target: 'body' })).toEqual({
      type: 'open',
      run: 3,
      target: 'body',
    });
    expect(parse({ type: 'open', run: 3, target: 'headers' })).toEqual({
      type: 'open',
      run: 3,
      target: 'headers',
    });
    for (const view of panelViews) {
      expect(parse({ type: 'tab', view })).toEqual({ type: 'tab', view });
    }
  });

  it('returns a copy, never the object the page sent', () => {
    const sent = { type: 'stop' };

    expect(parse(sent)).not.toBe(sent);
  });

  it('accepts indexes from 1 to the event count and windows of up to 400 rows', () => {
    expect(parse({ type: 'detail', run: 1, index: 10 }, 10)).toEqual({
      type: 'detail',
      run: 1,
      index: 10,
    });
    expect(parse({ type: 'window', run: 1, start: 1, end: 400, following: false })).toBeDefined();
    expect(parse({ type: 'window', run: 1, start: 7, end: 7, following: false })).toBeDefined();
  });

  it('rejects an index outside the events that exist', () => {
    expect(parse({ type: 'detail', run: 1, index: 0 })).toBeUndefined();
    expect(parse({ type: 'detail', run: 1, index: 11 }, 10)).toBeUndefined();
    expect(parse({ type: 'detail', run: 1, index: 1 }, 0)).toBeUndefined();
    expect(parse({ type: 'detail', run: 1, index: -1 })).toBeUndefined();
    expect(parse({ type: 'openEvent', run: 1, index: 11 }, 10)).toBeUndefined();
    expect(parse({ type: 'rendered', run: 1, newest: 11 }, 10)).toBeUndefined();
    expect(parse({ type: 'rendered', run: 1, newest: 0 })).toBeUndefined();
  });

  it('rejects an index that is not a whole number', () => {
    for (const index of [
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '1',
      null,
      undefined,
      1n,
      [1],
    ]) {
      expect(parse({ type: 'detail', run: 1, index })).toBeUndefined();
    }
  });

  it('rejects a run that is not a positive whole number', () => {
    for (const run of [0, -1, 1.5, Number.NaN, '1', null, undefined]) {
      expect(parse({ type: 'detail', run, index: 1 })).toBeUndefined();
    }
    expect(parse({ type: 'detail', index: 1 })).toBeUndefined();
  });

  it('rejects a save without a positive whole-number run or with any other key', () => {
    for (const run of [0, -1, 1.5, Number.NaN, '1', null, undefined]) {
      expect(parse({ type: 'save', run })).toBeUndefined();
    }
    expect(parse({ type: 'save' })).toBeUndefined();
    expect(parse({ type: 'save', run: 1, path: '/tmp/out.ndjson' })).toBeUndefined();
    expect(parse({ type: 'save', run: 1, uri: 'file:///x' })).toBeUndefined();
  });

  it('rejects a window that is reversed, too large or outside the events', () => {
    expect(parse({ type: 'window', run: 1, start: 1, end: 401, following: false })).toBeUndefined();
    expect(parse({ type: 'window', run: 1, start: 9, end: 8, following: false })).toBeUndefined();
    expect(parse({ type: 'window', run: 1, start: 0, end: 10, following: false })).toBeUndefined();
    expect(
      parse({ type: 'window', run: 1, start: 1, end: 11, following: false }, 10),
    ).toBeUndefined();
    expect(parse({ type: 'window', run: 1, start: 1, end: 10, following: 1 })).toBeUndefined();
    expect(parse({ type: 'window', run: 1, start: 1, end: 10 })).toBeUndefined();
  });

  it('rejects an open target or a view that is not on the list', () => {
    expect(parse({ type: 'open', run: 1, target: '../x' })).toBeUndefined();
    expect(parse({ type: 'open', run: 1, target: 'file:///etc/passwd' })).toBeUndefined();
    expect(parse({ type: 'open', run: 1, target: 'events' })).toBeUndefined();
    expect(parse({ type: 'open', run: 1 })).toBeUndefined();
    expect(parse({ type: 'tab', view: 'html' })).toBeUndefined();
    expect(parse({ type: 'tab', view: 'Events' })).toBeUndefined();
    expect(parse({ type: 'tab', view: 1 })).toBeUndefined();
    expect(parse({ type: 'tab' })).toBeUndefined();
  });

  it('rejects an unknown type or one that names something on the prototype', () => {
    expect(parse({ type: 'capture' })).toBeUndefined();
    expect(parse({ type: 'command', id: 'workbench.action.quit' })).toBeUndefined();
    expect(parse({ type: '__proto__' })).toBeUndefined();
    expect(parse({ type: 'constructor' })).toBeUndefined();
    expect(parse({ type: 'toString' })).toBeUndefined();
    expect(parse({ type: 1 })).toBeUndefined();
    expect(parse({ type: undefined })).toBeUndefined();
    expect(parse({})).toBeUndefined();
  });

  it('rejects any extra key, including a url, a command id or a path', () => {
    expect(parse({ type: 'ready', extra: 1 })).toBeUndefined();
    expect(parse({ type: 'stop', command: 'workbench.action.quit' })).toBeUndefined();
    expect(parse({ type: 'detail', run: 1, index: 1, path: '/etc/passwd' })).toBeUndefined();
    expect(parse({ type: 'open', run: 1, target: 'body', uri: 'file:///x' })).toBeUndefined();
    expect(parse({ type: 'tab', view: 'raw', url: 'https://example.test' })).toBeUndefined();
    expect(
      parse({ type: 'window', run: 1, start: 1, end: 2, following: true, offset: 0 }),
    ).toBeUndefined();
    expect(parse(JSON.parse('{"type":"ready","__proto__":{"polluted":true}}'))).toBeUndefined();
    expect(parse({ type: 'ready', [Symbol('extra')]: 1 })).toBeUndefined();
  });

  it('rejects a missing key', () => {
    expect(parse({ type: 'rendered', run: 1 })).toBeUndefined();
    expect(parse({ type: 'detail', index: 1 })).toBeUndefined();
    expect(parse({ type: 'window', run: 1, start: 1, end: 2 })).toBeUndefined();
  });

  it('rejects anything that is not a plain object', () => {
    for (const value of [
      null,
      undefined,
      'ready',
      '{"type":"ready"}',
      42,
      true,
      [],
      [{ type: 'ready' }],
      ['type', 'ready'],
      () => ({ type: 'ready' }),
    ]) {
      expect(parse(value)).toBeUndefined();
    }
  });
});
