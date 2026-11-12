import * as assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import * as vscode from 'vscode';
import { startHttpServer, type LocalServer } from '../support/servers';
import { removeTemporaryFolder } from './temporary-folder';

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

async function largestDelayDuring(action: () => Thenable<unknown>): Promise<number> {
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  await action();
  delay.disable();
  return delay.max / 1_000_000;
}

function median(values: number[]): number {
  const middle = values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
  assert.ok(middle !== undefined);
  return middle;
}

function milliseconds(values: number[]): string {
  return values.map((value) => value.toFixed(1)).join(', ');
}

function openBodyUri(): vscode.Uri | undefined {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .flatMap((tab) =>
      tab.input instanceof vscode.TabInputText &&
      tab.input.uri.scheme === 'streamscope-response' &&
      tab.input.uri.path.endsWith('.json')
        ? [tab.input.uri]
        : [],
    )[0];
}

const samples = 7;

describe('large responses', () => {
  let folder = '';
  let server: LocalServer | undefined;

  before(() => {
    folder = mkdtempSync(path.join(tmpdir(), 'streamscope-large-'));
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await server?.close();
    removeTemporaryFolder(folder);
  });

  it('adds little to the time VS Code itself needs to open a 50 MB JSON body', async function () {
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

    const sendMs: number[] = [];
    const baselineMs: number[] = [];
    for (let sample = 0; sample < samples; sample += 1) {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
      sendMs.push(
        await largestDelayDuring(() => vscode.commands.executeCommand('streamscope.sendRequest')),
      );
      const bodyUri = openBodyUri();
      assert.ok(bodyUri, 'the body document is not open');
      const size = (await vscode.workspace.fs.stat(bodyUri)).size;
      assert.ok(size > 50_000_000);

      const baselineUri = bodyUri.with({ query: `baseline-${String(sample)}` });
      baselineMs.push(
        await largestDelayDuring(() =>
          vscode.commands.executeCommand('vscode.open', baselineUri, {
            viewColumn: vscode.ViewColumn.Beside,
            preserveFocus: true,
            preview: false,
          }),
        ),
      );
      assert.equal((await vscode.workspace.fs.stat(baselineUri)).size, size);
    }

    const send = median(sendMs);
    const baseline = median(baselineMs);
    console.log(
      `Largest event loop delay for 50 MB over ${String(samples)} runs: sending ${milliseconds(sendMs)} ms (median ${send.toFixed(1)}), VS Code opening the same document ${milliseconds(baselineMs)} ms (median ${baseline.toFixed(1)})`,
    );
    assert.ok(
      send < baseline + 250,
      `Streamscope blocked the extension host ${(send - baseline).toFixed(1)} ms longer than VS Code's own open (medians of ${String(samples)} runs)`,
    );
    const worst = Math.max(...sendMs);
    assert.ok(worst < 2_000, `the extension host froze for ${worst.toFixed(1)} ms`);
  });
});
