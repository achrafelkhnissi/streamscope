import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

export function copyExtension(source: string, destination: string): void {
  const manifestPath = path.join(source, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files?: unknown };
  const files = manifest.files;
  if (!Array.isArray(files) || !files.every((file): file is string => typeof file === 'string')) {
    throw new Error(`${manifestPath} has no "files" list to copy.`);
  }
  for (const entry of ['package.json', ...files]) {
    const target = path.join(destination, entry);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(source, entry), target, { recursive: true });
  }
}
