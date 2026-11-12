import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dotenvCandidates, parseDotenv } from '../../../src/environments/dotenv';

function parsed(...lines: string[]) {
  return Object.fromEntries(parseDotenv(lines.join('\n')));
}

const root = path.join(path.sep, 'w');

describe('parseDotenv', () => {
  it('parses KEY=value lines, export prefixes and comments', () => {
    expect(
      parsed(
        '# comment',
        'API_KEY=synthetic-key',
        'export HOST = api.example.test',
        '',
        '  PORT=8080',
      ),
    ).toEqual({ API_KEY: 'synthetic-key', HOST: 'api.example.test', PORT: '8080' });
  });

  it('keeps # inside quotes and strips it after unquoted values', () => {
    expect(parsed('A="x # y"', "B='x # y'", 'C=value # comment')).toEqual({
      A: 'x # y',
      B: 'x # y',
      C: 'value',
    });
  });

  it('unescapes \\n in double-quoted values and keeps single-quoted values literal', () => {
    expect(parsed(String.raw`D="line\nnext"`, String.raw`E='raw\n'`)).toEqual({
      D: 'line\nnext',
      E: String.raw`raw\n`,
    });
  });

  it('ignores lines without =', () => {
    expect(parsed('JUST_A_NAME', 'F=1')).toEqual({ F: '1' });
  });

  it('reads Windows line endings', () => {
    expect(Object.fromEntries(parseDotenv('A=1\r\nB=2\r\n'))).toEqual({ A: '1', B: '2' });
  });
});

describe('dotenvCandidates', () => {
  it('lists .env.<environment> before .env in each folder up to the root', () => {
    expect(dotenvCandidates(path.join(root, 'a', 'b'), root, 'dev')).toEqual([
      path.join(root, 'a', 'b', '.env.dev'),
      path.join(root, 'a', 'b', '.env'),
      path.join(root, 'a', '.env.dev'),
      path.join(root, 'a', '.env'),
      path.join(root, '.env.dev'),
      path.join(root, '.env'),
    ]);
  });

  it('stops at the containment root', () => {
    expect(dotenvCandidates(path.join(root, 'a', 'b'), path.join(root, 'a'), undefined)).toEqual([
      path.join(root, 'a', 'b', '.env'),
      path.join(root, 'a', '.env'),
    ]);
  });

  it('uses only the file folder when it is outside the root', () => {
    expect(dotenvCandidates(path.join(root, 'other'), path.join(root, 'a'), undefined)).toEqual([
      path.join(root, 'other', '.env'),
    ]);
  });

  it('skips environment names that are not plain file names', () => {
    expect(dotenvCandidates(root, root, '../dev')).toEqual([path.join(root, '.env')]);
  });
});
