import * as assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { startAgentServer } from '../support/agent-server';
import type { LocalServer, RecordedRequest } from '../support/servers';
import { removeTemporaryFolder } from './temporary-folder';

interface HistoryEntry {
  id: number;
  label: string;
  description: string;
  detail: string;
}

interface BlockedActions {
  message: string;
  actions: string[];
  run: { title: string; command: string; arguments: unknown[] } | undefined;
}

interface ResponseState {
  captures: { name: string; state: string; text: string }[];
}

interface Opened {
  document: vscode.TextDocument;
  uri: vscode.Uri;
  producer: number;
  consumer: number;
  startRunKey: string;
}

interface AgentFile {
  query?: string;
  captures?: string[];
  follow?: string[];
}

const sessionToken = 'synthetic-session';
const runHandle = 'synthetic-run-1';
const runHandleTail = '-run-1';
const partlyMaskedSessionToken = '••••••-session';
const sessionCookie = 'session=synthetic';
const leakedForms = [sessionToken, partlyMaskedSessionToken, sessionCookie, runHandleTail];
const sequence = '12345678901234567890';
const firstContinue = '{"threadId": "synthetic-thread-1", "messageId": "synthetic-message-1"}';
const designContinue = [
  '### Continue',
  'POST {{baseUrl}}/agent/continue',
  'Content-Type: application/json',
  '',
  '{"threadId": "{{startRun.threadId}}", "messageId": "{{messageId}}"}',
];

function agentFile(server: LocalServer, options: AgentFile = {}): string[] {
  const { query, captures = [], follow = designContinue } = options;
  return [
    `@baseUrl = ${server.url}`,
    '',
    '### Start agent run',
    '# @name startRun',
    '# @capture threadId = first(type == "RUN_STARTED").threadId',
    '# @capture messageId = last(type == "RUN_FINISHED").result.messageId',
    '# @capture secret sessionToken = headers["x-session-token"]',
    ...captures,
    `POST {{baseUrl}}/agent/run${query === undefined ? '' : `?${query}`}`,
    'Content-Type: application/json',
    '',
    '{"message": "hello"}',
    '',
    ...follow,
  ];
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`${what} within ${String(timeoutMs)} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function send(uri: vscode.Uri, line: number): Thenable<unknown> {
  return vscode.commands.executeCommand('streamscope.sendRequest', uri, line);
}

function stop(uri: vscode.Uri, line: number): Thenable<unknown> {
  return vscode.commands.executeCommand('streamscope.stopRequest', uri, line);
}

async function lenses(uri: vscode.Uri): Promise<vscode.CodeLens[]> {
  return vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri);
}

async function lensesAt(uri: vscode.Uri, line: number): Promise<string[]> {
  return (await lenses(uri))
    .filter((lens) => lens.range.start.line === line)
    .map((lens) => lens.command?.title ?? '');
}

async function waitingLens(opened: Opened): Promise<void> {
  await waitFor(
    async () =>
      (await lensesAt(opened.uri, opened.consumer)).some((title) =>
        title.startsWith('Waiting for startRun › '),
      ),
    'continue never showed "Waiting for startRun › …"',
  );
}

function history(): Thenable<HistoryEntry[]> {
  return vscode.commands.executeCommand<HistoryEntry[]>('streamscope.showHistory', 0);
}

function blockedActions(): Thenable<BlockedActions | undefined> {
  return vscode.commands.executeCommand<BlockedActions | undefined>(
    'streamscope.test.blockedActions',
  );
}

function responseState(key: string): Thenable<ResponseState | undefined> {
  return vscode.commands.executeCommand<ResponseState | undefined>(
    'streamscope.test.responseState',
    key,
  );
}

function logLines(): Thenable<string[]> {
  return vscode.commands.executeCommand<string[]>('streamscope.test.logLines');
}

async function hintLabels(document: vscode.TextDocument): Promise<string[]> {
  const hints = await vscode.commands.executeCommand<vscode.InlayHint[]>(
    'vscode.executeInlayHintProvider',
    document.uri,
    new vscode.Range(0, 0, document.lineCount, 0),
  );
  return hints.map((hint) =>
    typeof hint.label === 'string' ? hint.label : hint.label.map((part) => part.value).join(''),
  );
}

async function hoverText(
  document: vscode.TextDocument,
  line: number,
  reference: string,
): Promise<string> {
  const character = document.lineAt(line).text.indexOf(reference) + 3;
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider',
    document.uri,
    new vscode.Position(line, character),
  );
  return hovers
    .flatMap((hover) => hover.contents)
    .map((content) => (content instanceof vscode.MarkdownString ? content.value : ''))
    .join('\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/\\(.)/g, '$1');
}

async function headersDocument(line: number, label: string): Promise<string> {
  const editor = vscode.window.activeTextEditor;
  assert.ok(editor, 'no .http editor is active');
  editor.selection = new vscode.Selection(line, 0, line, 0);
  await vscode.commands.executeCommand('streamscope.showResponseHeaders');
  const uri = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .flatMap((tab) => (tab.input instanceof vscode.TabInputText ? [tab.input.uri] : []))
    .find((candidate) => candidate.path.endsWith(`/${label}.headers.http`));
  assert.ok(uri, `the Headers document of ${label} is not open`);
  await vscode.window.showTextDocument(editor.document, editor.viewColumn);
  return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
}

function agentRuns(server: LocalServer): number {
  return server.requests.filter((request) => request.url.startsWith('/agent/run')).length;
}

function continued(server: LocalServer): RecordedRequest[] {
  return server.requests.filter((request) => request.url.startsWith('/agent/continue'));
}

function continueBodies(server: LocalServer): string[] {
  return continued(server).map((request) => request.body.toString());
}

function escapedPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function headerValue(request: RecordedRequest | undefined, name: string): string | undefined {
  const raw = request?.rawHeaders ?? [];
  const index = raw.findIndex(
    (value, at) => at % 2 === 0 && value.toLowerCase() === name.toLowerCase(),
  );
  return index === -1 ? undefined : raw[index + 1];
}

describe('the capture flow against a synthetic agent server', () => {
  let folder = '';
  const servers: LocalServer[] = [];

  async function serve(): Promise<LocalServer> {
    const server = await startAgentServer();
    servers.push(server);
    return server;
  }

  async function open(name: string, lines: string[]): Promise<Opened> {
    const file = path.join(folder, name);
    writeFileSync(file, lines.join('\n'));
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    return {
      document,
      uri: document.uri,
      producer: lines.findIndex((line) => line.startsWith('POST {{baseUrl}}/agent/run')),
      consumer: lines.findIndex((line) => line.startsWith('POST {{baseUrl}}/agent/continue')),
      startRunKey: `${document.uri.toString()}\n@startRun`,
    };
  }

  async function blockedWith(opened: Opened, message: string, line: number): Promise<void> {
    const blocked = await blockedActions();
    assert.equal(blocked?.message, `Not sent: ${message} (line ${String(line + 1)}).`);
    assert.equal((await lensesAt(opened.uri, opened.consumer))[1], `Not sent: ${message}`);
  }

  async function blockedStartingWith(opened: Opened, start: string, line: number): Promise<void> {
    const stable = `^Not sent: ${escapedPattern(start)}\\b.*\\.`;
    const blocked = await blockedActions();
    assert.match(
      blocked?.message ?? '',
      new RegExp(`${stable} \\(line ${String(line + 1)}\\)\\.$`),
    );
    assert.match((await lensesAt(opened.uri, opened.consumer))[1] ?? '', new RegExp(`${stable}$`));
  }

  before(() => {
    folder = mkdtempSync(path.join(tmpdir(), 'streamscope-capture-flow-'));
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  after(() => {
    removeTemporaryFolder(folder);
  });

  it("continue carries startRun's threadId and messageId", async () => {
    const server = await serve();
    const opened = await open('carries.http', agentFile(server));

    await send(opened.uri, opened.producer);
    await send(opened.uri, opened.consumer);
    assert.deepEqual(continueBodies(server), [firstContinue]);

    await send(opened.uri, opened.producer);
    await send(opened.uri, opened.consumer);
    assert.deepEqual(continueBodies(server), [
      firstContinue,
      '{"threadId": "synthetic-thread-2", "messageId": "synthetic-message-2"}',
    ]);
  });

  it('continue sent while startRun is still streaming waits and then sends', async () => {
    const server = await serve();
    const opened = await open('streaming.http', agentFile(server, { query: 'gapMs=1000' }));

    const producing = send(opened.uri, opened.producer);
    await waitFor(() => agentRuns(server) === 1, 'startRun never reached the server');
    const following = send(opened.uri, opened.consumer);
    await waitingLens(opened);

    assert.deepEqual(continueBodies(server), []);
    assert.equal((await lensesAt(opened.uri, opened.producer))[0], 'Stop');
    await following;
    assert.deepEqual(continueBodies(server), [firstContinue]);
    await producing;
    assert.match((await lensesAt(opened.uri, opened.producer))[1] ?? '', /^200 OK · 5 events · /);
  });

  it('large integer ids keep their digits in the URL, a header and the JSON body', async () => {
    const server = await serve();
    const opened = await open(
      'large.http',
      agentFile(server, {
        captures: ['# @capture sequence = last(type == "RUN_FINISHED").result.sequence'],
        follow: [
          '### Continue',
          'POST {{baseUrl}}/agent/continue?sequence={{startRun.sequence}}',
          'Content-Type: application/json',
          'X-Sequence: {{sequence}}',
          '',
          '{"threadId": "{{startRun.threadId}}", "sequence": {{startRun.sequence}}}',
        ],
      }),
    );

    await send(opened.uri, opened.producer);
    await send(opened.uri, opened.consumer);

    const [request] = continued(server);
    assert.equal(request?.url, `/agent/continue?sequence=${sequence}`);
    assert.equal(headerValue(request, 'X-Sequence'), sequence);
    assert.equal(
      continueBodies(server)[0],
      `{"threadId": "synthetic-thread-1", "sequence": ${sequence}}`,
    );
  });

  it('a secret capture never appears outside the response content', async () => {
    const server = await serve();
    const opened = await open(
      'secret.http',
      agentFile(server, {
        captures: ['# @capture secret runHandle = first(type == "RUN_STARTED").runId'],
        follow: [
          '### Continue',
          'POST {{baseUrl}}/agent/continue?session={{sessionToken}}&run={{runHandle}}',
          'Content-Type: application/json',
          'X-Session-Token: {{sessionToken}}',
          'X-Run-Handle: {{runHandle}}',
          '',
          '{"threadId": "{{startRun.threadId}}", "messageId": "{{messageId}}"}',
        ],
      }),
    );
    await logLines();

    await send(opened.uri, opened.producer);
    let producerState: ResponseState | undefined;
    await waitFor(async () => {
      producerState = await responseState(opened.startRunKey);
      const captures = producerState?.captures ?? [];
      return captures.length === 4 && captures.every(({ state }) => state === 'resolved');
    }, 'the strip never showed the resolved captures');
    const producerHeaders = await headersDocument(opened.producer, 'startRun');
    await send(opened.uri, opened.consumer);
    const consumerHeaders = await headersDocument(opened.consumer, 'Continue');

    const [request] = continued(server);
    assert.equal(request?.url, `/agent/continue?session=${sessionToken}&run=${runHandle}`);
    assert.equal(headerValue(request, 'X-Session-Token'), sessionToken);
    assert.equal(headerValue(request, 'X-Run-Handle'), runHandle);
    assert.ok(producerHeaders.includes('X-Session-Token: ••••••\n'), producerHeaders);
    assert.ok(producerHeaders.includes('Set-Cookie: ••••••\n'), producerHeaders);
    assert.ok(consumerHeaders.includes('/agent/continue?session=••••••&run=••••••\n'));
    assert.ok(consumerHeaders.includes('X-Run-Handle: ••••••\n'), consumerHeaders);
    const hints = await hintLabels(opened.document);
    assert.deepEqual(hints.slice(2), ['= ••••••', '= ••••••']);
    assert.deepEqual(
      producerState?.captures.map(({ name, state }) => `${name} ${state}`),
      ['threadId resolved', 'messageId resolved', 'sessionToken resolved', 'runHandle resolved'],
    );
    assert.deepEqual(
      producerState.captures.slice(2).map(({ text }) => text),
      ['••••••', '••••••'],
    );
    const hovers = [
      await hoverText(opened.document, opened.consumer + 2, '{{sessionToken}}'),
      await hoverText(opened.document, opened.consumer + 3, '{{runHandle}}'),
    ];
    assert.deepEqual(
      hovers.map((hover) => hover.split('\n')[0]),
      ['{{sessionToken}} = ••••••', '{{runHandle}} = ••••••'],
    );
    const log = await logLines();
    assert.ok(
      log.some((line) => line.includes('X-Session-Token: ••••••, X-Run-Handle: ••••••, Host')),
      log.join('\n'),
    );
    const producerResponse = log.find((line) =>
      line.startsWith('Response headers: Content-Type: application/x-ndjson'),
    );
    assert.ok(
      producerResponse?.includes('X-Session-Token: ••••••, Set-Cookie: ••••••, '),
      log.join('\n'),
    );
    assert.ok(
      log.every((line) => !line.includes(sessionCookie)),
      log.join('\n'),
    );

    const surfaces = {
      producerHeaders,
      consumerHeaders,
      hints,
      producerState,
      consumerState: await responseState(
        `${opened.uri.toString()}\n#1 POST {{baseUrl}}/agent/continue?session={{sessionToken}}&run={{runHandle}}`,
      ),
      lenses: (await lenses(opened.uri)).map((lens) => lens.command?.title),
      hovers,
      log,
      history: await history(),
    };
    for (const [surface, shown] of Object.entries(surfaces)) {
      const text = JSON.stringify(shown);
      assert.ok(
        leakedForms.every((leaked) => !text.includes(leaked)),
        `${surface} shows a secret: ${text}`,
      );
    }
  });

  describe('every failure mode blocks continue with a precise message', () => {
    it('a stream without RUN_STARTED fails threadId with the events counted', async () => {
      const server = await serve();
      const opened = await open(
        'omit-started.http',
        agentFile(server, { query: 'omit=started&gapMs=500' }),
      );

      const producing = send(opened.uri, opened.producer);
      await waitFor(() => agentRuns(server) === 1, 'startRun never reached the server');
      await Promise.all([producing, send(opened.uri, opened.consumer)]);

      await blockedWith(
        opened,
        'startRun › threadId failed: no event matched first(type == "RUN_STARTED") (4 events).',
        opened.consumer + 3,
      );
      assert.deepEqual(continued(server), []);
    });

    it('a stream without RUN_FINISHED fails messageId', async () => {
      const server = await serve();
      const opened = await open(
        'omit-finished.http',
        agentFile(server, { query: 'omit=finished&gapMs=500' }),
      );

      const producing = send(opened.uri, opened.producer);
      await waitFor(() => agentRuns(server) === 1, 'startRun never reached the server');
      await Promise.all([producing, send(opened.uri, opened.consumer)]);

      await blockedWith(
        opened,
        'startRun › messageId failed: no event matched last(type == "RUN_FINISHED") (4 events).',
        opened.consumer + 3,
      );
      assert.deepEqual(continued(server), []);
    });

    it('a stream cut after RUN_STARTED fails messageId with the connection failure', async () => {
      const server = await serve();
      const opened = await open('cut.http', agentFile(server, { query: 'fail=mid&delayMs=1500' }));

      const producing = send(opened.uri, opened.producer);
      await waitFor(() => agentRuns(server) === 1, 'startRun never reached the server');
      const following = send(opened.uri, opened.consumer);
      await waitingLens(opened);
      await Promise.all([producing, following]);

      await blockedStartingWith(
        opened,
        'startRun › messageId failed: startRun failed before messageId resolved: The connection closed before the response was complete',
        opened.consumer + 3,
      );
      assert.deepEqual(continued(server), []);
    });

    it('stopping startRun fails the captures continue waits for', async () => {
      const server = await serve();
      const opened = await open('stopped.http', agentFile(server, { query: 'delayMs=10000' }));

      const producing = send(opened.uri, opened.producer);
      await waitFor(() => agentRuns(server) === 1, 'startRun never reached the server');
      const following = send(opened.uri, opened.consumer);
      await waitingLens(opened);
      await stop(opened.uri, opened.producer);
      await Promise.all([producing, following]);

      await blockedWith(
        opened,
        'startRun › threadId failed: startRun was cancelled before threadId resolved.',
        opened.consumer + 3,
      );
      assert.deepEqual(continued(server), []);
    });

    it('a capture that does not arrive within streamscope.capture.waitTimeout blocks continue', async () => {
      const settings = vscode.workspace.getConfiguration('streamscope.capture');
      await settings.update('waitTimeout', '1s', vscode.ConfigurationTarget.Global);
      try {
        const server = await serve();
        const opened = await open('timeout.http', agentFile(server, { query: 'delayMs=10000' }));

        const producing = send(opened.uri, opened.producer);
        await waitFor(() => agentRuns(server) === 1, 'startRun never reached the server');
        await send(opened.uri, opened.consumer);

        await blockedWith(
          opened,
          'startRun › threadId did not arrive within 1 s.',
          opened.consumer + 3,
        );
        assert.equal((await lensesAt(opened.uri, opened.producer))[0], 'Stop');
        await stop(opened.uri, opened.producer);
        await producing;
        assert.deepEqual(continued(server), []);
      } finally {
        await settings.update('waitTimeout', undefined, vscode.ConfigurationTarget.Global);
      }
    });

    it('a producer that never ran blocks continue at once and offers Run startRun', async () => {
      const server = await serve();
      const opened = await open('never-run.http', agentFile(server));

      await send(opened.uri, opened.consumer);

      await blockedWith(
        opened,
        '`{{startRun.threadId}}` comes from startRun, which has not run in this session.',
        opened.consumer + 3,
      );
      assert.deepEqual((await blockedActions())?.actions, ['Run startRun', 'Go to Line']);
      assert.equal(server.requests.length, 0);
    });

    it('an unknown capture name blocks continue', async () => {
      const server = await serve();
      const opened = await open(
        'unknown.http',
        agentFile(server, {
          follow: [
            '### Continue',
            'POST {{baseUrl}}/agent/continue',
            'Content-Type: application/json',
            '',
            '{"threadId": "{{startRun.threadI}}", "messageId": "{{messageId}}"}',
          ],
        }),
      );

      await send(opened.uri, opened.producer);
      await send(opened.uri, opened.consumer);

      await blockedWith(opened, 'startRun has no capture named threadI.', opened.consumer + 3);
      assert.deepEqual(continued(server), []);
    });

    it('a malformed line is counted in the reason', async () => {
      const server = await serve();
      const opened = await open(
        'malformed.http',
        agentFile(server, { query: 'omit=started&malformed=1&gapMs=500' }),
      );

      const producing = send(opened.uri, opened.producer);
      await waitFor(() => agentRuns(server) === 1, 'startRun never reached the server');
      await Promise.all([producing, send(opened.uri, opened.consumer)]);

      await blockedWith(
        opened,
        'startRun › threadId failed: no event matched first(type == "RUN_STARTED") (5 events, 1 malformed).',
        opened.consumer + 3,
      );
      assert.deepEqual(continued(server), []);
    });
  });
});
