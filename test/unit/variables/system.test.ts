import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSystemVariable, type SystemContext } from '../../../src/variables/system';

function context(): SystemContext & { randomCalls: [number, number][] } {
  const randomCalls: [number, number][] = [];
  return {
    randomCalls,
    now: () => new Date('2026-11-11T10:20:30.456Z'),
    uuid: () => '00000000-0000-4000-8000-000000000001',
    randomInt: (minInclusive, maxExclusive) => {
      randomCalls.push([minInclusive, maxExclusive]);
      return 7;
    },
  };
}

function value(expression: string): string {
  const result = resolveSystemVariable(expression, context());
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.value;
}

function problem(expression: string): string {
  const result = resolveSystemVariable(expression, context());
  if (result.ok) {
    throw new Error(`expected a problem, got ${result.value}`);
  }
  return result.message;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveSystemVariable', () => {
  it('gives the context uuid for $guid', () => {
    expect(value('$guid')).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('gives Unix seconds for $timestamp', () => {
    expect(value('$timestamp')).toBe('1794392430');
  });

  it('applies a $timestamp offset', () => {
    expect(value('$timestamp -3 h')).toBe('1794381630');
  });

  it('formats $datetime in UTC', () => {
    expect(value('$datetime iso8601')).toBe('2026-11-11T10:20:30.456Z');
    expect(value('$datetime rfc1123')).toBe('Wed, 11 Nov 2026 10:20:30 GMT');
  });

  it('formats $datetime with a custom format and an offset', () => {
    expect(value('$datetime "YYYY-MM-DD" 1 M')).toBe('2026-12-11');
    expect(value("$datetime 'DD MMM YYYY' -1 y")).toBe('11 Nov 2025');
  });

  it('formats $localDatetime in local time', () => {
    vi.stubEnv('TZ', 'Asia/Kolkata');

    expect(value('$localDatetime iso8601')).toBe('2026-11-11T15:50:30+05:30');
    expect(value('$localDatetime rfc1123')).toBe('Wed, 11 Nov 2026 15:50:30 +0530');
  });

  it('draws $randomInt from the context', () => {
    const ctx = context();

    expect(resolveSystemVariable('$randomInt 1 10', ctx)).toEqual({ ok: true, value: '7' });
    expect(ctx.randomCalls).toEqual([[1, 10]]);
  });

  it('rejects malformed arguments', () => {
    expect(problem('$timestamp 1 x')).toContain('expected format');
    expect(problem('$randomInt 5')).toContain('expected format');
    expect(problem('$datetime')).toContain('expected format');
    expect(problem('$guid 1')).toContain('expected format');
  });

  it('rejects a $randomInt range that is empty', () => {
    expect(problem('$randomInt 5 5')).toContain('below');
  });

  it('rejects unknown system variables', () => {
    expect(problem('$nope')).toContain('Unknown system variable');
  });

  it('reports variables that arrive in a later milestone', () => {
    expect(problem('$processEnv HOME')).toContain('not supported yet');
    expect(problem('$dotenv KEY')).toContain('not supported yet');
    expect(problem('$aadToken')).toContain('not supported yet');
    expect(problem('$aadV2Token')).toContain('not supported yet');
    expect(problem('$secret apiKey')).toContain('not supported yet');
  });
});
