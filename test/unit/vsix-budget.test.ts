import { describe, expect, it } from 'vitest';
import { maxVsixBytes, vsixBudgetProblem } from '../../scripts/vsix-budget.mjs';

describe('VSIX size budget', () => {
  it('accepts a VSIX up to 400 KB', () => {
    expect(maxVsixBytes).toBe(409_600);
    expect(vsixBudgetProblem(409_600)).toBeUndefined();
    expect(vsixBudgetProblem(199_543)).toBeUndefined();
  });

  it('rejects a larger VSIX with its size', () => {
    expect(vsixBudgetProblem(409_601)).toBe('The VSIX is 400.0 KB, over the 400 KB budget.');
    expect(vsixBudgetProblem(524_288)).toBe('The VSIX is 512.0 KB, over the 400 KB budget.');
  });
});
