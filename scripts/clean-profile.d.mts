export declare function installedVersionProblem(
  listOutput: string,
  extensionId: string,
  version: string,
): string | undefined;

export declare function verifyInCleanProfile(options: {
  root: string;
  install: readonly string[];
  extensionId: string;
  version: string;
}): Promise<void>;
