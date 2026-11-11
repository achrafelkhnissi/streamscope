import { describe, expect, it } from 'vitest';
import { parseDuration } from '../../../src/runs/duration';

describe('parseDuration', () => {
  it('parses ms, s and m', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('5m')).toBe(300_000);
  });

  it('rejects other forms', () => {
    for (const text of ['1h', '30', 's', ' 30s', '30s ', '1.5s', '-1s', '']) {
      expect(parseDuration(text)).toBeUndefined();
    }
  });

  it('rejects durations longer than a timer can wait', () => {
    expect(parseDuration('2147483647ms')).toBe(2_147_483_647);
    expect(parseDuration('2147484s')).toBeUndefined();
  });
});
