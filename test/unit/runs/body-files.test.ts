import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { locateBodyFile } from '../../../src/runs/body-files';

let base = '';
let root = '';
let documentDir = '';
let outside = '';

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'streamscope-body-')));
  root = path.join(base, 'workspace');
  documentDir = path.join(root, 'requests');
  outside = path.join(base, 'outside');
  mkdirSync(documentDir, { recursive: true });
  mkdirSync(outside);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('locateBodyFile', () => {
  it("prefers the workspace folder over the file's folder", async () => {
    writeFileSync(path.join(root, 'payload.json'), '{"from":"root"}');
    writeFileSync(path.join(documentDir, 'payload.json'), '{"from":"document"}');

    expect(await locateBodyFile('./payload.json', { documentDir, containmentRoot: root })).toEqual({
      ok: true,
      path: path.join(root, 'payload.json'),
      size: 15,
    });
  });

  it("falls back to the file's folder", async () => {
    writeFileSync(path.join(documentDir, 'only-here.txt'), 'abc');

    expect(await locateBodyFile('only-here.txt', { documentDir, containmentRoot: root })).toEqual({
      ok: true,
      path: path.join(documentDir, 'only-here.txt'),
      size: 3,
    });
  });

  it('accepts absolute paths inside the root', async () => {
    const file = path.join(documentDir, 'absolute.bin');
    writeFileSync(file, 'abcd');

    expect(await locateBodyFile(file, { documentDir, containmentRoot: root })).toEqual({
      ok: true,
      path: file,
      size: 4,
    });
  });

  it('rejects ../ paths outside the root', async () => {
    writeFileSync(path.join(outside, 'secret.txt'), 'synthetic');

    expect(
      await locateBodyFile('../outside/secret.txt', { documentDir, containmentRoot: root }),
    ).toEqual({
      ok: false,
      message: 'Body file `../outside/secret.txt` resolves outside the workspace folder.',
    });
  });

  it('rejects a symlink that points outside the root', async () => {
    writeFileSync(path.join(outside, 'secret.txt'), 'synthetic');
    symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));

    const result = await locateBodyFile('./link.txt', { documentDir, containmentRoot: root });

    expect(result).toEqual({
      ok: false,
      message: 'Body file `./link.txt` resolves outside the workspace folder.',
    });
  });

  it('rejects body files without a containment root', async () => {
    expect(
      await locateBodyFile('./payload.json', {
        documentDir: undefined,
        containmentRoot: undefined,
      }),
    ).toEqual({
      ok: false,
      message: 'Save the .http file first: body files are read relative to it.',
    });
  });

  it('reports a missing file', async () => {
    expect(await locateBodyFile('./missing.json', { documentDir, containmentRoot: root })).toEqual({
      ok: false,
      message: 'Body file `./missing.json` was not found.',
    });
  });

  it('reports a directory as not found', async () => {
    expect(await locateBodyFile('./requests', { documentDir, containmentRoot: root })).toEqual({
      ok: false,
      message: 'Body file `./requests` was not found.',
    });
  });
});
