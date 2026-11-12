import { describe, expect, it } from 'vitest';
import { RawTail } from '../../../src/runs/raw-tail';

const encoder = new TextEncoder();

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

describe('RawTail', () => {
  it('keeps text below the limit whole', () => {
    const tail = new RawTail(64);

    tail.push(encoder.encode('first line\n'));
    tail.push(encoder.encode('second line'));

    expect(tail.text).toBe('first line\nsecond line');
    expect(tail.generation).toBe(0);
    expect(tail.trimmed).toBe(false);
  });

  it('keeps the newest half from a line start once over the limit and counts generations', () => {
    const tail = new RawTail(64);
    const lines = Array.from(
      { length: 10 },
      (_, index) => `line-${String(index).padStart(4, '0')}\n`,
    );
    const full = lines.join('');

    for (const line of lines) {
      tail.push(encoder.encode(line));
    }

    expect(full).toHaveLength(100);
    expect(tail.text.length).toBeGreaterThan(0);
    expect(tail.text.length).toBeLessThanOrEqual(64);
    expect(full.endsWith(tail.text)).toBe(true);
    expect(full[full.length - tail.text.length - 1]).toBe('\n');
    expect(tail.generation).toBe(1);
    expect(tail.trimmed).toBe(true);
  });

  it('decodes a character split across chunks', () => {
    const tail = new RawTail(64);
    const emoji = encoder.encode('🙂');

    tail.push(Uint8Array.of(0x61, 0xc3));
    tail.push(Uint8Array.of(0xa9, 0x62));
    tail.push(emoji.subarray(0, 1));
    tail.push(emoji.subarray(1, 3));
    tail.push(emoji.subarray(3));
    tail.push(Uint8Array.of(0xc3));
    tail.end();

    expect(tail.text).toBe('aéb🙂�');
  });

  it('never holds more than twice the limit', () => {
    const limit = 64;
    const tail = new RawTail(limit);
    const random = seeded(7);

    for (let push = 0; push < 1000; push += 1) {
      const length = Math.floor(random() * 3 * limit);
      const text = Array.from({ length }, () => (random() < 0.05 ? '\n' : 'x')).join('');
      tail.push(encoder.encode(text));

      expect(tail.text.length).toBeLessThanOrEqual(2 * limit);
    }
    expect(tail.generation).toBeGreaterThan(100);
  });
});
