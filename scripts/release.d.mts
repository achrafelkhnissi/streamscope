export interface ReleaseInput {
  event: string;
  refName: string;
  input: string;
  manifestVersion: string;
}

export declare function releaseVersion(input: ReleaseInput): {
  version: string;
  preRelease: boolean;
};

export declare function changelogSection(changelog: string, version: string): string;
