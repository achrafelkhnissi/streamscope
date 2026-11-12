import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseHttpFile } from '../../../src/http-file/parse';
import { buildOutgoingRequest, type BuildResult } from '../../../src/runs/build-request';
import type { BodyPart } from '../../../src/transport/model';
import { resolveRequest } from '../../../src/variables/resolve';
import { testSources } from '../variables/sources';

let root = '';

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'streamscope-build-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const system = {
  now: () => new Date('2026-11-11T10:20:30.456Z'),
  uuid: () => '00000000-0000-4000-8000-000000000001',
  randomInt: (minInclusive: number) => minInclusive,
};

async function build(...lines: string[]): Promise<BuildResult> {
  const file = parseHttpFile(lines.join('\n'));
  const request = file.requests[0];
  if (!request) {
    throw new Error('expected a request');
  }
  const resolution = resolveRequest(file, request, testSources({ system }));
  if (!resolution.ok) {
    throw new Error(resolution.problems.map((problem) => problem.message).join('\n'));
  }
  return buildOutgoingRequest(resolution.request, resolution.scope, {
    documentDir: root,
    containmentRoot: root,
  });
}

async function built(...lines: string[]) {
  const result = await build(...lines);
  if (!result.ok) {
    throw new Error(result.problems.map((problem) => problem.message).join('\n'));
  }
  return result.request;
}

function text(parts: readonly BodyPart[]): string {
  return parts
    .map((part) =>
      part.kind === 'bytes'
        ? Buffer.from(part.bytes).toString()
        : `<file ${path.basename(part.path)} ${String(part.size)}>`,
    )
    .join('');
}

function at(line: number, start: number, end: number) {
  return { start: { line, character: start }, end: { line, character: end } };
}

describe('buildOutgoingRequest', () => {
  it('parses the url and keeps headers in order', async () => {
    const request = await built('patch https://api.example.test/items/1?q=a b', 'X-B: 2', 'x-a: 1');

    expect(request.method).toBe('patch');
    expect(request.url.href).toBe('https://api.example.test/items/1?q=a%20b');
    expect(request.headers).toEqual([
      ['X-B', '2'],
      ['x-a', '1'],
    ]);
    expect(request.body).toEqual([]);
  });

  it('builds the url from a Host header and a path', async () => {
    expect((await built('GET /items', 'Host: api.example.test:8443')).url.href).toBe(
      'https://api.example.test:8443/items',
    );
    expect((await built('GET /items', 'Host: api.example.test:443')).url.href).toBe(
      'https://api.example.test/items',
    );
    expect((await built('GET /items', 'host: api.example.test')).url.href).toBe(
      'http://api.example.test/items',
    );
  });

  it('reports an invalid url', async () => {
    expect(await build('GET ftp://api.example.test/file')).toEqual({
      ok: false,
      problems: [
        {
          message: '`ftp://api.example.test/file` is not a valid http or https URL.',
          range: at(0, 4, 31),
        },
      ],
    });
    const notUrl = await build('GET not a url');
    expect(!notUrl.ok && notUrl.problems[0]?.message).toBe(
      '`not a url` is not a valid http or https URL.',
    );
  });

  it('quotes the url as written, with user info masked, when it is invalid', async () => {
    const result = await build(
      '@pw = synthetic-secret',
      'GET https://admin:{{pw}}@api.example.test:99999/',
    );

    expect(!result.ok && result.problems.map((problem) => problem.message)).toEqual([
      '`https://••••••@api.example.test:99999/` is not a valid http or https URL.',
    ]);
  });

  it('blocks user info with an invalid % escape', async () => {
    expect(await build('GET http://user:p%zz@api.example.test/')).toEqual({
      ok: false,
      problems: [
        {
          message:
            'The user name or password in the URL has a % that is not followed by two hex digits.',
          range: at(0, 4, 38),
        },
      ],
    });
  });

  it('joins text lines with LF', async () => {
    const request = await built('POST https://api.example.test/items', '', '{', '  "a": 1', '}');

    expect(text(request.body)).toBe('{\n  "a": 1\n}');
  });

  it('uses CRLF for multipart/form-data', async () => {
    const request = await built(
      'POST https://api.example.test/upload',
      'Content-Type: multipart/form-data; boundary=b',
      '',
      '--b',
      'Content-Disposition: form-data; name="a"',
      '',
      '1',
      '--b--',
    );

    expect(text(request.body)).toBe(
      '--b\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--b--',
    );
  });

  it('appends & lines without a separator for form bodies', async () => {
    const request = await built(
      'POST https://api.example.test/login',
      'Content-Type: application/x-www-form-urlencoded',
      '',
      'user=ada',
      '&pass=synthetic',
    );

    expect(text(request.body)).toBe('user=ada&pass=synthetic');
  });

  it('adds a trailing newline for application/x-ndjson', async () => {
    const request = await built(
      'POST https://api.example.test/events',
      'Content-Type: application/x-ndjson',
      '',
      '{"a":1}',
      '{"b":2}',
    );

    expect(text(request.body)).toBe('{"a":1}\n{"b":2}\n');
  });

  it('ends every line and part with the line ending when a file part is present', async () => {
    writeFileSync(path.join(root, 'logo.png'), 'PNGDATA');

    const request = await built(
      'POST https://api.example.test/upload',
      'Content-Type: multipart/form-data; boundary=b',
      '',
      '--b',
      'Content-Type: image/png',
      '',
      '< ./logo.png',
      '--b--',
    );

    expect(text(request.body)).toBe(
      '--b\r\nContent-Type: image/png\r\n\r\n<file logo.png 7>\r\n--b--\r\n',
    );
  });

  it('streams < files as file parts with their size', async () => {
    writeFileSync(path.join(root, 'payload.json'), '{"name":"{{name}}"}');

    const request = await built(
      '@name = Ada',
      'POST https://api.example.test/items',
      '',
      '< ./payload.json',
    );

    expect(request.body).toEqual([
      { kind: 'file', path: path.join(root, 'payload.json'), size: 19 },
      { kind: 'bytes', bytes: Buffer.from('\n') },
    ]);
  });

  it('reads <@latin1 files, resolves their variables and sends UTF-8', async () => {
    writeFileSync(
      path.join(root, 'latin.txt'),
      Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x7b, 0x7b, 0x6e, 0x61, 0x6d, 0x65, 0x7d, 0x7d]),
    );

    const request = await built(
      '@name = Ada',
      'POST https://api.example.test/items',
      '',
      '<@latin1 ./latin.txt',
    );

    expect(text(request.body)).toBe('café Ada\n');
  });

  it('reports unresolved variables inside <@ files at the path', async () => {
    writeFileSync(path.join(root, 'template.json'), '{"id":"{{missing}}"}');

    expect(await build('POST https://api.example.test/items', '', '<@ ./template.json')).toEqual({
      ok: false,
      problems: [
        {
          message:
            '`{{missing}}` is not defined in this file or `$shared` (no environment selected).',
          range: at(2, 3, 18),
        },
      ],
    });
  });

  it('reports an unsupported encoding', async () => {
    writeFileSync(path.join(root, 'data.txt'), 'x');

    expect(await build('POST https://api.example.test/items', '', '<@klingon ./data.txt')).toEqual({
      ok: false,
      problems: [{ message: 'Unsupported encoding `klingon`.', range: at(2, 10, 20) }],
    });
  });

  it('reports a missing body file at its path', async () => {
    expect(await build('POST https://api.example.test/items', '', '< ./missing.json')).toEqual({
      ok: false,
      problems: [{ message: 'Body file `./missing.json` was not found.', range: at(2, 2, 16) }],
    });
  });
});
