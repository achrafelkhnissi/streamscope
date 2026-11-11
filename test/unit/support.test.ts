import { X509Certificate } from 'node:crypto';
import * as http from 'node:http';
import * as tls from 'node:tls';
import { describe, expect, it } from 'vitest';
import { createSelfSignedCertificate } from '../support/certificate';
import { startHttpServer } from '../support/servers';

function post(url: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'POST' }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        resolve(Buffer.concat(chunks).toString());
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

describe('test support', () => {
  it('creates a certificate Node accepts', () => {
    const { cert, key } = createSelfSignedCertificate(['localhost', '127.0.0.1']);
    const certificate = new X509Certificate(cert);

    expect(certificate.subjectAltName).toBe('DNS:localhost, IP Address:127.0.0.1');
    expect(certificate.subject).toBe('CN=localhost');
    expect(certificate.ca).toBe(true);
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(() => tls.createSecureContext({ cert, key })).not.toThrow();
  });

  it('records requests and socket lifecycle', async () => {
    const server = await startHttpServer((_request, response) => {
      response.end('done');
    });

    expect(await post(`${server.url}/items?page=2`, 'synthetic body')).toBe('done');
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.method).toBe('POST');
    expect(server.requests[0]?.url).toBe('/items?page=2');
    expect(server.requests[0]?.body.toString()).toBe('synthetic body');
    expect(server.sockets.opened).toBe(1);

    await server.close();

    expect(server.sockets.closed).toBe(server.sockets.opened);
  });
});
