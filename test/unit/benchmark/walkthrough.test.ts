import { describe, expect, it } from 'vitest';
import { parseHttpFile } from '../../../src/http-file/parse';
import { walkthroughRequest, walkthroughTestFile } from '../../../src/benchmark/walkthrough';

const url = 'http://127.0.0.1:5000/stream?format=ndjson&rate=20&seconds=120&size=256';

describe('walkthroughRequest', () => {
  it('streams with one capture, one passing and one failing check', () => {
    const [request] = parseHttpFile(walkthroughRequest(url)).requests;
    expect(request?.requestLine.url).toBe(url);
    expect(request?.expects.map(({ text }) => text)).toEqual(['status == 200', 'status == 201']);
    expect(request?.directives.filter(({ kind }) => kind === 'capture')).toHaveLength(1);
  });
});

describe('walkthroughTestFile', () => {
  it('holds a passing, a failing, an erroring and a skipped request with a one-second stream', () => {
    const file = parseHttpFile(walkthroughTestFile(url));
    expect(file.requests.map(({ name }) => name)).toEqual([
      'passing',
      'failing',
      'refused',
      'dependant',
    ]);
    const short = 'http://127.0.0.1:5000/stream?format=ndjson&rate=20&seconds=1&size=256';
    expect(file.requests[0]?.requestLine.url).toBe(short);
    expect(file.requests[2]?.requestLine.url).toBe('http://127.0.0.1:1/');
    expect(file.requests[3]?.headers.map(({ value }) => value)).toEqual(['{{refused.threadId}}']);
  });
});
