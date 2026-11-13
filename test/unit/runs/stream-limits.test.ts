import { describe, expect, it } from 'vitest';
import { resolveSpillLimits, resolveStreamLimits } from '../../../src/runs/stream-limits';
import { defaultSpillLimits, defaultStreamLimits } from '../../../src/streaming/limits';

const defaults = { maxEventSize: '16MiB', memoryEvents: 10_000, typeFields: ['type', 'event'] };

function failure(result: { ok: boolean; message?: string }): string | undefined {
  return result.ok ? undefined : result.message;
}

describe('resolveStreamLimits', () => {
  it('merges the settings into the default stream limits', () => {
    expect(
      resolveStreamLimits({ maxEventSize: '512KiB', memoryEvents: 250, typeFields: ['kind'] }),
    ).toEqual({
      ok: true,
      limits: {
        ...defaultStreamLimits,
        maxEventSize: 524_288,
        memoryEvents: 250,
        typeFields: ['kind'],
      },
    });
  });

  it('accepts the default settings', () => {
    expect(
      resolveStreamLimits({ ...defaults, typeFields: [...defaultStreamLimits.typeFields] }),
    ).toEqual({ ok: true, limits: defaultStreamLimits });
  });

  it('names an event size it cannot read', () => {
    expect(failure(resolveStreamLimits({ ...defaults, maxEventSize: '16mb' }))).toBe(
      'streamscope.stream.maxEventSize must be a size such as 512KiB, 16MiB or 2GiB, not "16mb".',
    );
  });

  it('holds the event size from 1KiB to 256MiB', () => {
    const range = 'streamscope.stream.maxEventSize must be a size from 1KiB to 256MiB, not';
    expect(resolveStreamLimits({ ...defaults, maxEventSize: '1KiB' })).toMatchObject({
      ok: true,
      limits: { maxEventSize: 1024 },
    });
    expect(resolveStreamLimits({ ...defaults, maxEventSize: '262144KiB' })).toMatchObject({
      ok: true,
      limits: { maxEventSize: 268_435_456 },
    });
    expect(resolveStreamLimits({ ...defaults, maxEventSize: '256MiB' })).toMatchObject({
      ok: true,
    });
    expect(failure(resolveStreamLimits({ ...defaults, maxEventSize: '0KiB' }))).toBe(
      `${range} "0KiB".`,
    );
    expect(failure(resolveStreamLimits({ ...defaults, maxEventSize: '262145KiB' }))).toBe(
      `${range} "262145KiB".`,
    );
    expect(failure(resolveStreamLimits({ ...defaults, maxEventSize: '257MiB' }))).toBe(
      `${range} "257MiB".`,
    );
    expect(failure(resolveStreamLimits({ ...defaults, maxEventSize: '2GiB' }))).toBe(
      `${range} "2GiB".`,
    );
  });

  it('holds the events in memory from 100 to 1,000,000', () => {
    const range = 'streamscope.stream.memoryEvents must be a whole number from 100 to 1000000, not';
    expect(resolveStreamLimits({ ...defaults, memoryEvents: 100 })).toMatchObject({
      ok: true,
      limits: { memoryEvents: 100 },
    });
    expect(resolveStreamLimits({ ...defaults, memoryEvents: 1_000_000 })).toMatchObject({
      ok: true,
      limits: { memoryEvents: 1_000_000 },
    });
    expect(failure(resolveStreamLimits({ ...defaults, memoryEvents: 99 }))).toBe(`${range} 99.`);
    expect(failure(resolveStreamLimits({ ...defaults, memoryEvents: 1_000_001 }))).toBe(
      `${range} 1000001.`,
    );
    expect(failure(resolveStreamLimits({ ...defaults, memoryEvents: 100.5 }))).toBe(
      `${range} 100.5.`,
    );
    expect(failure(resolveStreamLimits({ ...defaults, memoryEvents: Number.NaN }))).toBe(
      `${range} NaN.`,
    );
  });

  it('wants one or more non-empty type field names', () => {
    expect(resolveStreamLimits({ ...defaults, typeFields: ['a'] })).toMatchObject({
      ok: true,
      limits: { typeFields: ['a'] },
    });
    const message = (value: unknown) =>
      failure(resolveStreamLimits({ ...defaults, typeFields: value }));
    expect(message([])).toBe(
      'streamscope.stream.typeFields must be a non-empty list of field names, not [].',
    );
    expect(message([''])).toBe(
      'streamscope.stream.typeFields must be a non-empty list of field names, not [""].',
    );
    expect(message(['type', ''])).toBe(
      'streamscope.stream.typeFields must be a non-empty list of field names, not ["type",""].',
    );
    expect(message('type')).toBe(
      'streamscope.stream.typeFields must be a non-empty list of field names, not "type".',
    );
    expect(message([1])).toBe(
      'streamscope.stream.typeFields must be a non-empty list of field names, not [1].',
    );
    expect(message(null)).toBe(
      'streamscope.stream.typeFields must be a non-empty list of field names, not null.',
    );
  });

  it('reports the event size before the other settings', () => {
    expect(
      failure(resolveStreamLimits({ maxEventSize: 'x', memoryEvents: 1, typeFields: [] })),
    ).toMatch(/^streamscope\.stream\.maxEventSize /);
    expect(failure(resolveStreamLimits({ ...defaults, memoryEvents: 1, typeFields: [] }))).toMatch(
      /^streamscope\.stream\.memoryEvents /,
    );
  });
});

describe('resolveSpillLimits', () => {
  it('merges the sizes into the default spill limits', () => {
    expect(resolveSpillLimits({ maxSpillSize: '64MiB', maxTotalSpillSize: '1GiB' })).toEqual({
      ok: true,
      limits: { ...defaultSpillLimits, maxFileSize: 67_108_864, maxTotalSize: 1_073_741_824 },
    });
  });

  it('accepts the default settings', () => {
    expect(resolveSpillLimits({ maxSpillSize: '512MiB', maxTotalSpillSize: '2GiB' })).toEqual({
      ok: true,
      limits: defaultSpillLimits,
    });
  });

  it('names a size it cannot read', () => {
    expect(failure(resolveSpillLimits({ maxSpillSize: '1 GiB', maxTotalSpillSize: '2GiB' }))).toBe(
      'streamscope.stream.maxSpillSize must be a size such as 512KiB, 16MiB or 2GiB, not "1 GiB".',
    );
    expect(failure(resolveSpillLimits({ maxSpillSize: '1GiB', maxTotalSpillSize: '' }))).toBe(
      'streamscope.stream.maxTotalSpillSize must be a size such as 512KiB, 16MiB or 2GiB, not "".',
    );
  });

  it('wants a spill size of at least 1MiB', () => {
    expect(resolveSpillLimits({ maxSpillSize: '1MiB', maxTotalSpillSize: '1MiB' })).toMatchObject({
      ok: true,
      limits: { maxFileSize: 1_048_576, maxTotalSize: 1_048_576 },
    });
    expect(
      resolveSpillLimits({ maxSpillSize: '1024KiB', maxTotalSpillSize: '2GiB' }),
    ).toMatchObject({ ok: true });
    for (const size of ['1023KiB', '0MiB']) {
      expect(failure(resolveSpillLimits({ maxSpillSize: size, maxTotalSpillSize: '2GiB' }))).toBe(
        `streamscope.stream.maxSpillSize must be a size of at least 1MiB, not "${size}".`,
      );
    }
  });

  it('wants a total spill size of at least the size of one spill', () => {
    expect(
      resolveSpillLimits({ maxSpillSize: '512MiB', maxTotalSpillSize: '512MiB' }),
    ).toMatchObject({ ok: true });
    expect(
      resolveSpillLimits({ maxSpillSize: '1GiB', maxTotalSpillSize: '1024MiB' }),
    ).toMatchObject({ ok: true });
    expect(
      failure(resolveSpillLimits({ maxSpillSize: '512MiB', maxTotalSpillSize: '511MiB' })),
    ).toBe(
      'streamscope.stream.maxTotalSpillSize must be a size of at least streamscope.stream.maxSpillSize ("512MiB"), not "511MiB".',
    );
    expect(
      failure(resolveSpillLimits({ maxSpillSize: '1GiB', maxTotalSpillSize: '1023MiB' })),
    ).toMatch(/^streamscope\.stream\.maxTotalSpillSize must be a size of at least /);
  });
});
