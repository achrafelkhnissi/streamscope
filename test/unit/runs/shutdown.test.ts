import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpillArea } from '../../../src/events/spill';
import { RunHistory } from '../../../src/runs/history';
import type { RunHandle, RunSnapshot } from '../../../src/runs/run';
import { sessionShutdown } from '../../../src/runs/shutdown';

function fakeRun(id: number, release: () => Promise<void>): RunHandle {
  return {
    id,
    done: new Promise<RunSnapshot>(() => undefined),
    headArrived: new Promise<void>(() => undefined),
    snapshot: () => {
      throw new Error('not used');
    },
    cancel: () => undefined,
    onUpdate: () => () => undefined,
    release,
    compact: () => undefined,
    readBody: () => Promise.resolve(undefined),
    bodyFile: () => Promise.resolve(undefined),
    readRaw: () => Promise.resolve(undefined),
    readReply: () => Promise.resolve(undefined),
    indexBytes: () => 0,
  };
}

describe('sessionShutdown', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'streamscope-shutdown-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves only once every run is released and the spill area is removed', async () => {
    const area = await SpillArea.open(root);
    const file = await area.create();
    file.append(new TextEncoder().encode('synthetic response body'));
    const events: string[] = [];
    const history = new RunHistory(5, () => true);
    history.add(
      fakeRun(1, async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push('released');
      }),
    );
    const dispose = vi.spyOn(area, 'dispose');

    await sessionShutdown(history, Promise.resolve(area))();
    events.push('resolved');

    expect(events).toEqual(['released', 'resolved']);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(existsSync(area.directory)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
    expect(history.list()).toEqual([]);
  });

  it('runs once however often it is called', async () => {
    const area = await SpillArea.open(root);
    const history = new RunHistory(5, () => true);
    const release = vi.fn(() => Promise.resolve());
    history.add(fakeRun(1, release));
    const dispose = vi.spyOn(area, 'dispose');
    const shutdown = sessionShutdown(history, Promise.resolve(area));

    const first = shutdown();
    const second = shutdown();
    await Promise.all([first, second]);

    expect(second).toBe(first);
    expect(release).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('releases the runs when the spill area could not be opened', async () => {
    const history = new RunHistory(5, () => true);
    const release = vi.fn(() => Promise.resolve());
    history.add(fakeRun(1, release));

    await sessionShutdown(history, Promise.resolve(undefined))();

    expect(release).toHaveBeenCalledTimes(1);
  });
});
