import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { once } from 'node:events';
import { open, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpillArea } from '../../../src/events/spill';
import { collect, retainedHeap } from '../../support/memory';
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

  it('coalesces small appends instead of queueing one write each', async () => {
    const area = await SpillArea.open(root);
    const file = await area.create();
    const count = 200_000;
    const { bytes } = retainedHeap(() => {
      for (let index = 0; index < count; index += 1) {
        file.append(Uint8Array.of(0x61 + (index % 26)));
      }
      return file;
    });
    await file.finish();

    expect(bytes).toBeLessThan(8 * 1024 * 1024);
    expect(file.savedBytes).toBe(count);
    expect(text(await file.read(26, 26))).toBe('abcdefghijklmnopqrstuvwxyz');
    expect(statSync(file.path).size).toBe(count);
    await area.dispose();
  });

  it('reads staged bytes without waiting for a later append', async () => {
    const area = await SpillArea.open(root);
    const file = await area.create();
    file.append(encoder.encode('sta'));
    file.append(encoder.encode('ged'));

    expect(text(await file.read(0, 6))).toBe('staged');
    await area.dispose();
  });

  it('signals drain when a backpressured file is evicted or deleted', async () => {
    const area = await SpillArea.open(root, limits({ writeBufferBytes: 4, maxTotalSize: 12 }));
    const evicted = await area.create();
    const deleted = await area.create();
    const newest = await area.create();
    const drains: string[] = [];
    evicted.onDrain(() => drains.push('evicted'));
    deleted.onDrain(() => drains.push('deleted'));

    expect(evicted.append(encoder.encode('01234567'))).toBe(false);
    expect(deleted.append(encoder.encode('abcd'))).toBe(false);
    newest.append(encoder.encode('wxyz'));
    await deleted.delete();

    expect(evicted.evicted).toBe(true);
    expect(drains).toContain('evicted');
    expect(drains).toContain('deleted');
    await area.dispose();
  });

  it('deletes and disposes cleanly after the file vanished', async () => {
    const area = await SpillArea.open(root);
    const file = await area.create();
    file.append(encoder.encode('synthetic'));
    await file.finish();
    rmSync(file.path);

    await expect(file.read(0, 4)).rejects.toThrow();
    await file.delete();
    await area.dispose();

    expect(existsSync(area.directory)).toBe(false);
  });

  describe('copyTo', () => {
    const chunkBytes = 1024 * 1024;

    function pattern(length: number): Uint8Array {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        bytes[index] = (index * 31 + (index >> 8)) & 0xff;
      }
      return bytes;
    }

    it('copies a finished spill file in bounded reads', async () => {
      const area = await SpillArea.open(root);
      const file = await area.create();
      const content = pattern(5 * chunkBytes + 7);
      for (let start = 0; start < content.length; start += 300_000) {
        file.append(content.subarray(start, start + 300_000));
      }
      await file.finish();
      const destination = path.join(root, 'copy.bin');

      expect(await file.copyTo(destination)).toBe('complete');

      expect(Buffer.from(content).equals(readFileSync(destination))).toBe(true);
      await area.dispose();
    });

    it('holds about one chunk of a large copy in memory', async () => {
      const area = await SpillArea.open(root);
      const file = await area.create();
      const block = new Uint8Array(chunkBytes).fill(0x61);
      const size = 128 * chunkBytes;
      for (let index = 0; index < 128; index += 1) {
        if (!file.append(block)) {
          await new Promise<void>((resolve) => {
            const stop = file.onDrain(() => {
              stop();
              resolve();
            });
          });
        }
      }
      await file.finish();
      collect();
      const before = process.memoryUsage().arrayBuffers;
      let peak = before;
      const sampler = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().arrayBuffers);
      }, 1);
      const destination = path.join(root, 'large.bin');

      try {
        expect(await file.copyTo(destination)).toBe('complete');
      } finally {
        clearInterval(sampler);
      }

      expect(statSync(destination).size).toBe(size);
      expect(peak - before).toBeLessThan(4 * chunkBytes);
      await area.dispose();
    });

    it('copies an empty file to an empty destination', async () => {
      const area = await SpillArea.open(root);
      const file = await area.create();
      await file.finish();
      const destination = path.join(root, 'empty.bin');

      expect(await file.copyTo(destination)).toBe('complete');

      expect(statSync(destination).size).toBe(0);
      await area.dispose();
    });

    it('copies what a running file has written so far and keeps the file intact', async () => {
      const baseline = fileHandles();
      const area = await SpillArea.open(root);
      const file = await area.create();
      file.append(encoder.encode('{"n":1}\n'));
      file.append(encoder.encode('{"n":2}\n'));
      const first = path.join(root, 'first.ndjson');

      expect(await file.copyTo(first)).toBe('complete');

      expect(readFileSync(first, 'utf8')).toBe('{"n":1}\n{"n":2}\n');
      file.append(encoder.encode('{"n":3}\n'));
      await file.finish();
      const second = path.join(root, 'second.ndjson');
      expect(await file.copyTo(second)).toBe('complete');
      expect(readFileSync(second, 'utf8')).toBe('{"n":1}\n{"n":2}\n{"n":3}\n');
      expect(readFileSync(file.path, 'utf8')).toBe('{"n":1}\n{"n":2}\n{"n":3}\n');
      expect(file.savedBytes).toBe(24);
      await area.dispose();
      expect(fileHandles()).toBe(baseline);
    });

    it('reports a capped copy', async () => {
      const area = await SpillArea.open(root, limits({ maxFileSize: 10 }));
      const file = await area.create();
      for (const chunk of ['abcd', 'efgh', 'ijkl']) {
        file.append(encoder.encode(chunk));
      }
      await file.finish();
      const destination = path.join(root, 'capped.bin');

      expect(await file.copyTo(destination)).toBe('capped');

      expect(readFileSync(destination, 'utf8')).toBe('abcdefgh');
      await area.dispose();
    });

    it('reports an evicted file as unavailable and leaves the destination alone', async () => {
      const area = await SpillArea.open(root, limits({ maxTotalSize: 16 }));
      const oldest = await area.create();
      const newest = await area.create();
      oldest.append(encoder.encode('0123456789'));
      await oldest.finish();
      newest.append(encoder.encode('abcdefghij'));
      const destination = path.join(root, 'evicted.bin');
      writeFileSync(destination, 'earlier');

      expect(oldest.evicted).toBe(true);
      expect(await oldest.copyTo(destination)).toBe('unavailable');

      expect(readFileSync(destination, 'utf8')).toBe('earlier');
      await area.dispose();
    });

    it('reports a deleted file as unavailable', async () => {
      const area = await SpillArea.open(root);
      const file = await area.create();
      file.append(encoder.encode('synthetic'));
      await file.delete();
      const destination = path.join(root, 'deleted.bin');

      expect(await file.copyTo(destination)).toBe('unavailable');

      expect(existsSync(destination)).toBe(false);
      await area.dispose();
    });

    it('removes the partial destination when the file is evicted during the copy', async () => {
      const baseline = fileHandles();
      const area = await SpillArea.open(root);
      const file = await area.create();
      file.append(pattern(3 * chunkBytes));
      await file.finish();
      const probe = await open(path.join(root, 'probe.bin'), 'w');
      const prototype = Object.getPrototypeOf(probe) as FileHandle;
      await probe.close();
      const writeFile = Reflect.get(prototype, 'writeFile') as (
        this: FileHandle,
        data: Uint8Array,
      ) => Promise<void>;
      const spy = vi.spyOn(prototype, 'writeFile').mockImplementation(function (
        this: FileHandle,
        data,
      ) {
        file.evict();
        return writeFile.call(this, data as Uint8Array);
      });
      const destination = path.join(root, 'partial.bin');

      try {
        expect(await file.copyTo(destination)).toBe('unavailable');
      } finally {
        spy.mockRestore();
      }

      expect(existsSync(destination)).toBe(false);
      await area.dispose();
      expect(fileHandles()).toBe(baseline);
    });

    it('rejects when the destination cannot be written and keeps the file intact', async () => {
      const baseline = fileHandles();
      const area = await SpillArea.open(root);
      const file = await area.create();
      file.append(encoder.encode('synthetic'));
      await file.finish();

      await expect(file.copyTo(path.join(root, 'missing', 'copy.bin'))).rejects.toThrow();

      expect(text(await file.read(0, 9))).toBe('synthetic');
      expect(await file.copyTo(path.join(root, 'copy.bin'))).toBe('complete');
      await area.dispose();
      expect(fileHandles()).toBe(baseline);
    });
  });
});
