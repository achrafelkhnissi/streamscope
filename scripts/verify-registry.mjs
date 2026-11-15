import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyInCleanProfile } from './clean-profile.mjs';
import { openVsxDownloadUrl, openVsxMetadataUrl, registryRequest } from './registry-source.mjs';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const extensionId = `${manifest.publisher}.${manifest.name}`;
const { registry, version } = registryRequest(process.argv.slice(2));

async function openVsxMetadata() {
  const url = openVsxMetadataUrl(extensionId, version);
  const response = await fetch(url);
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`Open VSX answered ${String(response.status)} for ${url}`);
  }
  return response.json();
}

if (registry === 'marketplace') {
  await verifyInCleanProfile({
    root,
    install: [`${extensionId}@${version}`],
    extensionId,
    version,
  });
} else {
  const download = openVsxDownloadUrl(await openVsxMetadata(), extensionId, version);
  const response = await fetch(download);
  if (!response.ok) {
    throw new Error(`Open VSX answered ${String(response.status)} for ${download}`);
  }
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'ssr-')));
  try {
    const vsix = path.join(directory, `${extensionId}-${version}.vsix`);
    writeFileSync(vsix, Buffer.from(await response.arrayBuffer()));
    console.log(`Downloaded ${download}`);
    await verifyInCleanProfile({ root, install: [vsix], extensionId, version });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
