import { describe, expect, it } from 'vitest';
import { reindentJson } from '../../../src/response/reindent-json';

describe('reindentJson', () => {
  it('indents nested objects and arrays', () => {
    expect(reindentJson('{"a":1,"b":[true,null,{"c":"d"}],"e":{"f":-2.5}}')).toBe(
      [
        '{',
        '  "a": 1,',
        '  "b": [',
        '    true,',
        '    null,',
        '    {',
        '      "c": "d"',
        '    }',
        '  ],',
        '  "e": {',
        '    "f": -2.5',
        '  }',
        '}',
      ].join('\n'),
    );
  });

  it('drops whitespace outside strings', () => {
    expect(reindentJson(' \n{ "a" :\t[ 1 , 2 ] }\r\n')).toBe(
      ['{', '  "a": [', '    1,', '    2', '  ]', '}'].join('\n'),
    );
  });

  it('keeps empty objects and arrays inline', () => {
    expect(reindentJson('{"a":{},"b":[ ],"c":[{ }]}')).toBe(
      ['{', '  "a": {},', '  "b": [],', '  "c": [', '    {}', '  ]', '}'].join('\n'),
    );
  });

  it('copies strings with braces, commas, quotes and backslashes unchanged', () => {
    const text = String.raw`{"s":"{[,:]} \" \\ é \n"}`;

    expect(reindentJson(text)).toBe(['{', String.raw`  "s": "{[,:]} \" \\ é \n"`, '}'].join('\n'));
  });

  it('keeps numbers digit for digit', () => {
    expect(reindentJson('[12345678901234567890,1.0,1e400,-0,2E-3]')).toBe(
      ['[', '  12345678901234567890,', '  1.0,', '  1e400,', '  -0,', '  2E-3', ']'].join('\n'),
    );
  });

  it('keeps duplicate keys', () => {
    expect(reindentJson('{"a":1,"a":2}')).toBe(['{', '  "a": 1,', '  "a": 2', '}'].join('\n'));
  });

  it('leaves scalars as they are', () => {
    expect(reindentJson(' "text" ')).toBe('"text"');
    expect(reindentJson('42')).toBe('42');
  });
});
