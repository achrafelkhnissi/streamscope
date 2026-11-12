import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import * as vscode from 'vscode';
import { startHttpServer, type LocalServer } from '../support/servers';

function syntheticJson(minimumBytes: number): Buffer {
  const items: { id: number; name: string; tags: string[]; note: string }[] = [];
  let size = 0;
  for (let id = 0; size < minimumBytes; id += 1) {
    const item = {
      id,
      name: `item-${String(id)}`,
      tags: ['synthetic', 'large'],
      note: 'Synthetic text for the large body acceptance test.',
    };
    size += JSON.stringify(item).length + 1;
    items.push(item);
  }
  return Buffer.from(JSON.stringify({ items }));
}

describe('large responses', () => {
  let folder = '';
  let server: LocalServer | undefined;

  before(() => {
    folder = mkdtempSync(path.join(tmpdir(), 'streamscope-large-'));
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await server?.close();
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('opens a 50 MB JSON body without blocking the extension host', async function () {
    this.timeout(180_000);
    const body = syntheticJson(50_000_000);
    assert.ok(body.length > 50_000_000);
    server = await startHttpServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(body);
    });
    const file = path.join(folder, 'large.http');
    writeFileSync(file, `GET ${server.url}/large`);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);

    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    await vscode.commands.executeCommand('streamscope.sendRequest');
    delay.disable();

    const bodyUri = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .flatMap((tab) =>
        tab.input instanceof vscode.TabInputText &&
        tab.input.uri.scheme === 'streamscope-response' &&
        tab.input.uri.path.endsWith('.json')
          ? [tab.input.uri]
          : [],
      )[0];
    assert.ok(bodyUri, 'the body document is not open');
    const maxMs = delay.max / 1_000_000;
    console.log(`Largest event loop delay while sending 50 MB: ${maxMs.toFixed(1)} ms`);
    assert.ok(maxMs < 250, `the event loop was blocked for ${maxMs.toFixed(1)} ms`);
    assert.ok((await vscode.workspace.fs.stat(bodyUri)).size > 50_000_000);
  });
});
