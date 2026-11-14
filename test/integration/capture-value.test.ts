import * as assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { startHttpServer, type LocalServer } from '../support/servers';
import { removeTemporaryFolder } from './temporary-folder';

interface ResponseState {
  run: number;
  status: string;
  bodyText: string | undefined;
  captures: { name: string; state: string; text: string }[];
}

interface Opened {
  document: vscode.TextDocument;
  uri: vscode.Uri;
}

const agentEvents = [
  { type: 'RUN_STARTED', threadId: 'thread-1', runId: 'run-1' },
  { type: 'TEXT_MESSAGE_START', messageId: 'msg-1', role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg-1', delta: 'Hel' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg-1', delta: 'lo' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg-1', delta: '!' },
  { type: 'RUN_FINISHED', threadId: 'thread-1', runId: 'run-1' },
];
const itemsBody = '{"items":[{"id":"a-1"},{"id":"b-2"}],"sessionToken":"synthetic-token"}';

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

function responseState(key: string): Thenable<ResponseState | undefined> {
  return vscode.commands.executeCommand<ResponseState | undefined>(
    'streamscope.test.responseState',
    key,
  );
}

function answerName(answer: string | undefined): Thenable<unknown> {
  return vscode.commands.executeCommand('streamscope.test.answerCaptureName', answer);
}

function namesAsked(): Thenable<number> {
  return vscode.commands.executeCommand<number>('streamscope.test.captureNamesAsked');
}

function panelMessage(key: string, message: unknown): Thenable<unknown> {
  return vscode.commands.executeCommand('streamscope.test.panelMessage', key, message);
}

function prettyEvent(index: number): string {
  return JSON.stringify(agentEvents[index - 1], null, 2);
}

describe('Capture This Value', () => {
  let folder = '';
  let server: LocalServer | undefined;
  let baseUrl = '';

  before(async () => {
    folder = mkdtempSync(path.join(tmpdir(), 'streamscope-capture-value-'));
    server = await startHttpServer((request, response) => {
      if (request.url === '/stream') {
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        response.end(agentEvents.map((event) => JSON.stringify(event)).join('\n') + '\n');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(itemsBody);
    });
    baseUrl = server.url;
  });

  afterEach(async () => {
    await vscode.workspace.saveAll(false);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  after(async () => {
    await server?.close();
    removeTemporaryFolder(folder);
  });

  async function open(name: string): Promise<Opened> {
    const file = path.join(folder, name);
    writeFileSync(
      file,
      [
        `@baseUrl = ${baseUrl}`,
        '',
        '### Start',
        '# @name startRun',
        'POST {{baseUrl}}/stream',
        '',
        '### Items',
        '# @name items',
        'GET {{baseUrl}}/items',
        '',
      ].join('\n'),
    );
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    return { document, uri: document.uri };
  }

  function line(opened: Opened, text: string): number {
    const lines = opened.document.getText().split('\n');
    const found = lines.findIndex((candidate) => candidate === text);
    assert.notEqual(found, -1, `missing line ${text}`);
    return found;
  }

  async function sendAndWait(
    opened: Opened,
    name: string,
    request: string,
  ): Promise<ResponseState> {
    const key = `${opened.uri.toString()}\n@${name}`;
    const before = (await responseState(key))?.run ?? 0;
    await vscode.commands.executeCommand(
      'streamscope.sendRequest',
      opened.uri,
      line(opened, request),
    );
    await waitFor(async () => {
      const state = await responseState(key);
      return state !== undefined && state.run > before && state.status === 'completed';
    }, `${name} never completed`);
    const finished = await responseState(key);
    assert.ok(finished);
    return finished;
  }

  it('captures a value of the first event from the panel and resolves it on the next run', async () => {
    const opened = await open('panel.http');
    const key = `${opened.uri.toString()}\n@startRun`;
    const first = await sendAndWait(opened, 'startRun', 'POST {{baseUrl}}/stream');

    await answerName('threadId');
    await panelMessage(key, {
      type: 'capture',
      run: first.run,
      target: 'event',
      index: 1,
      offset: prettyEvent(1).indexOf('"thread-1"') + 2,
    });

    const lines = opened.document.getText().split('\n');
    assert.equal(
      lines[line(opened, 'POST {{baseUrl}}/stream') - 1],
      '# @capture threadId = first(type == "RUN_STARTED").threadId',
    );
    assert.equal(lines[line(opened, 'POST {{baseUrl}}/stream') - 2], '# @name startRun');
    const second = await sendAndWait(opened, 'startRun', 'POST {{baseUrl}}/stream');
    await waitFor(
      async () =>
        (await responseState(key))?.captures.some(
          ({ name, state }) => name === 'threadId' && state === 'resolved',
        ) === true,
      'threadId never resolved',
    );
    const resolved = (await responseState(key))?.captures.find(({ name }) => name === 'threadId');
    assert.ok(second.run > first.run);
    assert.ok(resolved?.text.includes('thread-1'), JSON.stringify(resolved));
  });

  it('captures the third TEXT_MESSAGE_CONTENT from an event document with the cursor', async () => {
    const opened = await open('document.http');
    const key = `${opened.uri.toString()}\n@startRun`;
    await sendAndWait(opened, 'startRun', 'POST {{baseUrl}}/stream');
    await vscode.commands.executeCommand('streamscope.test.openEvent', key, 5);
    const editor = vscode.window.visibleTextEditors.find((candidate) =>
      candidate.document.uri.path.endsWith('/event-5.json'),
    );
    assert.ok(editor, 'event 5 is not open in an editor');
    await vscode.window.showTextDocument(editor.document, editor.viewColumn);
    const active = vscode.window.activeTextEditor;
    assert.ok(active);
    const at = active.document.positionAt(active.document.getText().indexOf('"delta"') + 2);
    active.selection = new vscode.Selection(at, at);

    await answerName('delta');
    await vscode.commands.executeCommand('streamscope.captureValue');

    assert.equal(
      opened.document.lineAt(line(opened, 'POST {{baseUrl}}/stream') - 1).text,
      '# @capture delta = nth(3, type == "TEXT_MESSAGE_CONTENT").delta',
    );
  });

  it('captures a body value as body.path', async () => {
    const opened = await open('body.http');
    const key = `${opened.uri.toString()}\n@items`;
    const state = await sendAndWait(opened, 'items', 'GET {{baseUrl}}/items');
    await waitFor(
      async () => (await responseState(key))?.bodyText !== undefined,
      'the Body never arrived',
    );
    const bodyText = (await responseState(key))?.bodyText ?? '';
    const offset = bodyText.indexOf('"id"', bodyText.indexOf('"id"') + 1) + 1;

    await answerName('id');
    await panelMessage(key, { type: 'capture', run: state.run, target: 'body', offset });

    assert.equal(
      opened.document.lineAt(line(opened, 'GET {{baseUrl}}/items') - 1).text,
      '# @capture id = body.items[1].id',
    );
  });

  it('writes secret for a credential-looking name', async () => {
    const opened = await open('secret.http');
    const key = `${opened.uri.toString()}\n@items`;
    const state = await sendAndWait(opened, 'items', 'GET {{baseUrl}}/items');
    await waitFor(
      async () => (await responseState(key))?.bodyText !== undefined,
      'the Body never arrived',
    );
    const bodyText = (await responseState(key))?.bodyText ?? '';

    await answerName('sessionToken');
    await panelMessage(key, {
      type: 'capture',
      run: state.run,
      target: 'body',
      offset: bodyText.indexOf('"synthetic-token"'),
    });

    assert.equal(
      opened.document.lineAt(line(opened, 'GET {{baseUrl}}/items') - 1).text,
      '# @capture secret sessionToken = body.sessionToken',
    );
  });

  it('places the line on the moved request when the file changed during the prompt', async () => {
    const opened = await open('moved.http');
    const key = `${opened.uri.toString()}\n@startRun`;
    const state = await sendAndWait(opened, 'startRun', 'POST {{baseUrl}}/stream');
    const asked = await namesAsked();

    const capturing = panelMessage(key, {
      type: 'capture',
      run: state.run,
      target: 'event',
      index: 2,
      offset: prettyEvent(2).indexOf('"msg-1"'),
    });
    await waitFor(async () => (await namesAsked()) > asked, 'the name was never asked');
    const edit = new vscode.WorkspaceEdit();
    edit.insert(opened.uri, new vscode.Position(2, 0), '### Inserted\nGET {{baseUrl}}/other\n\n');
    assert.ok(await vscode.workspace.applyEdit(edit));
    await answerName('messageId');
    await capturing;

    const request = line(opened, 'POST {{baseUrl}}/stream');
    assert.equal(
      opened.document.lineAt(request - 1).text,
      '# @capture messageId = first(type == "TEXT_MESSAGE_START").messageId',
    );
    assert.equal(opened.document.lineAt(request - 2).text, '# @name startRun');
    assert.equal(opened.document.lineAt(3).text, 'GET {{baseUrl}}/other');
  });

  it('ignores a capture message for another run, and refuses the Headers document', async () => {
    const opened = await open('ignored.http');
    const key = `${opened.uri.toString()}\n@startRun`;
    const state = await sendAndWait(opened, 'startRun', 'POST {{baseUrl}}/stream');
    const text = opened.document.getText();
    const asked = await namesAsked();

    await panelMessage(key, {
      type: 'capture',
      run: state.run + 1000,
      target: 'event',
      index: 1,
      offset: 5,
    });
    await panelMessage(key, {
      type: 'capture',
      run: state.run,
      target: 'event',
      index: 1,
      offset: 5,
      path: ['threadId'],
    });
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor);
    const request = line(opened, 'POST {{baseUrl}}/stream');
    editor.selection = new vscode.Selection(request, 0, request, 0);
    await vscode.commands.executeCommand('streamscope.showResponseHeaders');
    const headersUri = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .flatMap((tab) => (tab.input instanceof vscode.TabInputText ? [tab.input.uri] : []))
      .find((candidate) => candidate.path.endsWith('.headers.http'));
    assert.ok(headersUri, 'the Headers document is not open');
    await vscode.window.showTextDocument(headersUri);
    assert.ok(vscode.window.activeTextEditor?.document.uri.path.endsWith('.headers.http'));
    await vscode.commands.executeCommand('streamscope.captureValue');

    assert.equal(await namesAsked(), asked);
    assert.equal(opened.document.getText(), text);
  });

  it('does nothing when the name prompt is dismissed', async () => {
    const opened = await open('dismissed.http');
    const key = `${opened.uri.toString()}\n@startRun`;
    const state = await sendAndWait(opened, 'startRun', 'POST {{baseUrl}}/stream');
    const text = opened.document.getText();

    await answerName(undefined);
    await panelMessage(key, {
      type: 'capture',
      run: state.run,
      target: 'event',
      index: 1,
      offset: prettyEvent(1).indexOf('"run-1"'),
    });

    assert.equal(opened.document.getText(), text);
  });
});
