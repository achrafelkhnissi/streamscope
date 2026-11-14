import { describe, expect, it } from 'vitest';
import {
  activationWorkspace,
  readActivationResult,
  summariseActivation,
} from '../../benchmark/activation';

describe('summariseActivation', () => {
  it('reports the median and the slowest run', () => {
    expect(summariseActivation([12.5, 9, 30, 10, 11])).toEqual({
      runsMs: [12.5, 9, 30, 10, 11],
      medianMs: 11,
      maxMs: 30,
    });
    expect(summariseActivation([4, 1, 3, 2]).medianMs).toBe(2.5);
  });
});

describe('activationWorkspace', () => {
  it('writes the requested number of synthetic .http files', () => {
    const files = activationWorkspace(300);
    expect(files).toHaveLength(300);
    expect(new Set(files.map(({ name }) => name)).size).toBe(300);
    expect(files[0]).toEqual({
      name: 'requests/request-001.http',
      content: '### Item 1\nGET https://api.example.test/items/1\n',
    });
    expect(files.every(({ name }) => name.endsWith('.http'))).toBe(true);
  });
});

describe('readActivationResult', () => {
  it('reads the time the driver wrote', () => {
    expect(readActivationResult('{"activationMs":14.2}')).toBe(14.2);
  });

  it('throws the driver error or a missing result', () => {
    expect(() => readActivationResult('{"error":"not active"}')).toThrow('not active');
    expect(() => readActivationResult(undefined)).toThrow('The benchmark driver wrote no result.');
    expect(() => readActivationResult('{}')).toThrow(
      'The benchmark driver wrote no activation time.',
    );
  });
});
