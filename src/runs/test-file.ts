export const maxTestFileBytes = 1_048_576;

export interface TestFileStat {
  symbolicLink: boolean;
  file: boolean;
  size: number;
}

const testedSchemes: ReadonlySet<string> = new Set(['file', 'untitled']);

export function isTestedUri(uri: { scheme: string }): boolean {
  return testedSchemes.has(uri.scheme);
}

export function testFileProblem(stat: TestFileStat): string | undefined {
  if (stat.symbolicLink) {
    return 'Streamscope does not read linked files.';
  }
  if (!stat.file) {
    return 'This is not a file.';
  }
  if (stat.size > maxTestFileBytes) {
    return 'This file is larger than 1 MiB, so Streamscope does not list its requests.';
  }
  return undefined;
}
