const plainVersion = /^\d+\.\d+\.\d+$/;
const registries = new Set(['marketplace', 'open-vsx']);
const usage = 'Usage: npm run verify:registry -- marketplace|open-vsx <version>';

export function registryRequest(args) {
  const [registry, version] = args;
  if (args.length !== 2 || !registries.has(registry)) {
    throw new Error(usage);
  }
  if (!plainVersion.test(version)) {
    throw new Error(`"${version}" is not a major.minor.patch version.`);
  }
  return { registry, version };
}

export function openVsxMetadataUrl(extensionId, version) {
  const [namespace, name] = extensionId.split('.');
  return `https://open-vsx.org/api/${namespace}/${name}/${version}`;
}

export function openVsxDownloadUrl(metadata, extensionId, version) {
  const download = metadata?.version === version ? metadata.files?.download : undefined;
  if (typeof download !== 'string') {
    throw new Error(`Open VSX has no ${version} of ${extensionId}.`);
  }
  const url = URL.canParse(download) ? new URL(download) : undefined;
  if (url?.protocol !== 'https:' || url.hostname !== 'open-vsx.org') {
    throw new Error(`Open VSX gave an unexpected download URL: ${download}`);
  }
  return download;
}
