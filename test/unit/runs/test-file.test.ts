import { describe, expect, it } from 'vitest';
import { isTestedUri, maxTestFileBytes, testFileProblem } from '../../../src/runs/test-file';

describe('testFileProblem', () => {
  const plain = { symbolicLink: false, file: true, size: 120 };

  it('accepts a regular file up to 1 MiB', () => {
    expect(maxTestFileBytes).toBe(1_048_576);
    expect(testFileProblem(plain)).toBeUndefined();
    expect(testFileProblem({ ...plain, size: maxTestFileBytes })).toBeUndefined();
  });

  it('refuses symbolic links, non-files and oversize files', () => {
    expect(testFileProblem({ ...plain, symbolicLink: true })).toBe(
      'Streamscope does not read linked files.',
    );
    expect(testFileProblem({ ...plain, file: false })).toBe('This is not a file.');
    expect(testFileProblem({ ...plain, size: maxTestFileBytes + 1 })).toBe(
      'This file is larger than 1 MiB, so Streamscope does not list its requests.',
    );
  });
});

describe('isTestedUri', () => {
  it('accepts only local and untitled documents', () => {
    expect(isTestedUri({ scheme: 'file' })).toBe(true);
    expect(isTestedUri({ scheme: 'untitled' })).toBe(true);
    for (const scheme of ['vscode-vfs', 'vscode-remote', 'git', 'streamscope-test']) {
      expect(isTestedUri({ scheme })).toBe(false);
    }
  });
});
