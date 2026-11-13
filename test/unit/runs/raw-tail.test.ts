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

  it('cuts at the half point when the next line start is far past it', () => {
    const tail = new RawTail(100);

    tail.push(encoder.encode(`${'x'.repeat(98)}\n`));
    tail.push(encoder.encode('ab'));

    expect(tail.text).toBe(`${'x'.repeat(47)}\nab`);
    expect(tail.generation).toBe(1);
  });

  it('cuts at the half point at full size when the next line start is more than 64 KiB past it', () => {
    const limit = 2_097_152;
    const tail = new RawTail(limit);

    tail.push(encoder.encode(`${'x'.repeat(limit - 2)}\n`));
    tail.push(encoder.encode('ab'));

    expect(tail.text).toHaveLength(limit / 2);
    expect(tail.text.endsWith('x\nab')).toBe(true);
  });

  it('starts at a line within 65,536 characters of the half point at full size', () => {
    const limit = 2_097_152;
    const length = limit + 1;
    const half = length - limit / 2;
    const near = new RawTail(limit);
    const far = new RawTail(limit);

    for (const [tail, newline] of [
      [near, half - 1 + 65_536],
      [far, half - 1 + 65_537],
    ] as const) {
      tail.push(encoder.encode(`${'x'.repeat(newline)}\n${'y'.repeat(length - newline - 1)}`));
    }

    expect(near.text).toBe('y'.repeat(length - (half + 65_536)));
    expect(far.text).toHaveLength(limit / 2);
  });

  it('keeps at least a quarter of the limit after a trim of long lines, and never twice the limit', () => {
    const limit = 256;
    const tail = new RawTail(limit);
    const random = seeded(11);

    for (let push = 0; push < 2000; push += 1) {
      const length = Math.floor(random() * 3 * limit);
      const text = Array.from({ length }, () => (random() < 0.005 ? '\n' : 'x')).join('');
      const before = tail.generation;
      tail.push(encoder.encode(text));

      expect(tail.text.length).toBeLessThanOrEqual(2 * limit);
      if (tail.generation !== before) {
        expect(tail.text.length).toBeGreaterThanOrEqual(limit / 4);
      }
    }
    expect(tail.generation).toBeGreaterThan(100);
  });

  it('decodes multi-byte UTF-8 split at every pair of byte boundaries', () => {
    const text = 'a\né\n€x🙂\nok ünïcödé 𝄞';
    const bytes = encoder.encode(text);

    for (let first = 0; first <= bytes.length; first += 1) {
      for (let second = first; second <= bytes.length; second += 1) {
        const tail = new RawTail(1024);
        tail.push(bytes.subarray(0, first));
        tail.push(bytes.subarray(first, second));
        tail.push(bytes.subarray(second));
        tail.end();

        expect(tail.text).toBe(text);
        expect(tail.total).toBe(text.length);
      }
    }
  });

  it('gives the text appended since an offset while it still holds it', () => {
    const tail = new RawTail(64);

    tail.push(encoder.encode('first\n'));
    const mark = tail.total;
    tail.push(encoder.encode('second\n'));
    tail.push(encoder.encode('thi'));
    tail.push(encoder.encode('rd'));

    expect(mark).toBe(6);
    expect(tail.total).toBe(18);
    expect(tail.since(mark)).toBe('second\nthird');
    expect(tail.since(mark + 3)).toBe('ond\nthird');
    expect(tail.since(0)).toBe(tail.text);
    expect(tail.since(tail.total)).toBe('');
  });

  it('gives nothing for an offset the tail no longer holds', () => {
    const tail = new RawTail(16);

    for (let line = 0; line < 5; line += 1) {
      tail.push(encoder.encode('aaaa\n'));
    }

    expect(tail.total).toBe(25);
    expect(tail.trimmed).toBe(true);
    expect(tail.since(0)).toBeUndefined();
    expect(tail.since(tail.total - tail.text.length)).toBe(tail.text);
    expect(tail.since(tail.total - tail.text.length - 1)).toBeUndefined();
  });

  it('counts the total in characters across a character split between chunks', () => {
    const tail = new RawTail(64);
    const emoji = encoder.encode('🙂');

    tail.push(emoji.subarray(0, 2));
    const mark = tail.total;
    tail.push(emoji.subarray(2));
    tail.push(encoder.encode('x'));

    expect(mark).toBe(0);
    expect(tail.since(mark)).toBe('🙂x');
    expect(tail.total).toBe(3);
  });

  it('frees the text it holds on release and keeps counting what was appended', () => {
    const tail = new RawTail(64);
    tail.push(encoder.encode('first line\n'));
    tail.push(encoder.encode('second line\n'));
    const total = tail.total;

    tail.release();

    expect(tail.text).toBe('');
    expect(tail.total).toBe(total);
    expect(tail.since(0)).toBeUndefined();
    expect(tail.since(total)).toBe('');
  });

  it('holds new text again after a release', () => {
    const tail = new RawTail(64);
    tail.push(encoder.encode('first\n'));
    tail.release();

    tail.push(encoder.encode('next\n'));

    expect(tail.text).toBe('next\n');
    expect(tail.total).toBe(11);
    expect(tail.since(6)).toBe('next\n');
    expect(tail.since(0)).toBeUndefined();
  });
});
