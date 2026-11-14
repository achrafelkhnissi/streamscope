import * as assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { startHttpServer, type LocalServer } from '../support/servers';
import { removeTemporaryFolder } from './temporary-folder';

interface CheckState {
  text: string;
  state: string;
  detail: string;
}

interface ResponseState {
  run: number;
  status: string;
  statusText: string;
  checks: CheckState[];
}

interface Decoration {
  line: number;
  state: string;
  text: string;
}

interface DecorationRange extends Decoration {
  start: number;
  end: number;
}

const echoedSecret = 'synthetic-check-secret';

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

function decorationRanges(uri: vscode.Uri): Thenable<DecorationRange[]> {
  return vscode.commands.executeCommand<DecorationRange[]>(
    'streamscope.test.checkDecorations',
    uri,
  );
}

async function decorations(uri: vscode.Uri): Promise<Decoration[]> {
  return (await decorationRanges(uri)).map(({ line, state, text }) => ({ line, state, text }));
}

describe('checks', () => {
  let folder = '';
  let server: LocalServer | undefined;

  before(async () => {
    folder = mkdtempSync(path.join(tmpdir(), 'streamscope-checks-'));
    server = await startHttpServer((request, response) => {
      if (request.url === '/slow') {
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        let sent = 0;
        const timer = setInterval(() => {
          sent += 1;
          response.write(`${JSON.stringify({ type: 'CONTENT', n: sent })}\n`);
          if (sent === 8) {
            clearInterval(timer);
            response.end();
          }
        }, 250);
        response.on('close', () => {
          clearInterval(timer);
        });
        return;
      }
      if (request.url === '/echo') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ token: request.headers['x-echo'] }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      response.end(
        [
          '{"type":"RUN_STARTED"}',
          '{"type":"CONTENT","delta":"a"}',
          '{"type":"CONTENT","delta":"b"}',
          '{"type":"CONTENT","delta":"c"}',
          '{"type":"RUN_FINISHED","ok":true}',
          '',
        ].join('\n'),
      );
    });
  });

  afterEach(async () => {
    await vscode.workspace.saveAll(false);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  after(async () => {
    await server?.close();
    removeTemporaryFolder(folder);
  });

  async function open(name: string, lines: readonly string[]) {
    const file = path.join(folder, name);
    writeFileSync(file, [`@baseUrl = ${server?.url ?? ''}`, '', ...lines, ''].join('\n'));
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    const lineOf = (text: string): number => {
      const found = document.getText().split('\n').indexOf(text);
      assert.notEqual(found, -1, `missing line ${text}`);
      return found;
    };
    return { document, uri: document.uri, lineOf };
  }

  const streamLines = [
    '### Stream',
    '# @name stream',
    '# @expect status == 200',
    '# @expect count(type == "CONTENT") > 2',
    '# @expect status == 201',
    '# @expect last(type == "RUN_FINISHED").ok == true',
    'POST {{baseUrl}}/stream',
  ];

  async function sendAndSettle(
    uri: vscode.Uri,
    key: string,
    line: number,
    total: number,
  ): Promise<ResponseState> {
    await vscode.commands.executeCommand('streamscope.sendRequest', uri, line);
    let state: ResponseState | undefined;
    await waitFor(async () => {
      state = await responseState(key);
      return (
        state?.status === 'completed' &&
        state.checks.length === total &&
        state.checks.every((check) => check.state !== 'pending')
      );
    }, 'the checks never settled');
    assert.ok(state);
    return state;
  }

  it('decorates each # @expect line with its result after a run', async () => {
    const opened = await open('decorate.http', streamLines);
    const key = `${opened.uri.toString()}\n@stream`;
    await sendAndSettle(opened.uri, key, opened.lineOf('POST {{baseUrl}}/stream'), 4);

    await waitFor(
      async () => (await decorations(opened.uri)).length === 4,
      'the decorations never appeared',
    );
    assert.deepEqual(await decorations(opened.uri), [
      { line: opened.lineOf('# @expect status == 200'), state: 'passed', text: '✓' },
      { line: opened.lineOf('# @expect count(type == "CONTENT") > 2'), state: 'passed', text: '✓' },
      { line: opened.lineOf('# @expect status == 201'), state: 'failed', text: '✗ got 200' },
      {
        line: opened.lineOf('# @expect last(type == "RUN_FINISHED").ok == true'),
        state: 'passed',
        text: '✓',
      },
    ]);
    for (const decoration of await decorationRanges(opened.uri)) {
      assert.equal(decoration.start, 0);
      assert.equal(decoration.end, opened.document.lineAt(decoration.line).text.length);
      assert.ok(decoration.end > decoration.start);
    }
  });

  it("shows the checks in the panel's Checks tab and the summary in the status line", async () => {
    const opened = await open('panel.http', streamLines);
    const key = `${opened.uri.toString()}\n@stream`;
    const state = await sendAndSettle(opened.uri, key, opened.lineOf('POST {{baseUrl}}/stream'), 4);

    assert.deepEqual(state.checks, [
      { text: 'status == 200', state: 'passed', detail: '' },
      { text: 'count(type == "CONTENT") > 2', state: 'passed', detail: '' },
      { text: 'status == 201', state: 'failed', detail: 'got 200' },
      { text: 'last(type == "RUN_FINISHED").ok == true', state: 'passed', detail: '' },
    ]);
    await waitFor(
      async () => (await responseState(key))?.statusText.includes('3/4 checks') === true,
      'the status line never showed 3/4 checks',
    );
  });

  it('settles a count check while the stream is still running', async () => {
    const opened = await open('live.http', [
      '### Slow',
      '# @name slow',
      '# @expect count(type == "CONTENT") > 1',
      'GET {{baseUrl}}/slow',
    ]);
    const key = `${opened.uri.toString()}\n@slow`;
    const sending = vscode.commands.executeCommand(
      'streamscope.sendRequest',
      opened.uri,
      opened.lineOf('GET {{baseUrl}}/slow'),
    );

    let state: ResponseState | undefined;
    await waitFor(async () => {
      state = await responseState(key);
      return state?.checks[0]?.state === 'passed';
    }, 'the count check never passed');
    assert.equal(state?.status, 'receiving');
    await waitFor(
      async () => (await decorations(opened.uri))[0]?.state === 'passed',
      'the decoration never passed while streaming',
    );
    assert.equal((await responseState(key))?.status, 'receiving');
    await vscode.commands.executeCommand(
      'streamscope.stopRequest',
      opened.uri,
      opened.lineOf('GET {{baseUrl}}/slow'),
    );
    await sending;
  });

  it('shows the CodeLens ✓ / ✗ summary', async () => {
    const opened = await open('lens.http', streamLines);
    const key = `${opened.uri.toString()}\n@stream`;
    const line = opened.lineOf('POST {{baseUrl}}/stream');
    await sendAndSettle(opened.uri, key, line, 4);

    await waitFor(async () => {
      const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
        'vscode.executeCodeLensProvider',
        opened.uri,
      );
      return lenses.some(
        (lens) =>
          lens.range.start.line === line &&
          lens.command?.title.startsWith('✗ 200 OK') === true &&
          lens.command.title.endsWith(' · 3/4 checks'),
      );
    }, 'the CodeLens never showed ✗ … · 3/4 checks');
  });

  it('masks a secret in a check detail', async () => {
    await vscode.commands.executeCommand('streamscope.setSecret', 'echoKey', echoedSecret);
    try {
      const opened = await open('secret.http', [
        '### Echo',
        '# @name echo',
        '# @expect body.token == "x"',
        'GET {{baseUrl}}/echo',
        'X-Echo: {{$secret echoKey}}',
      ]);
      const key = `${opened.uri.toString()}\n@echo`;
      const state = await sendAndSettle(opened.uri, key, opened.lineOf('GET {{baseUrl}}/echo'), 1);

      assert.deepEqual(state.checks, [
        { text: 'body.token == "x"', state: 'failed', detail: 'got "••••••"' },
      ]);
      await waitFor(
        async () => (await decorations(opened.uri))[0]?.text === '✗ got "••••••"',
        'the decoration never showed the masked detail',
      );
      assert.ok(!JSON.stringify(await decorations(opened.uri)).includes(echoedSecret));
    } finally {
      await vscode.commands.executeCommand('streamscope.clearSecret', 'echoKey');
    }
  });

  it('drops a decoration from a line edited since the run', async () => {
    const opened = await open('edited.http', streamLines);
    const key = `${opened.uri.toString()}\n@stream`;
    await sendAndSettle(opened.uri, key, opened.lineOf('POST {{baseUrl}}/stream'), 4);
    await waitFor(
      async () => (await decorations(opened.uri)).length === 4,
      'the decorations never appeared',
    );

    const line = opened.lineOf('# @expect status == 201');
    const edit = new vscode.WorkspaceEdit();
    edit.replace(opened.uri, new vscode.Range(line, 20, line, 23), '202');
    assert.ok(await vscode.workspace.applyEdit(edit));

    await waitFor(
      async () => (await decorations(opened.uri)).every((decoration) => decoration.line !== line),
      'the edited line kept its decoration',
    );
    assert.equal((await decorations(opened.uri)).length, 3);
  });
});
