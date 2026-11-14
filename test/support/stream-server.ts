import type * as http from 'node:http';
import { startHttpServer, type LocalServer } from './servers';

export type SyntheticFormat = 'sse' | 'ndjson';

function frame(format: SyntheticFormat, json: string): string {
  return format === 'sse' ? `data: ${json}\n\n` : `${json}\n`;
}

function padded(
  format: SyntheticFormat,
  fields: Record<string, unknown>,
  padField: string,
  size: number,
): string {
  const bare = frame(format, JSON.stringify({ ...fields, [padField]: '' }));
  const padding = 'x'.repeat(Math.max(0, size - Buffer.byteLength(bare)));
  return frame(format, JSON.stringify({ ...fields, [padField]: padding }));
}

export function runStarted(format: SyntheticFormat, size: number, sentAt: number): string {
  return padded(
    format,
    { type: 'RUN_STARTED', threadId: 'thread-1', runId: 'run-1', sentAt },
    'padding',
    size,
  );
}

export function runFinished(format: SyntheticFormat, size: number, sentAt: number): string {
  return padded(
    format,
    { type: 'RUN_FINISHED', threadId: 'thread-1', runId: 'run-1', sentAt },
    'padding',
    size,
  );
}

export function contentEvent(
  format: SyntheticFormat,
  sequence: number,
  size: number,
  sentAt: number,
): string {
  return padded(
    format,
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg-1', sequence, sentAt },
    'delta',
    size,
  );
}

export function numberParameter(value: string | null, fallback: number): number {
  const parsed = value === null ? Number.NaN : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function now(): number {
  return performance.timeOrigin + performance.now();
}

export function requestUrl(request: http.IncomingMessage): URL | undefined {
  try {
    return new URL(request.url ?? '/', 'http://localhost');
  } catch {
    return undefined;
  }
}

function stream(request: http.IncomingMessage, response: http.ServerResponse): void {
  const url = requestUrl(request);
  if (url === undefined) {
    response.writeHead(400).end();
    return;
  }
  if (url.pathname !== '/stream') {
    response.writeHead(404).end();
    return;
  }
  const format: SyntheticFormat = url.searchParams.get('format') === 'sse' ? 'sse' : 'ndjson';
  const rate = numberParameter(url.searchParams.get('rate'), 100);
  const size = numberParameter(url.searchParams.get('size'), 1024);
  const seconds = numberParameter(url.searchParams.get('seconds'), 10);
  const total = Math.floor(rate * seconds);
  const contentType =
    url.searchParams.get('type') ??
    (format === 'sse' ? 'text/event-stream' : 'application/x-ndjson');
  const delayMs = numberParameter(url.searchParams.get('delayMs'), 0);
  response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  let timer: NodeJS.Timeout | undefined;
  const begin = (): void => {
    response.write(runStarted(format, size, now()));
    const startedAt = performance.now();
    let sent = 0;
    const tick = (): void => {
      const elapsed = (performance.now() - startedAt) / 1000;
      const due = Math.min(total, Math.floor(rate * elapsed));
      const sentAt = now();
      let batch = '';
      while (sent < due) {
        sent += 1;
        batch += contentEvent(format, sent, size, sentAt);
      }
      if (batch !== '') {
        response.write(batch);
      }
      if (elapsed >= seconds) {
        clearInterval(timer);
        response.end(runFinished(format, size, now()));
      }
    };
    timer = setInterval(tick, 10);
  };
  if (delayMs === 0) {
    begin();
  } else {
    response.flushHeaders();
    timer = setTimeout(begin, delayMs);
  }
  response.on('close', () => {
    clearInterval(timer);
  });
}

export function startStreamServer(): Promise<LocalServer> {
  return startHttpServer(stream);
}
