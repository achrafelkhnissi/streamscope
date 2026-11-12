import { writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import * as net from 'node:net';

export interface DevToolsTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

const screenshotTimeoutMs = 15_000;

export function workbenchTarget(targets: readonly DevToolsTarget[]): DevToolsTarget | undefined {
  return targets.find((target) => target.type === 'page' && target.url.endsWith('workbench.html'));
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => {
        resolve(port);
      });
    });
  });
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
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: { data?: string };
        error?: { message?: string };
      };
      if (message.id === 1) {
        finish(
          message.error === undefined
            ? undefined
            : new Error(message.error.message ?? 'The screenshot failed.'),
          message.result?.data,
        );
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
  const target = workbenchTarget(targets);
  if (target?.webSocketDebuggerUrl === undefined) {
    throw new Error('The VS Code workbench is not available for screenshots.');
  }
  await writeFile(file, Buffer.from(await screenshotData(target.webSocketDebuggerUrl), 'base64'));
}
