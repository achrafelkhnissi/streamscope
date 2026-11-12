import type { RunSnapshot } from '../../../src/runs/run';

export function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: 1,
    key: 'file:///requests.http\n@items',
    label: 'items',
    status: 'completed',
    startedAt: 0,
    elapsedMs: 120,
    sent: {
      method: 'GET',
      url: 'https://api.example.test/items',
      headers: [
        ['Authorization', 'Bearer synthetic'],
        ['Host', 'api.example.test'],
        ['Accept-Encoding', 'gzip, deflate, br, zstd'],
      ],
    },
    head: {
      httpVersion: '1.1',
      status: 200,
      statusText: 'OK',
      headers: [
        ['Content-Type', 'application/json'],
        ['Set-Cookie', 'session=synthetic'],
      ],
    },
    hops: [],
    timing: { dnsMs: 3, connectMs: 12.4, tlsMs: 20, firstByteMs: 45, totalMs: 80 },
    wireBytes: 512,
    body: new Uint8Array(1229),
    failure: undefined,
    problems: [],
    sensitiveValues: [],
    ...overrides,
  };
}
