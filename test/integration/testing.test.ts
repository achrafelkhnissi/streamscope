import * as assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { startHttpServer, type LocalServer } from '../support/servers';
import { removeTemporaryFolder } from './temporary-folder';

interface ItemState {
  id: string;
  label: string;
  description: string | undefined;
  sortText: string | undefined;
  range: [number, number] | undefined;
  children: ItemState[];
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

function testItems(uri?: vscode.Uri): Thenable<ItemState[]> {
  return vscode.commands.executeCommand<ItemState[]>('streamscope.test.testItems', uri);
}

async function fileItem(uri: vscode.Uri): Promise<ItemState | undefined> {
  return (await testItems(uri))[0];
}

describe('testing view items', () => {
  let folder = '';

  before(() => {
    folder = mkdtempSync(path.join(tmpdir(), 'streamscope-testing-'));
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  after(() => {
    removeTemporaryFolder(folder);
  });

  async function open(name: string, lines: readonly string[]) {
    const file = path.join(folder, name);
    writeFileSync(file, [...lines, ''].join('\n'));
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    return { document, editor, uri: document.uri };
  }

  const flowLines = [
    '@baseUrl = https://api.example.test',
    '',
    '### Start',
    '# @name start',
    'POST {{baseUrl}}/agent/run',
    '',
    '### Continue',
    'POST {{baseUrl}}/agent/continue',
    '',
    '###',
    'GET {{baseUrl}}/status',
  ];

  it('lists an open .http file with one test per request, in file order, with ranges', async () => {
    const opened = await open('flow.http', flowLines);
    await waitFor(
      async () => (await fileItem(opened.uri))?.children.length === 3,
      'the requests never appeared',
    );
    const item = await fileItem(opened.uri);
    assert.ok(item);
    assert.equal(item.id, opened.uri.toString());
    const uri = opened.uri.toString();
    assert.deepEqual(
      item.children.map(({ id, label, description, sortText, range }) => ({
        id,
        label,
        description,
        sortText,
        range,
      })),
      [
        {
          id: `${uri}\n@start`,
          label: 'start',
          description: 'POST {{baseUrl}}/agent/run',
          sortText: '00000',
          range: [2, 5],
        },
        {
          id: `${uri}\n#1 POST {{baseUrl}}/agent/continue`,
          label: 'Continue',
          description: 'POST {{baseUrl}}/agent/continue',
          sortText: '00001',
          range: [6, 8],
        },
        {
          id: `${uri}\n#2 GET {{baseUrl}}/status`,
          label: 'GET {{baseUrl}}/status',
          description: undefined,
          sortText: '00002',
          range: [9, 11],
        },
      ],
    );
  });

  it('updates the tests when the file changes', async () => {
    const opened = await open('edited.http', flowLines);
    await waitFor(
      async () => (await fileItem(opened.uri))?.children.length === 3,
      'the requests never appeared',
    );
    const uri = opened.uri.toString();

    await opened.editor.edit((edit) => {
      edit.insert(new vscode.Position(2, 0), '### Health\nGET {{baseUrl}}/health\n\n');
    });
    await waitFor(
      async () => (await fileItem(opened.uri))?.children.length === 4,
      'the inserted request never appeared',
    );
    let ids = (await fileItem(opened.uri))?.children.map(({ id }) => id) ?? [];
    assert.deepEqual(ids, [
      `${uri}\n#0 GET {{baseUrl}}/health`,
      `${uri}\n@start`,
      `${uri}\n#2 POST {{baseUrl}}/agent/continue`,
      `${uri}\n#3 GET {{baseUrl}}/status`,
    ]);

    const line = opened.document.getText().split('\n').indexOf('GET {{baseUrl}}/status');
    await opened.editor.edit((edit) => {
      edit.replace(new vscode.Range(line, 4, line, 22), '{{baseUrl}}/ready');
    });
    await waitFor(
      async () =>
        (await fileItem(opened.uri))?.children.some(({ id }) => id.endsWith('/ready')) === true,
      'the changed URL never reached the item',
    );
    ids = (await fileItem(opened.uri))?.children.map(({ id }) => id) ?? [];
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.includes(`${uri}\n#3 GET {{baseUrl}}/ready`));
  });

  it('gives a duplicate @name its own item', async () => {
    const opened = await open('duplicate.http', [
      '# @name same',
      'GET https://api.example.test/one',
      '',
      '###',
      '# @name same',
      'GET https://api.example.test/two',
    ]);
    await waitFor(
      async () => (await fileItem(opened.uri))?.children.length === 2,
      'the requests never appeared',
    );
    const uri = opened.uri.toString();
    assert.deepEqual(
      (await fileItem(opened.uri))?.children.map(({ id }) => id),
      [`${uri}\n@same`, `${uri}\n@same\n#1`],
    );
  });

  it('lists an untitled http document', async () => {
    const document = await vscode.workspace.openTextDocument({
      language: 'http',
      content: 'GET https://api.example.test/untitled\n',
    });
    await vscode.window.showTextDocument(document);
    await waitFor(
      async () => (await fileItem(document.uri))?.children.length === 1,
      'the untitled request never appeared',
    );
  });

  it('removes an item when its document closes', async () => {
    const opened = await open('closing.http', ['GET https://api.example.test/closing']);
    await waitFor(
      async () => (await fileItem(opened.uri)) !== undefined,
      'the file never appeared',
    );

    await vscode.languages.setTextDocumentLanguage(opened.document, 'plaintext');

    await waitFor(
      async () => (await fileItem(opened.uri)) === undefined,
      'the file item stayed after its document closed',
    );
  });
});

interface Report {
  kind: string;
  id: string;
  messages?: { text: string; line: number | undefined }[];
  durationMs?: number;
  output?: string;
}

function testReports(): Thenable<Report[]> {
  return vscode.commands.executeCommand<Report[]>('streamscope.test.testReports');
}

describe('file runs', () => {
  let folder = '';
  let server: LocalServer | undefined;

  before(async () => {
    await vscode.extensions.getExtension('achrafelkhnissi.streamscope')?.activate();
    folder = mkdtempSync(path.join(tmpdir(), 'streamscope-file-runs-'));
    server = await startHttpServer((request, response) => {
      if (request.url === '/start') {
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        response.end('{"type":"RUN_STARTED","threadId":"thread-1"}\n{"type":"RUN_FINISHED"}\n');
        return;
      }
      if (request.url === '/continue') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ thread: request.headers['x-thread'] }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      let n = 0;
      const timer = setInterval(() => {
        n += 1;
        response.write(`${JSON.stringify({ type: 'TICK', n })}\n`);
      }, 100);
      response.on('close', () => {
        clearInterval(timer);
      });
    });
  });

  beforeEach(async () => {
    await testReports();
  });

  afterEach(async () => {
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
    const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    const lineOf = (text: string): number => {
      const found = document.getText().split('\n').indexOf(text);
      assert.notEqual(found, -1, `missing line ${text}`);
      return found;
    };
    return {
      document,
      editor,
      uri: document.uri,
      key: (name: string) => `${document.uri.toString()}\n@${name}`,
      lineOf,
    };
  }

  function outcomes(reports: readonly Report[]): [string, string][] {
    return reports
      .filter(({ kind }) => kind !== 'output' && kind !== 'enqueued')
      .map(({ kind, id }) => [kind, id.slice(id.lastIndexOf('@') + 1)]);
  }

  it('passes a multi-request file with captures and checks', async () => {
    const opened = await open('pass.http', [
      '### Start',
      '# @name start',
      '# @capture threadId = first(type == "RUN_STARTED").threadId',
      '# @expect status == 200',
      'POST {{baseUrl}}/start',
      '',
      '### Continue',
      '# @name continueRun',
      '# @expect body.thread == "thread-1"',
      'POST {{baseUrl}}/continue',
      'X-Thread: {{threadId}}',
      '',
      '### Again',
      '# @name again',
      '# @expect status == 200',
      'POST {{baseUrl}}/continue',
      'X-Thread: {{start.threadId}}',
    ]);

    await vscode.commands.executeCommand('streamscope.runFile', opened.uri);

    assert.deepEqual(outcomes(await testReports()), [
      ['started', 'start'],
      ['passed', 'start'],
      ['started', 'continueRun'],
      ['passed', 'continueRun'],
      ['started', 'again'],
      ['passed', 'again'],
    ]);
  });

  it('skips the dependants of a failed producer, with the reason', async () => {
    const opened = await open('skip.http', [
      '### Start',
      '# @name start',
      '# @capture threadId = first(type == "NOPE").threadId',
      'POST {{baseUrl}}/start',
      '',
      '### Continue',
      '# @name continueRun',
      '# @capture thread = body.thread',
      'POST {{baseUrl}}/continue',
      'X-Thread: {{threadId}}',
      '',
      '### Again',
      '# @name again',
      'POST {{baseUrl}}/continue',
      'X-Thread: {{continueRun.thread}}',
    ]);

    await vscode.commands.executeCommand('streamscope.runFile', opened.uri);

    const reports = await testReports();
    assert.deepEqual(outcomes(reports), [
      ['started', 'start'],
      ['passed', 'start'],
      ['started', 'continueRun'],
      ['skipped', 'continueRun'],
      ['started', 'again'],
      ['skipped', 'again'],
    ]);
    const skipped = reports.find(
      ({ kind, id, output }) =>
        kind === 'output' &&
        id === opened.key('continueRun') &&
        output?.includes('skipped') === true,
    );
    assert.ok(skipped?.output?.includes('start › threadId failed'), JSON.stringify(reports));
  });

  it('fails a request with one message per failed check, at its # @expect line', async () => {
    const opened = await open('fail.http', [
      '### Start',
      '# @name start',
      '# @expect status == 200',
      '# @expect status == 201',
      'POST {{baseUrl}}/start',
    ]);

    await vscode.commands.executeCommand('streamscope.runFile', opened.uri);

    const failed = (await testReports()).find(({ kind }) => kind === 'failed');
    assert.deepEqual(failed?.messages, [
      { text: '`status == 201` got 200', line: opened.lineOf('# @expect status == 201') },
    ]);
  });

  it('errors a request that times out with # @timeout', async () => {
    const opened = await open('timeout.http', [
      '### Slow',
      '# @name slow',
      '# @timeout 300ms',
      'GET {{baseUrl}}/slow',
    ]);

    await vscode.commands.executeCommand('streamscope.runFile', opened.uri);

    const errored = (await testReports()).find(({ kind }) => kind === 'errored');
    assert.ok(errored?.messages?.[0]?.text.includes('# @timeout'), JSON.stringify(errored));
  });

  it('passes a request that # @until ends', async () => {
    const opened = await open('until.http', [
      '### Slow',
      '# @name slow',
      '# @until n == 3',
      '# @expect count() == 3',
      'GET {{baseUrl}}/slow',
    ]);

    await vscode.commands.executeCommand('streamscope.runFile', opened.uri);

    assert.deepEqual(outcomes(await testReports()), [
      ['started', 'slow'],
      ['passed', 'slow'],
    ]);
  });

  it('stops the run: cancels the active request and reports nothing for the rest', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('testing.cancelRun'));
    const opened = await open('stop.http', [
      '### Slow',
      '# @name slow',
      'GET {{baseUrl}}/slow',
      '',
      '### Start',
      '# @name start',
      'POST {{baseUrl}}/start',
    ]);
    await waitFor(
      async () => (await fileItem(opened.uri))?.children.length === 2,
      'the requests never appeared',
    );
    const closedBefore = server?.sockets.closed ?? 0;
    const openedBefore = server?.sockets.opened ?? 0;

    const running = vscode.commands.executeCommand('streamscope.runFile', opened.uri);
    await waitFor(
      () => (server?.sockets.opened ?? 0) > openedBefore,
      'the slow request never connected',
    );
    await vscode.commands.executeCommand('testing.cancelRun');
    await running;

    const reports: Report[] = [];
    await waitFor(async () => {
      reports.push(...(await testReports()));
      return reports.some(({ kind }) => kind === 'skipped');
    }, 'the stopped request was never reported');
    assert.deepEqual(outcomes(reports), [
      ['started', 'slow'],
      ['skipped', 'slow'],
    ]);
    await waitFor(
      () => (server?.sockets.closed ?? 0) > closedBefore,
      'the slow request kept its connection',
    );
  });

  it('runs one request from its test item', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('testing.runAtCursor'));
    const opened = await open('one.http', [
      '### Start',
      '# @name start',
      'POST {{baseUrl}}/start',
      '',
      '### Again',
      '# @name again',
      'POST {{baseUrl}}/continue',
    ]);
    await waitFor(
      async () => (await fileItem(opened.uri))?.children.length === 2,
      'the requests never appeared',
    );
    const line = opened.lineOf('POST {{baseUrl}}/continue');
    opened.editor.selection = new vscode.Selection(line, 0, line, 0);

    await vscode.commands.executeCommand('testing.runAtCursor');

    const reports: Report[] = [];
    await waitFor(async () => {
      reports.push(...(await testReports()));
      return reports.some(({ kind }) => kind === 'passed');
    }, 'the request at the cursor never passed');
    assert.deepEqual(outcomes(reports), [
      ['started', 'again'],
      ['passed', 'again'],
    ]);
  });
});
