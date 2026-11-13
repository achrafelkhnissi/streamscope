import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpillArea, type SpillFile } from '../../../src/events/spill';
import { bodySourceOf, readBodyFromSpill } from '../../../src/runs/body-spill';
import { defaultSpillLimits, type SpillLimits } from '../../../src/streaming/limits';

function limits(overrides: Partial<SpillLimits>): SpillLimits {
  return { ...defaultSpillLimits, ...overrides };
}

function pattern(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_unused, index) => (index * 31 + 7) % 251);
}

async function write(file: SpillFile, bytes: Uint8Array, piece = 100_000): Promise<void> {
  for (let at = 0; at < bytes.length; at += piece) {
    file.append(bytes.subarray(at, at + piece));
  }
  await file.finish();
}

describe('reading a body back from a spill file', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'streamscope-body-spill-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads a complete body in bounded chunks', async () => {
    const area = await SpillArea.open(root);
    const file = await area.create();
    const body = pattern(2_600_000);
    await write(file, body);

    const read = await readBodyFromSpill(file, body.length, body.length);

    expect(read).toEqual(body);
    expect(bodySourceOf(true, file, false, body.length)).toBe('spill');
    await area.dispose();
  });

  it('reads only the first bytes asked for', async () => {
    const area = await SpillArea.open(root);
    const file = await area.create();
    const body = pattern(300_000);
    await write(file, body);

    const read = await readBodyFromSpill(file, body.length, 1000);

    expect(read).toEqual(body.subarray(0, 1000));
    expect(await readBodyFromSpill(file, body.length, 10_000_000)).toEqual(body);
    await area.dispose();
  });

  it('reads the body when the cap was reached only after it', async () => {
    const area = await SpillArea.open(root, limits({ maxFileSize: 1500 }));
    const file = await area.create();
    const body = pattern(1200);
    await write(file, pattern(1800), 1200);

    expect(file.capped).toBe(true);
    expect(file.savedBytes).toBe(1200);
    expect(await readBodyFromSpill(file, body.length, body.length)).toEqual(body);
    expect(bodySourceOf(true, file, false, body.length)).toBe('spill');
    await area.dispose();
  });

  it('has nothing to read when the file was capped short of the body', async () => {
    const area = await SpillArea.open(root, limits({ maxFileSize: 1000 }));
    const file = await area.create();
    await write(file, pattern(1200), 600);

    expect(file.capped).toBe(true);
    expect(file.savedBytes).toBe(600);
    expect(await readBodyFromSpill(file, 1200, 1200)).toBeUndefined();
    expect(await readBodyFromSpill(file, 1200, 100)).toBeUndefined();
    expect(bodySourceOf(true, file, false, 1200)).toBe('gone');
    await area.dispose();
  });

  it('has nothing to read from an evicted file', async () => {
    const area = await SpillArea.open(root);
    const file = await area.create();
    await write(file, pattern(1200));

    file.evict();

    expect(await readBodyFromSpill(file, 1200, 1200)).toBeUndefined();
    expect(bodySourceOf(true, file, false, 1200)).toBe('gone');
    await area.dispose();
  });

  it('has nothing to read from a deleted file or after the run was released', async () => {
    const area = await SpillArea.open(root);
    const file = await area.create();
    await write(file, pattern(1200));
    expect(bodySourceOf(true, file, true, 1200)).toBe('gone');

    await file.delete();

    expect(await readBodyFromSpill(file, 1200, 1200)).toBeUndefined();
    await area.dispose();
  });

  it('has nothing to read when the file fails under the read, as when eviction closes it', async () => {
    const area = await SpillArea.open(root);
    const file = await area.create();
    await write(file, pattern(3_000_000));
    const read = vi.spyOn(file, 'read');
    read.mockResolvedValueOnce(new Uint8Array(1_048_576));
    read.mockRejectedValueOnce(new Error('EBADF: bad file descriptor, read'));

    expect(await readBodyFromSpill(file, 3_000_000, 3_000_000)).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(2);
    await area.dispose();
  });

  it('has nothing to read without a spill file', async () => {
    expect(await readBodyFromSpill(undefined, 1200, 1200)).toBeUndefined();
    expect(bodySourceOf(true, undefined, false, 1200)).toBe('gone');
  });

  it('keeps an empty body without a spill file', async () => {
    expect(await readBodyFromSpill(undefined, 0, 0)).toEqual(new Uint8Array());
    expect(bodySourceOf(true, undefined, false, 0)).toBe('memory');
  });

  it('says a body that was never dropped is in memory', async () => {
    const area = await SpillArea.open(root);
    const file = await area.create();

    expect(bodySourceOf(false, file, false, 1200)).toBe('memory');
    expect(bodySourceOf(false, undefined, true, 1200)).toBe('memory');
    await area.dispose();
  });
});
