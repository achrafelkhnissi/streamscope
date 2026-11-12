import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpillArea, type SpillFile } from '../../../src/events/spill';
import { rawTailBytes, readRawTail } from '../../../src/runs/raw-read';

const encoder = new TextEncoder();

async function write(file: SpillFile, bytes: Uint8Array, piece = 100_000): Promise<void> {
  for (let at = 0; at < bytes.length; at += piece) {
    file.append(bytes.subarray(at, at + piece));
  }
  await file.finish();
}

describe('reading the raw tail of a run back from its spill file', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'streamscope-raw-read-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads the last 2 MiB', () => {
    expect(rawTailBytes).toBe(2_097_152);
  });

  it('reads everything when the data is shorter than the tail', async () => {
    const area = await SpillArea.open(root);
    const file = await area.create();
    const text = '{"type":"PART","index":1}\n{"type":"PART","index":2}\n';
    await write(file, encoder.encode(text));

    expect(await readRawTail(file, false)).toBe(text);
    await area.dispose();
  });

  it('reads only the last bytes of a longer file, not the whole of it', async () => {
    const area = await SpillArea.open(root);
    const file = await area.create();
    const text = 'abcdefghij'.repeat(300_000);
    await write(file, encoder.encode(text));
    const read = vi.spyOn(file, 'read');

    const tail = await readRawTail(file, false);

    expect(tail).toBe(text.slice(text.length - rawTailBytes));
    expect(tail?.length).toBe(rawTailBytes);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(text.length - rawTailBytes, rawTailBytes);
    await area.dispose();
  });

  it('starts at the first character boundary when the tail begins inside a character', async () => {
    const area = await SpillArea.open(root);
    const file = await area.create();
    const text = '€'.repeat(20);
    await write(file, encoder.encode(text));

    const tail = await readRawTail(file, false, 10);

    expect(tail).toBe('€€€');
    expect(await readRawTail(file, false, 11)).toBe('€€€');
    expect(await readRawTail(file, false, 12)).toBe('€€€€');
    expect(await readRawTail(file, false, 9)).toBe('€€€');
    await area.dispose();
  });

  it('skips more than one continuation byte and keeps four-byte characters whole', async () => {
    const area = await SpillArea.open(root);
    const file = await area.create();
    await write(file, encoder.encode('😀'.repeat(6)));

    expect(await readRawTail(file, false, 10)).toBe('😀😀');
    expect(await readRawTail(file, false, 5)).toBe('😀');
    expect(await readRawTail(file, false, 3)).toBe('');
    await area.dispose();
  });

  it('keeps a character that ends the data cut short as the replacement character', async () => {
    const area = await SpillArea.open(root);
    const file = await area.create();
    await write(file, encoder.encode('ab€').subarray(0, 4));

    expect(await readRawTail(file, false)).toBe('ab�');
    await area.dispose();
  });

  it('has nothing to read when the file fails under the read, as when eviction closes it', async () => {
    const area = await SpillArea.open(root);
    const file = await area.create();
    await write(file, encoder.encode('data'));
    vi.spyOn(file, 'read').mockRejectedValue(new Error('EBADF: bad file descriptor, read'));

    expect(await readRawTail(file, false)).toBeUndefined();
    await area.dispose();
  });

  it('reads an empty file as empty text', async () => {
    const area = await SpillArea.open(root);
    const file = await area.create();
    await file.finish();

    expect(await readRawTail(file, false)).toBe('');
    await area.dispose();
  });

  it('has nothing to read without a spill file, once it was evicted or deleted, or after release', async () => {
    const area = await SpillArea.open(root);
    const evicted = await area.create();
    await write(evicted, encoder.encode('data'));
    const deleted = await area.create();
    await write(deleted, encoder.encode('data'));
    const released = await area.create();
    await write(released, encoder.encode('data'));

    evicted.evict();
    await deleted.delete();

    expect(await readRawTail(undefined, false)).toBeUndefined();
    expect(await readRawTail(evicted, false)).toBeUndefined();
    expect(await readRawTail(deleted, false)).toBeUndefined();
    expect(await readRawTail(released, true)).toBeUndefined();
    await area.dispose();
  });
});
