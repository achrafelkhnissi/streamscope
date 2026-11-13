import { describe, expect, it } from 'vitest';
import {
  benchmarkEnabled,
  checkBenchmarkUrl,
  screenshotUrl,
  walkthroughSteps,
} from '../../../src/benchmark/contract';

describe('screenshotUrl', () => {
  it('asks the control server for a named screenshot', () => {
    expect(screenshotUrl('http://127.0.0.1:5000', 'webview-events live')).toBe(
      'http://127.0.0.1:5000/screenshot?name=webview-events%20live',
    );
  });
});

describe('walkthroughSteps', () => {
  it('lists the screenshots the response panel walkthrough takes', () => {
    expect(walkthroughSteps).toEqual([
      'events-live',
      'reply-live',
      'raw-live',
      'headers',
      'detail',
      'stopped',
      'checks',
    ]);
  });
});

describe('checkBenchmarkUrl', () => {
  it.each([
    'http://127.0.0.1:5000/stream?format=ndjson&rate=500&seconds=30&size=1024',
    'http://127.0.0.1:5000/',
    'http://127.0.0.1:65535/a/b',
    'http://127.0.0.1:5000/token',
  ])('accepts %s', (url) => {
    expect(checkBenchmarkUrl(url)).toBeUndefined();
  });

  it.each([
    ['https://127.0.0.1:5000/stream', 'https'],
    ['http://localhost:5000/stream', 'a host name'],
    ['http://127.0.0.1.example.com:5000/stream', 'a longer host name'],
    ['http://example.com:5000/stream', 'another host'],
    ['http://[::1]:5000/stream', 'IPv6 loopback'],
    ['http://127.0.0.2:5000/stream', 'another loopback address'],
    ['http://user:secret@127.0.0.1:5000/stream', 'user info'],
    ['http://127.0.0.1:5000@example.com/stream', 'a host hidden behind user info'],
    ['http://127.0.0.1/stream', 'no port'],
    ['http://127.0.0.1:0/stream', 'port 0'],
    ['http://127.0.0.1:65536/stream', 'a port above 65535'],
    ['http://127.0.0.1:5000', 'no path'],
    ['http://127.0.0.1:5000/a b', 'a space'],
    ['http://127.0.0.1:5000/a\nGET http://example.com/', 'a line break'],
    [' http://127.0.0.1:5000/stream', 'leading space'],
    ['', 'an empty string'],
  ])('refuses %j (%s)', (url) => {
    expect(checkBenchmarkUrl(url)).toBe(
      'The benchmark commands accept only http://127.0.0.1:<port>/… URLs.',
    );
  });
});

describe('benchmarkEnabled', () => {
  it('is on only when STREAMSCOPE_BENCHMARK is 1 and the extension is not a production install', () => {
    expect(benchmarkEnabled({ STREAMSCOPE_BENCHMARK: '1' }, false)).toBe(true);
    expect(benchmarkEnabled({ STREAMSCOPE_BENCHMARK: '1' }, true)).toBe(false);
  });

  it.each([
    {},
    { STREAMSCOPE_BENCHMARK: '' },
    { STREAMSCOPE_BENCHMARK: '0' },
    { STREAMSCOPE_BENCHMARK: 'true' },
  ])('is off for %j', (environment) => {
    expect(benchmarkEnabled(environment, false)).toBe(false);
  });
});
