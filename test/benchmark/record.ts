import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
} from '@vscode/test-electron';
import { startStreamServer } from '../support/stream-server';
import { workbenchTarget, type DevToolsTarget } from './view/devtools';
import { devToolsPort, profileSettings, vscodeEnvironment } from './view/launch';

export type Scene = 'stream' | 'file-run';

export interface SceneFile {
  name: string;
  content: string;
}

export interface RecordedFrame {
  file: string;
  timestamp: number;
}

export interface RecordingResult {
  scene: Scene;
  gif: string;
  frames: number;
  bytes: number;
}

const maxGifBytes = 8 * 1024 * 1024;
const gifWidth = 1200;
const startupMs = 8000;

function streamWith(streamUrl: string, values: Record<string, string>): string {
  const url = new URL(streamUrl);
  for (const [name, value] of Object.entries(values)) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

export function sceneFiles(scene: Scene, streamUrl: string): SceneFile[] {
  if (scene === 'stream') {
    return [
      {
        name: 'agent.http',
        content: [
          '### Start agent run',
          '# @name startRun',
          '# @capture threadId = first(type == "RUN_STARTED").threadId',
          '# @expect status == 200',
          '# @expect count(type == "TEXT_MESSAGE_CONTENT") > 100',
          `GET ${streamWith(streamUrl, { rate: '500', seconds: '12', size: '1024' })}`,
          '',
        ].join('\n'),
      },
    ];
  }
  const short = streamWith(streamUrl, { rate: '20', seconds: '1', size: '256' });
  return [
    {
      name: 'flow.http',
      content: [
        '### Start agent run',
        '# @name startRun',
        '# @capture threadId = first(type == "RUN_STARTED").threadId',
        '# @expect status == 200',
        `GET ${short}`,
        '',
        '### Check out',
        '# @name checkout',
        '# @capture orderId = body.orderId',
        'POST http://127.0.0.1:1/checkout',
        'X-Thread: {{threadId}}',
        '',
        '### Confirm',
        '# @name confirm',
        `GET ${short}`,
        'X-Order: {{checkout.orderId}}',
        '',
      ].join('\n'),
    },
  ];
}

export function concatList(frames: readonly RecordedFrame[], endSeconds: number): string {
  const lines: string[] = [];
  for (const [index, frame] of frames.entries()) {
    const next = frames[index + 1]?.timestamp ?? endSeconds;
    lines.push(`file '${frame.file}'`, `duration ${(next - frame.timestamp).toFixed(3)}`);
  }
  const last = frames.at(-1);
  if (last !== undefined) {
    lines.push(`file '${last.file}'`);
  }
  return `${lines.join('\n')}\n`;
}

export function gifProblem(bytes: number): string | undefined {
  return bytes <= maxGifBytes
    ? undefined
    : `The recording is ${(bytes / 1024 / 1024).toFixed(1)} MB, over the 8 MB limit. Shorten the scene or lower the width.`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        });
        response.on('error', reject);
      })
      .on('error', reject);
  });
}

interface DevToolsMessage {
  id?: number;
  method?: string;
  params?: { data?: string; sessionId?: number; metadata?: { timestamp?: number } };
}

class DevTools {
  private next = 0;
  private readonly pending = new Map<number, () => void>();
  private socket: WebSocket | undefined;
  onFrame: ((data: string, timestamp: number) => void) | undefined;

  constructor(private readonly url: string) {}

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new http.WebSocket(this.url);
      this.socket = socket;
      socket.addEventListener('open', () => {
        resolve();
      });
      socket.addEventListener('error', () => {
        reject(new Error(`Could not connect to ${this.url}.`));
      });
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data)) as DevToolsMessage;
        if (message.id !== undefined) {
          this.pending.get(message.id)?.();
          this.pending.delete(message.id);
        }
        const { params } = message;
        if (message.method === 'Page.screencastFrame' && params?.data !== undefined) {
          this.onFrame?.(params.data, params.metadata?.timestamp ?? performance.now() / 1000);
          void this.send('Page.screencastFrameAck', { sessionId: params.sessionId });
        }
      });
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<void> {
    this.next += 1;
    const id = this.next;
    this.socket?.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
    });
  }

  async key(key: string, code: string, keyCode: number, modifiers = 0): Promise<void> {
    const base = {
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    if (key === 'Enter' && modifiers === 0) {
      await this.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...base });
    }
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await delay(250);
  }

  async type(text: string): Promise<void> {
    await this.send('Input.insertText', { text });
    await delay(400);
  }

  close(): void {
    this.socket?.close();
  }
}

const meta = process.platform === 'darwin' ? 4 : 2;
const alt = 1;
const shift = 8;

async function quickOpen(devTools: DevTools, name: string): Promise<void> {
  await devTools.key('p', 'KeyP', 80, meta);
  await devTools.type(name);
  await delay(600);
  await devTools.key('Enter', 'Enter', 13);
  await delay(1200);
}

async function palette(devTools: DevTools, command: string): Promise<void> {
  await devTools.key('p', 'KeyP', 80, meta | shift);
  await devTools.type(command);
  await delay(600);
  await devTools.key('Enter', 'Enter', 13);
  await delay(800);
}

async function play(scene: Scene, devTools: DevTools): Promise<void> {
  if (scene === 'stream') {
    await quickOpen(devTools, 'agent.http');
    await delay(1000);
    await devTools.key('Enter', 'Enter', 13, meta | alt);
    await delay(11_000);
    return;
  }
  await quickOpen(devTools, 'flow.http');
  await palette(devTools, 'Testing: Focus on Test Explorer View');
  await delay(1000);
  await palette(devTools, 'Streamscope: Run File');
  await delay(5000);
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
}

export async function runRecording(scene: Scene): Promise<RecordingResult> {
  const root = process.cwd();
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
  };
  const vsix = path.join(root, `${manifest.name}-${manifest.version}.vsix`);
  if (!existsSync(vsix)) {
    throw new Error(`Run npm run package first: ${vsix} does not exist.`);
  }
  const frameDirectory = path.join(root, 'out', 'record', scene);
  rmSync(frameDirectory, { recursive: true, force: true });
  mkdirSync(frameDirectory, { recursive: true });
  const name = `${scene === 'stream' ? 'live-stream' : 'file-run'}.gif`;
  const recorded = path.join(root, 'out', 'record', name);
  const gif = path.join(root, 'images', name);
  const sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), 'ssr-')));
  const server = await startStreamServer();
  const env = vscodeEnvironment(process.env, {});
  let pid: number | undefined;
  let devTools: DevTools | undefined;
  const stopNow = (): void => {
    if (pid !== undefined) {
      killGroup(pid);
    }
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    stopNow();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const userDataDir = path.join(sandbox, 'ud');
    const extensionsDir = path.join(sandbox, 'ext');
    const workspace = path.join(sandbox, 'ws');
    for (const directory of [path.join(userDataDir, 'User'), extensionsDir, workspace]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(
      path.join(userDataDir, 'User', 'settings.json'),
      JSON.stringify({ ...profileSettings(), 'editor.minimap.enabled': false }),
    );
    for (const file of sceneFiles(scene, `${server.url}/stream?format=ndjson`)) {
      writeFileSync(path.join(workspace, file.name), file.content);
    }
    const executable = await downloadAndUnzipVSCode('stable');
    const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executable, {
      reuseMachineInstall: true,
    });
    const profile = [`--user-data-dir=${userDataDir}`, `--extensions-dir=${extensionsDir}`];
    const install = spawnSync(cli ?? '', [...cliArgs, ...profile, '--install-extension', vsix], {
      encoding: 'utf8',
      env,
    });
    if (install.status !== 0) {
      throw new Error(`Installing ${vsix} failed: ${install.stderr}`);
    }
    const child = spawn(
      executable,
      [
        '--disable-updates',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
        '--remote-debugging-port=0',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-background-timer-throttling',
        ...profile,
        workspace,
      ],
      { detached: true, env, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    pid = child.pid;
    let stderr = '';
    const port = await new Promise<number>((resolve, reject) => {
      child.once('exit', () => {
        reject(new Error('VS Code exited before it reported its DevTools port.'));
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        const found = devToolsPort(stderr);
        if (found !== undefined) {
          resolve(found);
        }
      });
    });
    await delay(startupMs);
    const targets = (await getJson(
      `http://127.0.0.1:${String(port)}/json/list`,
    )) as DevToolsTarget[];
    const target = workbenchTarget(targets, port);
    if (target?.webSocketDebuggerUrl === undefined) {
      throw new Error('The VS Code workbench is not available.');
    }
    const connected = new DevTools(target.webSocketDebuggerUrl);
    devTools = connected;
    await connected.open();
    const frames: RecordedFrame[] = [];
    connected.onFrame = (data, timestamp) => {
      const file = `${String(frames.length).padStart(5, '0')}.jpeg`;
      writeFileSync(path.join(frameDirectory, file), Buffer.from(data, 'base64'));
      frames.push({ file, timestamp });
    };
    await connected.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 });
    const started = performance.now() / 1000;
    await play(scene, connected);
    await delay(1500);
    await connected.send('Page.stopScreencast');
    const firstTimestamp = frames[0]?.timestamp ?? started;
    const end = firstTimestamp + (performance.now() / 1000 - started);
    writeFileSync(path.join(frameDirectory, 'frames.txt'), concatList(frames, end));

    const ffmpeg = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        path.join(frameDirectory, 'frames.txt'),
        '-vf',
        `fps=10,scale=${String(gifWidth)}:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`,
        recorded,
      ],
      { encoding: 'utf8' },
    );
    if (ffmpeg.status !== 0) {
      throw new Error(`ffmpeg failed: ${ffmpeg.stderr}`);
    }
    const bytes = statSync(recorded).size;
    const problem = gifProblem(bytes);
    if (problem !== undefined) {
      throw new Error(problem);
    }
    mkdirSync(path.dirname(gif), { recursive: true });
    copyFileSync(recorded, gif);
    return { scene, gif: path.relative(root, gif), frames: frames.length, bytes };
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    devTools?.close();
    await server.close();
    stopNow();
  }
}
