import * as tls from 'node:tls';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { trustedCertificates } from '../../../src/transport/certificates';
import { createSelfSignedCertificate } from '../../support/certificate';
import { startHttpsServer, startRawServer, type LocalServer } from '../../support/servers';
import { send } from './harness';

const servers: LocalServer[] = [];
let credentials: { cert: string; key: string };

async function https(): Promise<LocalServer> {
  const server = await startHttpsServer(credentials, (_request, response) => {
    response.end('secure');
  });
  servers.push(server);
  return server;
}

beforeAll(() => {
  credentials = createSelfSignedCertificate(['localhost', '127.0.0.1']);
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('TLS', () => {
  it('rejects a self-signed server by default with a tls failure', async () => {
    const server = await https();

    const { outcome } = await send({ url: server.url });

    expect(outcome.kind === 'failed' && outcome.failure.kind).toBe('tls');
    expect(outcome.kind === 'failed' && outcome.failure.message).toContain(
      'streamscope.request.caFile',
    );
  });

  it('accepts it when verification is off for the request', async () => {
    const server = await https();

    const { outcome, sink } = await send({ url: server.url }, { rejectUnauthorized: false });

    expect(outcome.kind).toBe('completed');
    expect(sink.body()).toBe('secure');
  });

  it('accepts it when its certificate is a custom CA', async () => {
    const server = await https();

    const { outcome, sink } = await send(
      { url: server.url },
      { ca: trustedCertificates([credentials.cert]) },
    );

    expect(outcome.kind).toBe('completed');
    expect(sink.body()).toBe('secure');
  });

  it('keeps the default and system roots when a custom CA is added', () => {
    const defaults = tls.getCACertificates('default');
    const system = tls.getCACertificates('system');
    const repeated = defaults[0] ?? credentials.cert;

    const trusted = trustedCertificates([credentials.cert, repeated, credentials.cert]);

    expect(trusted.slice(0, defaults.length)).toEqual(defaults);
    expect(trusted).toEqual(expect.arrayContaining(system));
    expect(trusted[trusted.length - 1]).toBe(credentials.cert);
    expect(new Set(trusted).size).toBe(trusted.length);
  });

  it('records the TLS handshake time', async () => {
    const server = await https();

    const { outcome } = await send({ url: server.url }, { rejectUnauthorized: false });

    expect(outcome.timing.connectMs).toBeGreaterThanOrEqual(0);
    expect(outcome.timing.tlsMs).toBeGreaterThanOrEqual(0);
  });

  it('fails with connect-timeout when the TLS handshake never completes', async () => {
    const server = await startRawServer((socket) => socket.resume());
    servers.push(server);

    const { outcome } = await send(
      { url: server.url.replace('http:', 'https:') },
      { connectTimeoutMs: 200 },
    );

    expect(outcome.kind === 'failed' && outcome.failure.kind).toBe('connect-timeout');
  });
});
