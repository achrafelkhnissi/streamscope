import { writeFile } from 'node:fs/promises';
import * as http from 'node:http';

export interface DevToolsTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

const screenshotTimeoutMs = 15_000;

export interface DevToolsReply {
  id: number | undefined;
  data: string | undefined;
  error: string | undefined;
}

export function workbenchTarget(
  targets: readonly DevToolsTarget[],
  port: number,
): DevToolsTarget | undefined {
  return targets.find(
    (target) =>
      target.type === 'page' &&
      target.url.endsWith('workbench.html') &&
      target.webSocketDebuggerUrl?.startsWith(`ws://127.0.0.1:${String(port)}/`) === true,
  );
}

export function parseReply(text: string): DevToolsReply | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const reply = value as {
    id?: unknown;
    result?: { data?: unknown };
    error?: { message?: unknown };
  };
  return {
    id: typeof reply.id === 'number' ? reply.id : undefined,
    data: typeof reply.result?.data === 'string' ? reply.result.data : undefined,
    error: typeof reply.error?.message === 'string' ? reply.error.message : undefined,
  };
}

function getText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (response.statusCode === 200) {
            resolve(text);
          } else {
            reject(new Error(`${url} answered ${String(response.statusCode)}: ${text}`));
          }
        });
        response.on('error', reject);
      })
      .on('error', reject);
  });
}

function screenshotData(webSocketUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new http.WebSocket(webSocketUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('The screenshot took longer than 15 s.'));
    }, screenshotTimeoutMs);
    const finish = (error: Error | undefined, data?: string): void => {
      clearTimeout(timer);
      socket.close();
      if (error === undefined && data !== undefined) {
        resolve(data);
      } else {
        reject(error ?? new Error('The screenshot returned no data.'));
      }
    };
    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Page.captureScreenshot',
          params: { format: 'jpeg', quality: 80 },
        }),
      );
    });
    socket.addEventListener('message', (event) => {
      const reply = parseReply(String(event.data));
      if (reply === undefined) {
        finish(new Error('DevTools sent a reply that is not JSON.'));
        return;
      }
      if (reply.id === 1) {
        finish(reply.error === undefined ? undefined : new Error(reply.error), reply.data);
      }
    });
    socket.addEventListener('error', () => {
      finish(new Error(`Could not connect to ${webSocketUrl}.`));
    });
  });
}

export async function captureScreenshot(port: number, file: string): Promise<void> {
  const targets = JSON.parse(
    await getText(`http://127.0.0.1:${String(port)}/json/list`),
  ) as DevToolsTarget[];
  const target = workbenchTarget(targets, port);
  if (target?.webSocketDebuggerUrl === undefined) {
    throw new Error('The VS Code workbench is not available for screenshots.');
  }
  await writeFile(file, Buffer.from(await screenshotData(target.webSocketDebuggerUrl), 'base64'));
}
