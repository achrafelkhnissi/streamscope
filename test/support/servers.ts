import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  rawHeaders: string[];
  body: Buffer;
}

export interface LocalServer {
  url: string;
  port: number;
  requests: RecordedRequest[];
  sockets: { opened: number; closed: number };
  close(): Promise<void>;
}

function serve(
  server: net.Server,
  scheme: 'http' | 'https',
  requests: RecordedRequest[],
): Promise<LocalServer> {
  const sockets = { opened: 0, closed: 0 };
  const open = new Set<net.Socket>();
  server.on('connection', (socket: net.Socket) => {
    sockets.opened += 1;
    open.add(socket);
    socket.on('close', () => {
      sockets.closed += 1;
      open.delete(socket);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      resolve({
        url: `${scheme}://127.0.0.1:${String(address.port)}`,
        port: address.port,
        requests,
        sockets,
        close: async () => {
          const closing = [...open].map(
            (socket) =>
              new Promise<void>((done) => {
                socket.once('close', () => {
                  done();
                });
                socket.destroy();
              }),
          );
          await new Promise<void>((done) => {
            server.close(() => {
              done();
            });
          });
          await Promise.all(closing);
        },
      });
    });
  });
}

function recording(
  requests: RecordedRequest[],
  handler: http.RequestListener,
): http.RequestListener {
  return (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        rawHeaders: request.rawHeaders,
        body: Buffer.concat(chunks),
      });
      handler(request, response);
    });
  };
}

export function startHttpServer(handler: http.RequestListener): Promise<LocalServer> {
  const requests: RecordedRequest[] = [];
  return serve(http.createServer(recording(requests, handler)), 'http', requests);
}

export function startHttpsServer(
  credentials: { cert: string; key: string },
  handler: http.RequestListener,
): Promise<LocalServer> {
  const requests: RecordedRequest[] = [];
  return serve(https.createServer(credentials, recording(requests, handler)), 'https', requests);
}

export function startRawServer(onSocket: (socket: net.Socket) => void): Promise<LocalServer> {
  return serve(net.createServer(onSocket), 'http', []);
}
