import { describe, expect, it } from 'vitest';
import { parseHttpFile } from '../../../src/http-file/parse';
import { concatList, gifProblem, sceneFiles } from '../../benchmark/record';

const streamUrl = 'http://127.0.0.1:5000/stream?format=ndjson&rate=20&seconds=600';

describe('sceneFiles', () => {
  it('streams 500 events/s of 1 KiB for the stream scene', () => {
    const [file] = sceneFiles('stream', streamUrl);
    expect(file?.name).toBe('agent.http');
    const [request] = parseHttpFile(file?.content ?? '').requests;
    expect(request?.requestLine.url).toBe(
      'http://127.0.0.1:5000/stream?format=ndjson&rate=500&seconds=12&size=1024',
    );
  });

  it('runs three requests with one skipped dependant for the file-run scene', () => {
    const [file] = sceneFiles('file-run', streamUrl);
    expect(file?.name).toBe('flow.http');
    const requests = parseHttpFile(file?.content ?? '').requests;
    expect(requests.map(({ name }) => name)).toEqual(['startRun', 'checkout', 'confirm']);
    expect(requests[1]?.requestLine.url).toBe('http://127.0.0.1:1/checkout');
    expect(requests[2]?.headers.map(({ value }) => value)).toEqual(['{{checkout.orderId}}']);
  });
});

describe('concatList', () => {
  it('holds each frame until the next one and the last until the end', () => {
    expect(
      concatList(
        [
          { file: '00000.jpeg', timestamp: 10 },
          { file: '00001.jpeg', timestamp: 10.25 },
          { file: '00002.jpeg', timestamp: 11 },
        ],
        12.5,
      ),
    ).toBe(
      [
        "file '00000.jpeg'",
        'duration 0.250',
        "file '00001.jpeg'",
        'duration 0.750',
        "file '00002.jpeg'",
        'duration 1.500',
        "file '00002.jpeg'",
        '',
      ].join('\n'),
    );
  });
});

describe('gifProblem', () => {
  it('accepts a GIF up to 8 MB and rejects a larger one', () => {
    expect(gifProblem(8 * 1024 * 1024)).toBeUndefined();
    expect(gifProblem(8 * 1024 * 1024 + 1)).toBe(
      'The recording is 8.0 MB, over the 8 MB limit. Shorten the scene or lower the width.',
    );
  });
});
