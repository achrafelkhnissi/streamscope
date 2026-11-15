import { describe, expect, it } from 'vitest';
import {
  openVsxDownloadUrl,
  openVsxMetadataUrl,
  registryRequest,
} from '../../scripts/registry-source.mjs';

const id = 'achrafelkhnissi.streamscope';

describe('registryRequest', () => {
  it('reads the registry and version', () => {
    expect(registryRequest(['open-vsx', '0.1.0'])).toEqual({
      registry: 'open-vsx',
      version: '0.1.0',
    });
    expect(registryRequest(['marketplace', '0.2.0'])).toEqual({
      registry: 'marketplace',
      version: '0.2.0',
    });
  });

  it('refuses other registries, missing arguments and partial versions', () => {
    const usage = 'Usage: npm run verify:registry -- marketplace|open-vsx <version>';
    expect(() => registryRequest([])).toThrow(usage);
    expect(() => registryRequest(['npm', '0.1.0'])).toThrow(usage);
    expect(() => registryRequest(['marketplace', '0.1'])).toThrow(
      '"0.1" is not a major.minor.patch version.',
    );
  });
});

describe('Open VSX URLs', () => {
  it('builds the Open VSX metadata URL', () => {
    expect(openVsxMetadataUrl(id, '0.1.0')).toBe(
      'https://open-vsx.org/api/achrafelkhnissi/streamscope/0.1.0',
    );
  });

  it('takes the download URL from metadata for the same version', () => {
    const download =
      'https://open-vsx.org/api/achrafelkhnissi/streamscope/0.1.0/file/achrafelkhnissi.streamscope-0.1.0.vsix';
    expect(openVsxDownloadUrl({ version: '0.1.0', files: { download } }, id, '0.1.0')).toBe(
      download,
    );
  });

  it('refuses metadata for another version or without a download', () => {
    const missing = 'Open VSX has no 0.1.0 of achrafelkhnissi.streamscope.';
    expect(() => openVsxDownloadUrl({ error: 'Extension not found' }, id, '0.1.0')).toThrow(
      missing,
    );
    expect(() =>
      openVsxDownloadUrl(
        { version: '0.2.0', files: { download: 'https://open-vsx.org/x.vsix' } },
        id,
        '0.1.0',
      ),
    ).toThrow(missing);
    expect(() => openVsxDownloadUrl({ version: '0.1.0', files: {} }, id, '0.1.0')).toThrow(missing);
  });

  it('refuses a download URL off open-vsx.org or over http', () => {
    for (const download of [
      'http://open-vsx.org/x.vsix',
      'https://open-vsx.example.test/x.vsix',
      'not a url',
    ]) {
      expect(() =>
        openVsxDownloadUrl({ version: '0.1.0', files: { download } }, id, '0.1.0'),
      ).toThrow(`Open VSX gave an unexpected download URL: ${download}`);
    }
  });
});
