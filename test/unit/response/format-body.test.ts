import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatBody } from '../../../src/response/format-body';
import { formatBodyOffThread, workerThresholdBytes } from '../../../src/response/format-off-thread';

const encoder = new TextEncoder();

function format(text: string | Uint8Array, contentType: string | undefined) {
  return formatBody(typeof text === 'string' ? encoder.encode(text) : text, contentType);
}

describe('formatBody', () => {
  it('pretty-prints application/json', () => {
    expect(format('{"a":[1,2]}', 'application/json; charset=utf-8')).toEqual({
      languageId: 'json',
      text: '{\n  "a": [\n    1,\n    2\n  ]\n}',
      binary: false,
    });
  });

  it('pretty-prints +json types', () => {
    expect(format('{"title":"x"}', 'application/problem+json').languageId).toBe('json');
  });

  it('pretty-prints JSON sent as text/plain or without a type', () => {
    expect(format(' [1]', 'text/plain').text).toBe('[\n  1\n]');
    expect(format('{"a":1}', undefined).languageId).toBe('json');
    expect(format('plain words', 'text/plain')).toEqual({
      languageId: 'plaintext',
      text: 'plain words',
      binary: false,
    });
  });

  it('shows NDJSON labelled application/json unchanged as plaintext', () => {
    const ndjson = '{"type":"RUN_STARTED"}\n{"type":"RUN_FINISHED"}\n';

    expect(format(ndjson, 'application/json')).toEqual({
      languageId: 'plaintext',
      text: ndjson,
      binary: false,
    });
  });

  it('shows JSON too deep to indent unchanged as plaintext', () => {
    const deep = '['.repeat(300) + ']'.repeat(300);

    expect(format(deep, 'application/json')).toEqual({
      languageId: 'plaintext',
      text: deep,
      binary: false,
    });
  });

  it('maps xml, html, javascript and css', () => {
    expect(format('<a/>', 'application/xml').languageId).toBe('xml');
    expect(format('<a/>', 'text/xml').languageId).toBe('xml');
    expect(format('<a/>', 'application/atom+xml').languageId).toBe('xml');
    expect(format('<p>', 'text/html').languageId).toBe('html');
    expect(format('x()', 'application/javascript').languageId).toBe('javascript');
    expect(format('x()', 'text/javascript').languageId).toBe('javascript');
    expect(format('a{}', 'text/css').languageId).toBe('css');
    expect(format('a,b', 'text/csv').languageId).toBe('plaintext');
  });

  it('decodes the declared charset', () => {
    expect(
      format(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]), 'text/plain; charset=iso-8859-1').text,
    ).toBe('café');
  });

  it('falls back to UTF-8 for unknown charsets', () => {
    expect(format('café', 'text/plain; charset=no-such-charset').text).toBe('café');
  });

  it('describes image/png as binary', () => {
    expect(format(new Uint8Array(2048), 'image/png')).toEqual({
      languageId: 'plaintext',
      text: 'Binary body (2.0 KB). Use Save Response to keep it.',
      binary: true,
    });
  });

  it('treats NUL bytes without a type as binary', () => {
    expect(format(Uint8Array.from([0x41, 0x00, 0x42]), undefined).binary).toBe(true);
    expect(format(Uint8Array.from([0x41, 0x00, 0x42]), 'text/plain').binary).toBe(false);
  });

  it('formats an empty body as empty text', () => {
    expect(format('', 'application/json')).toEqual({
      languageId: 'plaintext',
      text: '',
      binary: false,
    });
  });
});

describe('formatBodyOffThread', () => {
  let folder = '';
  let workerFile = '';

  beforeAll(async () => {
    folder = mkdtempSync(path.join(tmpdir(), 'streamscope-worker-'));
    workerFile = path.join(folder, 'format-worker.js');
    await esbuild.build({
      entryPoints: ['src/response/format-worker.ts'],
      outfile: workerFile,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'node22',
      logLevel: 'silent',
    });
  });

  afterAll(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it('formats small bodies inline without a worker', async () => {
    const encoded = await formatBodyOffThread(
      encoder.encode('{"a":1}'),
      'application/json',
      '/nonexistent.js',
    );

    expect(encoded.languageId).toBe('json');
    expect(new TextDecoder().decode(encoded.content)).toBe('{\n  "a": 1\n}');
  });

  it('formats large bodies in a worker', async () => {
    const items = Array.from({ length: 40_000 }, (_, index) => ({
      id: index,
      name: `item-${String(index)}`,
    }));
    const bytes = encoder.encode(JSON.stringify({ items }));
    expect(bytes.length).toBeGreaterThan(workerThresholdBytes);

    const encoded = await formatBodyOffThread(bytes, 'application/json', workerFile);

    expect(encoded.languageId).toBe('json');
    expect(encoded.binary).toBe(false);
    expect(new TextDecoder().decode(encoded.content)).toBe(
      formatBody(bytes, 'application/json').text,
    );
  });

  it("leaves the caller's Buffer intact when it hands the bytes to the worker", async () => {
    const bytes = Buffer.from(JSON.stringify({ text: 'x'.repeat(workerThresholdBytes) }));
    const length = bytes.length;

    await formatBodyOffThread(bytes, 'application/json', workerFile);

    expect(bytes.length).toBe(length);
    expect(bytes.subarray(0, 9).toString()).toBe('{"text":"');
  });

  it('rejects when the worker cannot start', async () => {
    await expect(
      formatBodyOffThread(
        new Uint8Array(workerThresholdBytes + 1),
        'text/plain',
        '/nonexistent.js',
      ),
    ).rejects.toThrow();
  });
});
