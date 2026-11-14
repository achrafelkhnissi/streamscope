import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const plainVersion = /^\d+\.\d+\.\d+$/;
const linkDefinition = /^\[[^\]]+\]: /;

export function releaseVersion({ event, refName, input, manifestVersion }) {
  const version = event === 'push' ? refName.replace(/^v/, '') : input.trim();
  if (!plainVersion.test(version)) {
    throw new Error(`"${version}" is not a major.minor.patch version.`);
  }
  if (version !== manifestVersion) {
    throw new Error(`The release is ${version} but package.json says ${manifestVersion}.`);
  }
  return { version, preRelease: Number(version.split('.')[1]) % 2 === 1 };
}

export function changelogSection(changelog, version) {
  const lines = changelog.split('\n');
  const heading = `## [${version}]`;
  const start = lines.findIndex((line) => line === heading || line.startsWith(`${heading} `));
  if (start === -1) {
    throw new Error(`CHANGELOG.md has no section for ${version}.`);
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## ') || linkDefinition.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}

function main([command, ...args]) {
  const root = path.resolve(import.meta.dirname, '..');
  if (command === 'version') {
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const { version, preRelease } = releaseVersion({
      event: process.env.RELEASE_EVENT ?? '',
      refName: process.env.RELEASE_REF ?? '',
      input: process.env.RELEASE_INPUT ?? '',
      manifestVersion: manifest.version,
    });
    const flag = preRelease ? '--pre-release' : '';
    appendFileSync(
      process.env.GITHUB_OUTPUT ?? '/dev/stdout',
      `version=${version}\npre-release=${flag}\n`,
    );
    console.log(`Releasing ${version}${preRelease ? ' as a pre-release' : ''}.`);
    return;
  }
  if (command === 'notes') {
    const [version, file] = args;
    const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    writeFileSync(file, `${changelogSection(changelog, version)}\n`);
    return;
  }
  throw new Error('Usage: node scripts/release.mjs version | notes <version> <file>');
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main(process.argv.slice(2));
}
