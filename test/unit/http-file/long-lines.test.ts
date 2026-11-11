import { describe, expect, it } from 'vitest';
import { parseHttpFile } from '../../../src/http-file/parse';

const run = ' '.repeat(40000);
const budgetMs = 100;

function timed(text: string) {
  const started = performance.now();
  const file = parseHttpFile(text);
  return { file, elapsed: performance.now() - started };
}

describe('parseHttpFile on lines with long whitespace runs', () => {
  it('keeps directive arguments intact and parses quickly', () => {
    const { file, elapsed } = timed(`# @note a${run}b${run}\nGET https://api.example.test/a`);
    const note = file.requests[0]?.directives[0];

    expect(elapsed).toBeLessThan(budgetMs);
    expect(note?.argument).toBe(`a${run}b`);
    expect(note?.argumentRange.start.character).toBe(8);
    expect(note?.argumentRange.end.character).toBe(8 + run.length + 2);
  });

  it('accepts a directive keyword followed only by whitespace quickly', () => {
    const { file, elapsed } = timed(`# @insecure${run}\nGET https://api.example.test/a`);

    expect(elapsed).toBeLessThan(budgetMs);
    expect(file.requests[0]?.directives[0]).toMatchObject({ kind: 'insecure', argument: '' });
  });

  it('keeps file variable values intact and parses quickly', () => {
    const { file, elapsed } = timed(`@value = a${run}b${run}`);
    const variable = file.fileVariables[0];

    expect(elapsed).toBeLessThan(budgetMs);
    expect(variable?.value).toBe(`a${run}b`);
    expect(variable?.valueRange.start.character).toBe(9);
    expect(variable?.valueRange.end.character).toBe(9 + run.length + 2);
  });

  it('keeps an empty file variable value', () => {
    const { file } = timed(`@empty =${run}`);

    expect(file.fileVariables[0]).toMatchObject({ name: 'empty', value: '' });
  });

  it('keeps body file paths intact and parses quickly', () => {
    const { file, elapsed } = timed(`POST https://api.example.test/a\n\n< ./a${run}b.json${run}`);

    expect(elapsed).toBeLessThan(budgetMs);
    expect(file.requests[0]?.body[0]).toMatchObject({ kind: 'file', path: `./a${run}b.json` });
  });

  it('parses a request line with a long whitespace run quickly', () => {
    const { file, elapsed } = timed(`GET https://api.example.test/a${run}b`);

    expect(elapsed).toBeLessThan(budgetMs);
    expect(file.requests[0]?.requestLine.url).toBe(`https://api.example.test/a${run}b`);
    expect(file.requests[0]?.requestLine.httpVersion).toBeUndefined();
  });
});
