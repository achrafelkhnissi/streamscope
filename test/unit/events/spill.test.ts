import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpillArea } from '../../../src/events/spill';
import { defaultSpillLimits, type SpillLimits } from '../../../src/streaming/limits';

const encoder = new TextEncoder();

function limits(overrides: Partial<SpillLimits>): SpillLimits {
  return { ...defaultSpillLimits, ...overrides };
}

function text(bytes: Uint8Array | undefined): string | undefined {
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await once(child, 'exit');
  if (child.pid === undefined) {
    throw new Error('The child process has no pid');
  }
  return child.pid;
}

function fileHandles(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === 'FileHandle').length;
}

describe('SpillArea and SpillFile', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'streamscope-spill-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes chunks and reads any range back', async () => {
    const area = await SpillArea.open(root);
    const file = await area.create();
    file.append(encoder.encode('hello '));
    file.append(encoder.encode('synthetic world'));
    await file.finish();

    expect(file.savedBytes).toBe(21);
    expect(text(await file.read(0, 5))).toBe('hello');
    expect(text(await file.read(6, 9))).toBe('synthetic');
    expect(text(await file.read(16, 5))).toBe('world');
    expect(area.totalSize).toBe(21);
    await area.dispose();
  });

  it('reads a range that is still being written', async () => {
    const area = await SpillArea.open(root);
    const file = await area.create();
    file.append(encoder.encode('{"type":"RUN_STARTED"}\n'));

    expect(text(await file.read(0, 22))).toBe('{"type":"RUN_STARTED"}');
    await area.dispose();
  });

  it('stops saving at the per-file cap and reports it', async () => {
    const area = await SpillArea.open(root, limits({ maxFileSize: 10 }));
    const file = await area.create();
    for (const chunk of ['abcd', 'efgh', 'ijkl', 'mnop']) {
      file.append(encoder.encode(chunk));
    }
    await file.finish();

    expect(file.savedBytes).toBe(8);
    expect(file.capped).toBe(true);
    expect(text(await file.read(4, 4))).toBe('efgh');
    expect(await file.read(8, 4)).toBeUndefined();
    expect(statSync(file.path).size).toBe(8);
    await area.dispose();
  });

  it('evicts the oldest other file when the total cap is reached', async () => {
    const area = await SpillArea.open(root, limits({ maxTotalSize: 16 }));
    const oldest = await area.create();
    const newest = await area.create();
    oldest.append(encoder.encode('0123456789'));
    await oldest.finish();

    newest.append(encoder.encode('abcdefghij'));

    expect(oldest.evicted).toBe(true);
    expect(newest.evicted).toBe(false);
    expect(newest.capped).toBe(false);
    expect(area.totalSize).toBe(10);
    expect(await oldest.read(0, 4)).toBeUndefined();
    await vi.waitFor(() => {
      expect(existsSync(oldest.path)).toBe(false);
    });
    expect(text(await newest.read(0, 10))).toBe('abcdefghij');
    await area.dispose();
  });

  it('caps a file that cannot fit even after evicting every other file', async () => {
    const area = await SpillArea.open(root, limits({ maxTotalSize: 8 }));
    const file = await area.create();
    file.append(encoder.encode('0123'));
    file.append(encoder.encode('45678'));

    expect(file.capped).toBe(true);
    expect(file.savedBytes).toBe(4);
    await area.dispose();
  });

  it('signals backpressure and drain', async () => {
    const area = await SpillArea.open(root, limits({ writeBufferBytes: 4 }));
    const file = await area.create();
    const drained = new Promise<void>((resolve) => {
      file.onDrain(resolve);
    });

    expect(file.append(encoder.encode('01234567'))).toBe(false);
    await drained;
    await area.dispose();
  });

  it.skipIf(process.platform === 'win32')('creates owner-only files and directories', async () => {
    const area = await SpillArea.open(root);
    const file = await area.create();
    file.append(encoder.encode('synthetic'));
    await file.finish();

    expect(statSync(area.directory).mode & 0o777).toBe(0o700);
    expect(statSync(file.path).mode & 0o777).toBe(0o600);
    await area.dispose();
  });

  it('removes spill directories of exited processes only', async () => {
    const dead = String(await deadPid());
    const alive = String(process.ppid);
    for (const name of [dead, alive, 'notes']) {
      mkdirSync(path.join(root, name));
      writeFileSync(path.join(root, name, 'left.spill'), 'synthetic');
    }
    mkdirSync(path.join(root, '424242'));
    writeFileSync(path.join(root, '424242', 'stale.spill'), 'synthetic');

    const area = await SpillArea.open(root, defaultSpillLimits, 424242);

    expect(existsSync(path.join(root, dead))).toBe(false);
    expect(existsSync(path.join(root, alive, 'left.spill'))).toBe(true);
    expect(existsSync(path.join(root, 'notes', 'left.spill'))).toBe(true);
    expect(area.directory).toBe(path.join(root, '424242'));
    expect(readdirSync(area.directory)).toEqual([]);
    await area.dispose();
  });

  it('deletes files on delete and everything on dispose', async () => {
    const baseline = fileHandles();
    const area = await SpillArea.open(root);
    const first = await area.create();
    const second = await area.create();
    first.append(encoder.encode('first'));
    second.append(encoder.encode('second'));
    expect(text(await first.read(0, 5))).toBe('first');
    expect(text(await second.read(0, 6))).toBe('second');

    await first.delete();

    expect(existsSync(first.path)).toBe(false);
    expect(await first.read(0, 5)).toBeUndefined();
    expect(area.totalSize).toBe(6);

    await area.dispose();

    expect(existsSync(second.path)).toBe(false);
    expect(existsSync(area.directory)).toBe(false);
    expect(fileHandles()).toBe(baseline);
  });
});
