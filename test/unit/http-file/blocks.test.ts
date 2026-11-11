import { describe, expect, it } from 'vitest';
import { parseHttpFile } from '../../../src/http-file/parse';

function lines(...content: string[]): string {
  return content.join('\n');
}

function at(line: number, start: number, end: number) {
  return { start: { line, character: start }, end: { line, character: end } };
}

describe('parseHttpFile blocks', () => {
  it('splits requests on ### lines and keeps the separator title', () => {
    const file = parseHttpFile(
      lines(
        'GET https://api.example.test/items',
        '',
        '### Create user',
        'POST https://api.example.test/users',
      ),
    );

    expect(file.requests).toHaveLength(2);
    expect(file.requests[0]?.title).toBeUndefined();
    expect(file.requests[1]?.title).toBe('Create user');
    expect(file.requests[0]?.range.start.line).toBe(0);
    expect(file.requests[1]?.range.start.line).toBe(2);
  });

  it('treats ### inside a body as a separator, like REST Client', () => {
    const file = parseHttpFile(
      lines(
        'POST https://api.example.test/notes',
        'Content-Type: text/plain',
        '',
        'Intro line',
        '### not a heading',
        'more text',
      ),
    );

    expect(file.requests).toHaveLength(2);
    expect(file.requests[1]?.title).toBe('not a heading');
  });

  it('ignores blocks without a request line', () => {
    const file = parseHttpFile(
      lines('# Shared settings', '@baseUrl = http://localhost:8080', '', '###', '// nothing here'),
    );

    expect(file.requests).toHaveLength(0);
    expect(file.fileVariables).toHaveLength(1);
    expect(file.fileVariables[0]).toMatchObject({
      name: 'baseUrl',
      value: 'http://localhost:8080',
    });
  });

  it('collects file variables from any line', () => {
    const file = parseHttpFile(
      lines(
        '@a = 1',
        '',
        'GET https://api.example.test/a',
        '',
        '###',
        '@b = two words',
        'GET https://api.example.test/b',
      ),
    );

    expect(file.fileVariables).toEqual([
      expect.objectContaining({
        name: 'a',
        value: '1',
        nameRange: at(0, 1, 2),
        valueRange: at(0, 5, 6),
      }),
      expect.objectContaining({
        name: 'b',
        value: 'two words',
        nameRange: at(5, 1, 2),
        valueRange: at(5, 5, 14),
      }),
    ]);
    expect(file.requests).toHaveLength(2);
  });

  it('reads directives only before the request line', () => {
    const file = parseHttpFile(
      lines(
        '# @name createUser',
        '// @capture userId = body.id',
        '# @expect status == 201',
        'POST https://api.example.test/users',
        '# @expect status == 500',
      ),
    );
    const request = file.requests[0];

    expect(request?.name).toBe('createUser');
    expect(request?.directives).toEqual([
      expect.objectContaining({
        kind: 'name',
        argument: 'createUser',
        argumentRange: at(0, 8, 18),
      }),
      expect.objectContaining({
        kind: 'capture',
        argument: 'userId = body.id',
        argumentRange: at(1, 12, 28),
      }),
      expect.objectContaining({
        kind: 'expect',
        argument: 'status == 201',
        argumentRange: at(2, 10, 23),
      }),
    ]);
  });

  it('treats unknown @ words as comments', () => {
    const file = parseHttpFile(lines('# @ref other', 'GET https://api.example.test/a'));

    expect(file.requests[0]?.directives).toEqual([]);
  });

  it('handles CRLF without leaking \\r into ranges', () => {
    const content = [
      '@baseUrl = https://api.example.test',
      '',
      '# @name createUser',
      '// @capture userId = body.id',
      'POST {{baseUrl}}/users',
      '',
      '### Second',
      'GET {{baseUrl}}/users',
    ];

    expect(parseHttpFile(content.join('\r\n'))).toEqual(parseHttpFile(content.join('\n')));
  });
});
