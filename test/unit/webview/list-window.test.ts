import { describe, expect, it } from 'vitest';
import { listWindow, scrollTopFor, type ListInput } from '../../../src/webview/list-window';

const maxScrollPixels = 8_000_000;

function input(overrides: Partial<ListInput> = {}): ListInput {
  return {
    scrollTop: 0,
    clientHeight: 110,
    count: 100,
    rowHeight: 22,
    expanded: undefined,
    maxScrollPixels,
    ...overrides,
  };
}

describe('listWindow', () => {
  it('shows the rows under the viewport', () => {
    const area = listWindow(input({ scrollTop: 220 }));

    expect(area.first).toBe(11);
    expect(area.last).toBe(15);
    expect(area.spacerHeight).toBe(2200);
    expect(area.top(11)).toBe(220);
    expect(area.top(15)).toBe(308);
  });

  it('counts a row that is only partly visible', () => {
    const area = listWindow(input({ scrollTop: 230 }));

    expect(area.first).toBe(11);
    expect(area.last).toBe(16);
  });

  it('stops at the last row when the list is shorter than the viewport', () => {
    const area = listWindow(input({ count: 3 }));

    expect(area.first).toBe(1);
    expect(area.last).toBe(3);
    expect(area.spacerHeight).toBe(66);
  });

  it('has no rows when there are no events', () => {
    const area = listWindow(input({ count: 0 }));

    expect(area.last).toBeLessThan(area.first);
    expect(area.spacerHeight).toBe(0);
  });

  it('treats a scroll position past the end as the end', () => {
    const area = listWindow(input({ scrollTop: 1_000_000 }));

    expect(area.last).toBe(100);
    expect(area.top(100)).toBe(2178);
  });

  it('keeps the newest row reachable past eight million pixels', () => {
    const tall = input({ count: 1_000_000, clientHeight: 440 });
    const bottom = listWindow({ ...tall, scrollTop: maxScrollPixels - 440 });

    expect(bottom.spacerHeight).toBe(maxScrollPixels);
    expect(bottom.last).toBe(1_000_000);
    expect(bottom.first).toBe(999_981);
    expect(bottom.top(1_000_000)).toBe(maxScrollPixels - 22);
    expect(bottom.top(999_981)).toBe(maxScrollPixels - 440);

    const top = listWindow(tall);

    expect(top.first).toBe(1);
    expect(top.last).toBe(20);
    expect(top.top(1)).toBe(0);
  });

  it('places the rows under the viewport next to each other when scaled', () => {
    const area = listWindow(input({ count: 1_000_000, clientHeight: 440, scrollTop: 4_000_000 }));

    expect(area.first).toBeGreaterThan(500_000);
    expect(area.last).toBeLessThan(1_000_000);
    expect(area.top(area.first + 1) - area.top(area.first)).toBeCloseTo(22, 6);
    expect(area.top(area.first)).toBeLessThanOrEqual(4_000_000);
    expect(area.top(area.first) + 22).toBeGreaterThan(4_000_000);
  });

  it('shifts rows after an expanded event by its height', () => {
    const area = listWindow(input({ clientHeight: 220, expanded: { index: 5, height: 100 } }));

    expect(area.spacerHeight).toBe(2300);
    expect(area.top(4)).toBe(66);
    expect(area.top(5)).toBe(88);
    expect(area.top(6)).toBe(210);
    expect(area.first).toBe(1);
    expect(area.last).toBe(6);
  });

  it('keeps an expanded event in the window while its detail is on screen', () => {
    const area = listWindow(input({ scrollTop: 150, expanded: { index: 5, height: 100 } }));

    expect(area.first).toBe(5);
    expect(area.last).toBe(8);
    expect(area.top(5)).toBe(88);
  });
});

describe('scrollTopFor', () => {
  it('leaves a row that is already visible where it is', () => {
    expect(scrollTopFor(input({ scrollTop: 22 }), 3, 'nearest')).toBe(22);
  });

  it('brings a row below the viewport up to its bottom edge', () => {
    expect(scrollTopFor(input(), 10, 'nearest')).toBe(110);
  });

  it('brings a row above the viewport down to its top edge', () => {
    expect(scrollTopFor(input({ scrollTop: 220 }), 2, 'nearest')).toBe(22);
  });

  it('puts a row at the top of the viewport', () => {
    expect(scrollTopFor(input(), 50, 'start')).toBe(1078);
  });

  it('never scrolls past the end', () => {
    expect(scrollTopFor(input(), 100, 'start')).toBe(2090);
  });

  it('accounts for an expanded event above the row', () => {
    expect(scrollTopFor(input({ expanded: { index: 5, height: 100 } }), 20, 'start')).toBe(518);
  });

  it('reaches any row of a scaled list', () => {
    const tall = input({ count: 1_000_000, clientHeight: 440 });

    expect(scrollTopFor(tall, 1_000_000, 'nearest')).toBe(maxScrollPixels - 440);

    const scrollTop = scrollTopFor(tall, 500_000, 'start');
    const area = listWindow({ ...tall, scrollTop });

    expect(area.first).toBe(500_000);
    expect(area.top(500_000)).toBeLessThanOrEqual(scrollTop);
    expect(area.top(500_000)).toBeGreaterThan(scrollTop - 22);
  });

  it('scrolls a scaled list by whole pixels so a restored first row stays first', () => {
    const tall = input({ count: 1_000_000, clientHeight: 440 });

    for (const index of [31, 123_457, 500_001, 999_970]) {
      const scrollTop = scrollTopFor(tall, index, 'start');

      expect(Number.isInteger(scrollTop)).toBe(true);
      expect(listWindow({ ...tall, scrollTop }).first).toBe(index);
    }
  });

  it('scrolls a scaled list by whole pixels and keeps a revealed row fully in view', () => {
    const tall = input({ count: 1_000_000, clientHeight: 440 });

    for (const index of [31, 123_457, 500_001, 999_970]) {
      for (const from of [0, maxScrollPixels]) {
        const scrollTop = scrollTopFor({ ...tall, scrollTop: from }, index, 'nearest');
        const area = listWindow({ ...tall, scrollTop });

        expect(Number.isInteger(scrollTop)).toBe(true);
        expect(area.top(index)).toBeGreaterThanOrEqual(scrollTop);
        expect(area.top(index) + 22).toBeLessThanOrEqual(scrollTop + 440);
      }
    }
  });
});
