import { describe, expect, it } from 'vitest';
import { capturedNames, placeCapture } from '../../../src/http-file/capture-placement';
import type { HttpRequest } from '../../../src/http-file/model';
import { parseHttpFile } from '../../../src/http-file/parse';
import { findRequest, requestKey } from '../../../src/runs/run';

const uri = 'file:///workspace/agent.http';

function request(lines: readonly string[], index = 0): HttpRequest {
  const found = parseHttpFile(lines.join('\n')).requests[index];
  if (found === undefined) {
    throw new Error(`no request ${String(index)}`);
  }
  return found;
}

function placed(
  lines: readonly string[],
  input: { name: string; secret?: boolean; expression?: string },
  index = 0,
): string[] {
  const result = placeCapture({
    request: request(lines, index),
    lines,
    name: input.name,
    secret: input.secret ?? false,
    expression: input.expression ?? 'first().id',
  });
  if (!result.ok) {
    throw new Error(result.message);
  }
  return [...lines.slice(0, result.line), result.text, ...lines.slice(result.line)];
}

const twoRequests = [
  '### Start',
  '# @name startRun',
  '# @capture threadId = first(type == "RUN_STARTED").threadId',
  '# @capture runId = first().runId',
  'POST https://example.test/run',
  'Content-Type: application/json',
  '',
  '{"message": "hello"}',
  '',
  '### Continue',
  '# @name continueRun',
  'POST https://example.test/continue',
];

describe('placeCapture', () => {
  it('puts the line after the last capture', () => {
    const result = placed(twoRequests, { name: 'messageId', expression: 'last().messageId' });
    const file = parseHttpFile(result.join('\n'));

    expect(result[4]).toBe('# @capture messageId = last().messageId');
    expect(file.diagnostics).toEqual([]);
    expect(file.requests[0]?.captures.map(({ name }) => name)).toEqual([
      'threadId',
      'runId',
      'messageId',
    ]);
    expect(file.requests[1]?.captures).toEqual([]);
  });

  it('puts the line directly above the request line when there is no capture', () => {
    const lines = [
      '### Start',
      '# @name startRun',
      '# a plain comment',
      'POST https://example.test/run',
    ];
    const result = placed(lines, { name: 'threadId' });
    const file = parseHttpFile(result.join('\n'));

    expect(result).toEqual([
      '### Start',
      '# @name startRun',
      '# a plain comment',
      '# @capture threadId = first().id',
      'POST https://example.test/run',
    ]);
    expect(file.diagnostics).toEqual([]);
    expect(file.requests[0]?.captures.map(({ name }) => name)).toEqual(['threadId']);

    const continued = placed(twoRequests, { name: 'reply' }, 1);
    expect(continued.slice(10, 13)).toEqual([
      '# @name continueRun',
      '# @capture reply = first().id',
      'POST https://example.test/continue',
    ]);
    expect(
      parseHttpFile(continued.join('\n')).requests[1]?.captures.map(({ name }) => name),
    ).toEqual(['reply']);
  });

  it("uses the comment marker of the request's directives", () => {
    const slashes = ['// @name startRun', 'GET https://example.test/a'];
    expect(placed(slashes, { name: 'a' })[1]).toBe('// @capture a = first().id');
    const mixed = ['# @name startRun', '// @capture a = first().a', 'GET https://example.test/a'];
    expect(placed(mixed, { name: 'b' })[2]).toBe('// @capture b = first().id');
    const bare = ['GET https://example.test/a'];
    const result = placed(bare, { name: 'a' });
    expect(result[0]).toBe('# @capture a = first().id');
    expect(parseHttpFile(result.join('\n')).requests[0]?.captures.map(({ name }) => name)).toEqual([
      'a',
    ]);
  });

  it('refuses a name the request already captures', () => {
    const target = request(twoRequests);
    expect(capturedNames(target)).toEqual(new Set(['threadId', 'runId']));
    expect(
      placeCapture({
        request: target,
        lines: twoRequests,
        name: 'threadId',
        secret: false,
        expression: 'first().x',
      }),
    ).toEqual({ ok: false, message: 'This request already captures threadId.' });
  });

  it('refuses a 65th capture', () => {
    const lines = [
      ...Array.from({ length: 64 }, (_, at) => `# @capture c${String(at)} = first().c`),
      'GET https://example.test/a',
    ];
    expect(
      placeCapture({
        request: request(lines),
        lines,
        name: 'another',
        secret: false,
        expression: 'first().x',
      }),
    ).toEqual({
      ok: false,
      message: 'This request already has 64 captures, the most a request can have.',
    });
    const invalid = [
      ...Array.from({ length: 63 }, (_, at) => `# @capture c${String(at)} = first().c`),
      '# @capture not valid',
      'GET https://example.test/a',
    ];
    expect(
      placeCapture({
        request: request(invalid),
        lines: invalid,
        name: 'another',
        secret: false,
        expression: 'first().x',
      }),
    ).toEqual({
      ok: false,
      message: 'This request already has 64 captures, the most a request can have.',
    });
  });

  it('writes secret when asked', () => {
    const result = placed(twoRequests, { name: 'token', secret: true, expression: 'body.token' });
    expect(result[4]).toBe('# @capture secret token = body.token');
    expect(parseHttpFile(result.join('\n')).requests[0]?.captures.at(-1)?.secret).toBe(true);
  });

  it('places on the right request after the file changed', () => {
    const key = requestKey(uri, request(twoRequests, 1), 1);
    const changed = [
      '### Inserted',
      'GET https://example.test/inserted',
      '',
      ...twoRequests.map((line) => (line === '# @name startRun' ? '# @name beginRun' : line)),
    ];
    changed.splice(changed.indexOf('# @name continueRun') + 1, 0, '# @capture first = first().a');
    const file = parseHttpFile(changed.join('\n'));
    const target = findRequest(uri, file, key);
    expect(target?.name).toBe('continueRun');
    if (target === undefined) {
      return;
    }
    const result = placeCapture({
      request: target,
      lines: changed,
      name: 'second',
      secret: false,
      expression: 'first().b',
    });
    expect(result).toEqual({
      ok: true,
      line: changed.indexOf('# @capture first = first().a') + 1,
      text: '# @capture second = first().b',
    });

    const unnamed = changed.filter((line) => line !== '# @name continueRun');
    expect(findRequest(uri, parseHttpFile(unnamed.join('\n')), key)).toBeUndefined();
  });
});
