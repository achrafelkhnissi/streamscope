import { afterEach, describe, expect, it, vi } from 'vitest';
import { addOffset, formatDate } from '../../../src/variables/dates';

const now = new Date('2026-11-11T10:20:30.456Z');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('addOffset', () => {
  it('adds calendar months and clamps to the month end', () => {
    expect(addOffset(new Date('2026-01-31T10:00:00Z'), 1, 'M', 'utc').toISOString()).toBe(
      '2026-02-28T10:00:00.000Z',
    );
  });

  it('adds years, quarters, weeks and days on the calendar', () => {
    expect(addOffset(now, -1, 'y', 'utc').toISOString()).toBe('2025-11-11T10:20:30.456Z');
    expect(addOffset(now, 1, 'Q', 'utc').toISOString()).toBe('2027-02-11T10:20:30.456Z');
    expect(addOffset(now, 2, 'w', 'utc').toISOString()).toBe('2026-11-25T10:20:30.456Z');
    expect(addOffset(now, -11, 'd', 'utc').toISOString()).toBe('2026-10-31T10:20:30.456Z');
  });

  it('adds hours, minutes, seconds and milliseconds as elapsed time', () => {
    expect(addOffset(now, 14, 'h', 'utc').toISOString()).toBe('2026-11-12T00:20:30.456Z');
    expect(addOffset(now, -21, 'm', 'utc').toISOString()).toBe('2026-11-11T09:59:30.456Z');
    expect(addOffset(now, 30, 's', 'utc').toISOString()).toBe('2026-11-11T10:21:00.456Z');
    expect(addOffset(now, 544, 'ms', 'utc').toISOString()).toBe('2026-11-11T10:20:31.000Z');
  });
});

describe('formatDate', () => {
  it('formats every supported token', () => {
    expect(
      formatDate(
        now,
        '[at] YYYY YY M MM MMM MMMM D DD d dd ddd dddd H HH h hh m mm s ss SSS A a Z ZZ',
        'utc',
      ),
    ).toBe(
      'at 2026 26 11 11 Nov November 11 11 3 We Wed Wednesday 10 10 10 10 20 20 30 30 456 AM am +00:00 +0000',
    );
  });

  it('formats in local time', () => {
    vi.stubEnv('TZ', 'Asia/Kolkata');

    expect(formatDate(now, 'HH:mm Z', 'local')).toBe('15:50 +05:30');
  });

  it('uses a 12-hour clock in the afternoon', () => {
    expect(formatDate(new Date('2026-11-11T00:05:00Z'), 'h A', 'utc')).toBe('12 AM');
    expect(formatDate(new Date('2026-11-11T13:05:00Z'), 'hh a', 'utc')).toBe('01 pm');
  });
});
