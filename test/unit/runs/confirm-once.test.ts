import { describe, expect, it } from 'vitest';
import { confirmOnce } from '../../../src/runs/confirm-once';

describe('confirmOnce', () => {
  it('remembers yes and asks again after no', async () => {
    const answers = [false, true];
    let asked = 0;
    const confirm = confirmOnce(() => {
      asked += 1;
      return Promise.resolve(answers.shift() ?? false);
    });

    expect(await confirm()).toBe(false);
    expect(await confirm()).toBe(true);
    expect(await confirm()).toBe(true);
    expect(asked).toBe(2);
  });

  it('asks once for requests sent at the same time', async () => {
    let asked = 0;
    const confirm = confirmOnce(() => {
      asked += 1;
      return Promise.resolve(true);
    });

    expect(await Promise.all([confirm(), confirm()])).toEqual([true, true]);
    expect(asked).toBe(1);
  });
});
