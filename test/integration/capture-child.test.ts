import * as assert from 'node:assert/strict';
import { fork, type Serializable } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { removeTemporaryFolder } from './temporary-folder';

const extensionId = 'achrafelkhnissi.streamscope';

interface ChildAnswer {
  reply: unknown;
  code: number | null;
  signal: NodeJS.Signals | null;
}

function ask(file: string, message: Serializable): Promise<ChildAnswer> {
  return new Promise((resolve, reject) => {
    const child = fork(file, [], {
      execArgv: ['--max-old-space-size=1024'],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let reply: unknown;
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.once('message', (answer) => {
      reply = answer;
      child.kill('SIGKILL');
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ reply, code, signal });
    });
    child.send(message);
  });
}

describe('capture child processes', () => {
  it('run as Node when forked from the extension host', async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'streamscope-capture-child-'));
    const probe = path.join(folder, 'probe.js');
    writeFileSync(
      probe,
      [
        "const v8 = require('node:v8');",
        "process.once('message', () => {",
        '  process.send({',
        "    type: process.type ?? 'node',",
        '    node: process.versions.node,',
        '    heapLimit: v8.getHeapStatistics().heap_size_limit,',
        '    bigint: 12345678901234567890n,',
        '  });',
        '});',
      ].join('\n'),
    );

    try {
      const { reply } = await ask(probe, {});

      assert.ok(reply !== undefined, 'the forked child never answered');
      const facts = reply as { type: string; node: string; heapLimit: number; bigint: bigint };
      assert.equal(facts.type, 'node');
      assert.match(facts.node, /^\d+\.\d+\.\d+$/);
      assert.ok(facts.heapLimit >= 1024 * 1024 * 1024, String(facts.heapLimit));
      assert.ok(facts.heapLimit < 2048 * 1024 * 1024, String(facts.heapLimit));
      assert.equal(facts.bigint, 12345678901234567890n);
    } finally {
      removeTemporaryFolder(folder);
    }
  });

  it('answer a capture job from the packaged capture worker', async () => {
    const extension = vscode.extensions.getExtension(extensionId);
    assert.ok(extension, `${extensionId} is not loaded`);
    const worker = path.join(extension.extensionPath, 'dist', 'capture-worker.js');

    const { reply } = await ask(worker, {
      subject: {
        kind: 'body',
        bytes: new TextEncoder().encode('{"items":[{"id":12345678901234567890}]}'),
        contentType: 'application/json',
      },
      jobs: [
        { name: 'id', text: 'jsonpath("$.items[0].id")', known: new Map(), collected: new Map() },
      ],
    });

    assert.deepEqual(reply, {
      name: 'id',
      result: { present: true, text: '12345678901234567890', path: '$.items[0].id' },
    });
  });
});
