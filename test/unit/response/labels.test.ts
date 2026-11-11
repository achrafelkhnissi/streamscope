import { describe, expect, it } from 'vitest';
import { parseHttpFile } from '../../../src/http-file/parse';
import {
  bodyExtension,
  describeOutcome,
  fileSafeName,
  formatBytes,
  formatDuration,
  requestLabel,
  saveExtension,
} from '../../../src/response/labels';
import { snapshot } from './fixtures';

function requests(...lines: string[]) {
  return parseHttpFile(lines.join('\n')).requests;
}

describe('labels', () => {
  it('labels a request by name, then title, then method and url', () => {
    const [named, titled, plain] = requests(
      '# @name login',
      'POST https://api.example.test/login',
      '',
      '### List items',
      'GET https://api.example.test/items',
      '',
      '###',
      'delete https://api.example.test/items/1',
    );

    expect(named && requestLabel(named)).toBe('login');
    expect(titled && requestLabel(titled)).toBe('List items');
    expect(plain && requestLabel(plain)).toBe('DELETE https://api.example.test/items/1');
  });

  it('masks user info in labels', () => {
    const [request] = requests('GET https://admin:synthetic@api.example.test/x');

    expect(request && requestLabel(request)).toBe('GET https://••••••@api.example.test/x');
  });

  it('makes labels safe for file names', () => {
    expect(fileSafeName('GET https://api.example.test/a?b="c"|d*\u0001')).toBe(
      'GET https___api.example.test_a_b=_c__d__',
    );
    expect(fileSafeName('x'.repeat(80))).toBe('x'.repeat(60));
  });

  it('maps body languages to extensions', () => {
    expect(
      (['json', 'xml', 'html', 'javascript', 'css', 'plaintext'] as const).map(bodyExtension),
    ).toEqual(['.json', '.xml', '.html', '.js', '.css', '.txt']);
  });

  it('picks a save extension from the content type', () => {
    expect(saveExtension('application/json; charset=utf-8')).toBe('.json');
    expect(saveExtension('application/problem+json')).toBe('.json');
    expect(saveExtension('image/png')).toBe('.png');
    expect(saveExtension('text/csv')).toBe('.csv');
    expect(saveExtension('application/x-unknown')).toBe('.bin');
    expect(saveExtension(undefined)).toBe('.bin');
  });

  it('formats sizes 1024-based', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1229)).toBe('1.2 KB');
    expect(formatBytes(3_565_158)).toBe('3.4 MB');
  });

  it('formats durations', () => {
    expect(formatDuration(120)).toBe('120 ms');
    expect(formatDuration(12.6)).toBe('13 ms');
    expect(formatDuration(2100)).toBe('2.1 s');
  });

  it('describes each outcome', () => {
    expect(describeOutcome(snapshot())).toBe('200 OK · 1.2 KB · 120 ms');
    expect(
      describeOutcome(
        snapshot({
          status: 'failed',
          head: undefined,
          failure: { kind: 'refused', message: 'Connection refused.' },
        }),
      ),
    ).toBe('Failed: Connection refused.');
    expect(describeOutcome(snapshot({ status: 'cancelled', elapsedMs: 2100 }))).toBe(
      'Cancelled after 2.1 s',
    );
    expect(
      describeOutcome(
        snapshot({
          status: 'blocked',
          problems: [
            {
              message: '`{{host}}` is not defined.',
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
            },
          ],
        }),
      ),
    ).toBe('Not sent: `{{host}}` is not defined.');
    expect(describeOutcome(snapshot({ status: 'receiving', elapsedMs: 2100 }))).toBe(
      'Running · 2.1 s',
    );
  });
});
