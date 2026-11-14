import type * as http from 'node:http';
import { startHttpServer, type LocalServer, type RecordedRequest } from './servers';
import { numberParameter, requestUrl } from './stream-server';

const sessionToken = 'synthetic-session';
const sessionCookie = 'session=synthetic; Path=/';
const sequence = '12345678901234567890';
const replyParts = ['Synthetic ', 'agent ', 'reply.'];
const malformedLine = '{"type": "TEXT_MESSAGE_CONTENT", "delta": \n';

function eventLine(fields: Record<string, string>): string {
  return `${JSON.stringify(fields)}\n`;
}

function agentEvents(run: number, parameters: URLSearchParams): string[] {
  const threadId = `synthetic-thread-${String(run)}`;
  const runId = `synthetic-run-${String(run)}`;
  const messageId = `synthetic-message-${String(run)}`;
  const omit = parameters.get('omit');
  const started = omit === 'started' ? [] : [eventLine({ type: 'RUN_STARTED', threadId, runId })];
  if (parameters.get('fail') === 'mid') {
    return started;
  }
  const content = replyParts.map((delta) =>
    eventLine({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta }),
  );
  const malformed = parameters.get('malformed') === '1' ? [malformedLine] : [];
  const finished =
    omit === 'finished'
      ? []
      : [
          `{"type":"RUN_FINISHED","threadId":"${threadId}","runId":"${runId}","result":{"messageId":"${messageId}","sequence":${sequence}}}\n`,
        ];
  return [...started, ...content.slice(0, 1), ...malformed, ...content.slice(1), ...finished];
}

export interface AgentServer extends LocalServer {
  pendingTimers(): number;
}

function streamRun(
  response: http.ServerResponse,
  run: number,
  parameters: URLSearchParams,
  timers: Set<NodeJS.Timeout>,
): void {
  const lines = agentEvents(run, parameters);
  const delayMs = numberParameter(parameters.get('delayMs'), 0);
  const gapMs = numberParameter(parameters.get('gapMs'), 0);
  const cut = parameters.get('fail') === 'mid';
  response.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-store',
    'X-Session-Token': sessionToken,
    'Set-Cookie': sessionCookie,
  });
  response.flushHeaders();
  let sent = 0;
  let timer: NodeJS.Timeout;
  const schedule = (ms: number): void => {
    const scheduled = setTimeout(() => {
      timers.delete(scheduled);
      step();
    }, ms);
    timers.add(scheduled);
    timer = scheduled;
  };
  const step = (): void => {
    const line = lines[sent];
    if (line === undefined) {
      if (cut) {
        response.destroy();
      } else {
        response.end();
      }
      return;
    }
    sent += 1;
    response.write(line);
    schedule(sent < lines.length ? gapMs : 0);
  };
  schedule(delayMs);
  response.on('close', () => {
    clearTimeout(timer);
    timers.delete(timer);
  });
}

function echo(response: http.ServerResponse, recorded: RecordedRequest): void {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(recorded.body);
}

export async function startAgentServer(): Promise<AgentServer> {
  let runs = 0;
  const timers = new Set<NodeJS.Timeout>();
  const server = await startHttpServer((request, response, recorded) => {
    const url = requestUrl(request);
    const route = `${request.method ?? ''} ${url?.pathname ?? ''}`;
    if (url !== undefined && route === 'POST /agent/run') {
      runs += 1;
      streamRun(response, runs, url.searchParams, timers);
    } else if (route === 'POST /agent/continue') {
      echo(response, recorded);
    } else {
      response.writeHead(404).end();
    }
  });
  return { ...server, pendingTimers: () => timers.size };
}
