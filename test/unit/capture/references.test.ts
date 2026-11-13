import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { evaluateResponseReference, type ReferencedRun } from '../../../src/capture/references';
import type { ResponseHead } from '../../../src/transport/model';
import { missingWorker, useCaptureWorker } from './worker';

const encoder = new TextEncoder();
const mebibyte = 1_048_576;
const folder = mkdtempSync(path.join(tmpdir(), 'streamscope-references-'));

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

function head(headers: [string, string][] = []): ResponseHead {
  return {
    httpVersion: '1.1',
    status: 200,
    statusText: 'OK',
    headers: [['Content-Type', 'application/json'], ...headers],
  };
}

interface Options {
  label?: string;
  status?: string;
  head?: ResponseHead | undefined;
  done?: Promise<unknown>;
  body?: string | undefined;
  bodyLength?: number;
  file?: { path: string; length: number };
  workerFile: string;
  reads?: number[];
}

function referenced(options: Options): ReferencedRun {
  const bytes = options.body === undefined ? undefined : encoder.encode(options.body);
  return {
    label: options.label ?? 'login',
    status: options.status ?? 'completed',
    head: 'head' in options ? options.head : head(),
    done: options.done ?? Promise.resolve(),
    bodyLength: options.bodyLength ?? bytes?.length ?? 0,
    readBody: (maxBytes) => {
      options.reads?.push(maxBytes);
      return Promise.resolve(bytes?.subarray(0, maxBytes));
    },
    bodyFile: () => Promise.resolve(options.file),
    workerFile: options.workerFile,
  };
}

function bodyFile(name: string, text: string): { path: string; length: number } {
  const file = path.join(folder, name);
  writeFileSync(file, text);
  return { path: file, length: Buffer.byteLength(text) };
}

describe('evaluateResponseReference', () => {
  const files = useCaptureWorker();

  it('reads response.body.$.x with JSONPath', async () => {
    const run = referenced({
      body: '{"token":"token-1","items":[{"id":1},{"id":2}],"big":12345678901234567890}',
      workerFile: files().worker,
    });

    await expect(evaluateResponseReference(run, 'response.body.$.token')).resolves.toStrictEqual({
      ok: true,
      text: 'token-1',
    });
    await expect(
      evaluateResponseReference(run, 'response.body.$.items[*].id'),
    ).resolves.toStrictEqual({ ok: true, text: '[1,2]' });
    await expect(evaluateResponseReference(run, 'response.body.$.big')).resolves.toStrictEqual({
      ok: true,
      text: '12345678901234567890',
    });
    await expect(evaluateResponseReference(run, 'response.body.$.missing')).resolves.toStrictEqual({
      ok: false,
      reason: 'the body has no value at $.missing (the query matched nothing)',
    });
  });

  it('runs a JSONPath reference in the child, never on the host', async () => {
    const run = referenced({ body: '{"token":"token-1"}', workerFile: missingWorker });

    await expect(evaluateResponseReference(run, 'response.body.$.token')).resolves.toStrictEqual({
      ok: false,
      reason: 'jsonpath() took too long or used too much memory',
    });
  });

  it('reads response.body.* as the whole body', async () => {
    const json = referenced({ body: '{"a":1,"b":[true,null]}', workerFile: missingWorker });
    const text = referenced({
      head: { ...head(), headers: [['Content-Type', 'text/plain']] },
      body: 'plain body text',
      workerFile: missingWorker,
    });

    await expect(evaluateResponseReference(json, 'response.body.*')).resolves.toStrictEqual({
      ok: true,
      text: '{"a":1,"b":[true,null]}',
    });
    await expect(evaluateResponseReference(text, 'response.body.*')).resolves.toStrictEqual({
      ok: true,
      text: 'plain body text',
    });
  });

  it('reads response.headers case-insensitively and joins repeats', async () => {
    const run = referenced({
      head: head([
        ['X-Request-Id', 'request-1'],
        ['Set-Cookie', 'a=1'],
        ['set-cookie', 'b=2'],
      ]),
      body: '{}',
      workerFile: missingWorker,
    });

    await expect(
      evaluateResponseReference(run, 'response.headers.x-request-id'),
    ).resolves.toStrictEqual({ ok: true, text: 'request-1' });
    await expect(
      evaluateResponseReference(run, 'response.headers.SET-COOKIE'),
    ).resolves.toStrictEqual({ ok: true, text: 'a=1, b=2' });
    await expect(
      evaluateResponseReference(run, 'response.headers.X-Missing'),
    ).resolves.toStrictEqual({
      ok: false,
      reason: 'the headers have no value at ["x-missing"] ("x-missing" is missing)',
    });
  });

  it('waits for the referenced run to finish before reading its body, but not its headers', async () => {
    let finish = (): void => undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const run = referenced({
      head: head([['X-Request-Id', 'request-1']]),
      body: '{"token":"token-1"}',
      done,
      workerFile: missingWorker,
    });
    let settled = false;

    const body = evaluateResponseReference(run, 'response.body.*').then((result) => {
      settled = true;
      return result;
    });
    await expect(
      evaluateResponseReference(run, 'response.headers.X-Request-Id'),
    ).resolves.toStrictEqual({ ok: true, text: 'request-1' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    finish();

    await expect(body).resolves.toStrictEqual({ ok: true, text: '{"token":"token-1"}' });
  });

  it('a header reference waits for the run when the headers have not arrived', async () => {
    let finish = (): void => undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const live: { head: ResponseHead | undefined } = { head: undefined };
    const run: ReferencedRun = {
      ...referenced({ body: '{}', done, workerFile: missingWorker }),
      get head() {
        return live.head;
      },
    };

    const result = evaluateResponseReference(run, 'response.headers.X-Request-Id');
    live.head = head([['X-Request-Id', 'request-1']]);
    finish();

    await expect(result).resolves.toStrictEqual({ ok: true, text: 'request-1' });
  });

  it('rejects request.* and XPath with the decision 10 messages', async () => {
    const run = referenced({ body: '{}', workerFile: missingWorker });
    const requestMessage = (reference: string): string =>
      `Request references such as \`{{login.${reference}}}\` are not supported; use \`{{login.response.…}}\`.`;
    const xpath =
      'XPath is not supported in `{{login.response.body…}}`; use a JSONPath starting with `$`.';

    for (const reference of ['request.headers.X', 'request.body.*', 'request.body.$.token']) {
      await expect(evaluateResponseReference(run, reference)).resolves.toStrictEqual({
        ok: false,
        reason: requestMessage(reference),
      });
    }
    for (const reference of [
      'response.body',
      'response.body.',
      'response.body.//token',
      'response.body.token',
      'response.body.*.token',
    ]) {
      await expect(evaluateResponseReference(run, reference)).resolves.toStrictEqual({
        ok: false,
        reason: xpath,
      });
    }
  });

  it('rejects a header reference without a name and any other response reference', async () => {
    const run = referenced({ body: '{}', workerFile: missingWorker });

    for (const reference of ['response.headers', 'response.headers.']) {
      await expect(evaluateResponseReference(run, reference)).resolves.toStrictEqual({
        ok: false,
        reason:
          'A header reference needs a header name, such as `{{login.response.headers.Content-Type}}`.',
      });
    }
    await expect(evaluateResponseReference(run, 'response.status')).resolves.toStrictEqual({
      ok: false,
      reason:
        '`{{login.response.status}}` is not supported; use `{{login.response.body.*}}`, `{{login.response.body.$…}}` or `{{login.response.headers.<name>}}`.',
    });
  });

  it('returns the message of a JSONPath that fails the check', async () => {
    const run = referenced({ body: '{}', workerFile: missingWorker });

    await expect(evaluateResponseReference(run, 'response.body.$.a[')).resolves.toStrictEqual({
      ok: false,
      reason: 'The JSONPath ends unexpectedly.',
    });
    await expect(
      evaluateResponseReference(run, `response.body.$.${'a'.repeat(400)}`),
    ).resolves.toStrictEqual({ ok: false, reason: 'the query is longer than 384 characters' });
  });

  it('reads a body up to 1 MiB with readBody and a larger one from its file in the child', async () => {
    const reads: number[] = [];
    const small = referenced({ body: '{"token":"small"}', reads, workerFile: files().worker });
    await expect(evaluateResponseReference(small, 'response.body.$.token')).resolves.toStrictEqual({
      ok: true,
      text: 'small',
    });
    expect(reads).toStrictEqual([17]);

    const text = `{"token":"large","pad":"${'x'.repeat(mebibyte + 1_024)}"}`;
    const largeReads: number[] = [];
    const large = referenced({
      body: undefined,
      bodyLength: Buffer.byteLength(text),
      file: bodyFile('large.json', text),
      reads: largeReads,
      workerFile: files().worker,
    });

    await expect(evaluateResponseReference(large, 'response.body.$.token')).resolves.toStrictEqual({
      ok: true,
      text: 'large',
    });
    expect(largeReads).toStrictEqual([]);
  });

  it('falls back to the file when a small body cannot be read', async () => {
    const run = referenced({
      body: undefined,
      bodyLength: 17,
      file: bodyFile('small.json', '{"token":"saved"}'),
      workerFile: files().worker,
    });

    await expect(evaluateResponseReference(run, 'response.body.$.token')).resolves.toStrictEqual({
      ok: true,
      text: 'saved',
    });
  });

  it('fails when neither the body nor its file is available', async () => {
    const unavailable = { ok: false, reason: 'the body is no longer available' };

    await expect(
      evaluateResponseReference(
        referenced({ body: undefined, bodyLength: 17, workerFile: missingWorker }),
        'response.body.*',
      ),
    ).resolves.toStrictEqual(unavailable);
    await expect(
      evaluateResponseReference(
        referenced({ body: undefined, bodyLength: 2 * mebibyte, workerFile: missingWorker }),
        'response.body.$.token',
      ),
    ).resolves.toStrictEqual(unavailable);
  });

  it('fails a reference to a run that did not complete with its status', async () => {
    const reference = 'response.body.$.token';

    await expect(
      evaluateResponseReference(
        referenced({ status: 'cancelled', body: '{}', workerFile: missingWorker }),
        reference,
      ),
    ).resolves.toStrictEqual({
      ok: false,
      reason: 'login was cancelled before response.body.$.token resolved',
    });
    await expect(
      evaluateResponseReference(
        referenced({ status: 'failed', head: undefined, workerFile: missingWorker }),
        'response.headers.X-Request-Id',
      ),
    ).resolves.toStrictEqual({
      ok: false,
      reason: 'login failed before response.headers.X-Request-Id resolved',
    });
    await expect(
      evaluateResponseReference(
        referenced({ status: 'blocked', head: undefined, workerFile: missingWorker }),
        reference,
      ),
    ).resolves.toStrictEqual({ ok: false, reason: 'login was not sent' });
    await expect(
      evaluateResponseReference(
        referenced({
          status: 'failed',
          head: head([['X-Request-Id', 'request-1']]),
          workerFile: missingWorker,
        }),
        'response.headers.X-Request-Id',
      ),
    ).resolves.toStrictEqual({ ok: true, text: 'request-1' });
  });
});
