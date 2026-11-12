import { describe, expect, it } from 'vitest';
import { parseSize } from '../../../src/runs/size';

describe('parseSize', () => {
  it('parses KiB, MiB and GiB into bytes', () => {
    expect(parseSize('512KiB')).toBe(524_288);
    expect(parseSize('16MiB')).toBe(16_777_216);
    expect(parseSize('2GiB')).toBe(2_147_483_648);
  });

  it('rejects other forms', () => {
    for (const text of ['16 MiB', '16mb', '16MB', '-1MiB', '1.5MiB', '16', 'MiB', ' 16MiB', '']) {
      expect(parseSize(text)).toBeUndefined();
    }
  });

  it('rejects sizes a number cannot hold exactly', () => {
    expect(parseSize('8388607GiB')).toBe(8_388_607 * 1024 ** 3);
    expect(parseSize('8388608GiB')).toBeUndefined();
  });
});
