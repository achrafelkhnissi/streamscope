export declare function registryRequest(args: readonly string[]): {
  registry: 'marketplace' | 'open-vsx';
  version: string;
};

export declare function openVsxMetadataUrl(extensionId: string, version: string): string;

export declare function openVsxDownloadUrl(
  metadata: unknown,
  extensionId: string,
  version: string,
): string;
