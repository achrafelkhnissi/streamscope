import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from '@vscode/test-electron';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const extensionId = `${manifest.publisher}.${manifest.name}`;
const vsix = path.join(root, `${manifest.name}-${manifest.version}.vsix`);
const maxVsixBytes = 409600;

const vsixBytes = statSync(vsix).size;
console.log(`VSIX is ${String(vsixBytes)} bytes (limit ${String(maxVsixBytes)})`);
if (vsixBytes > maxVsixBytes) {
  throw new Error(
    `VSIX is ${String(vsixBytes)} bytes, over the ${String(maxVsixBytes)}-byte limit`,
  );
}

const sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), 'vsix-verify-')));
const userDataDir = path.join(sandbox, 'user-data');
const extensionsDir = path.join(sandbox, 'extensions');
mkdirSync(path.join(userDataDir, 'User'), { recursive: true });
mkdirSync(extensionsDir);
writeFileSync(
  path.join(userDataDir, 'User', 'settings.json'),
  JSON.stringify({ 'files.simpleDialog.enable': true }),
);

try {
  const vscodeExecutablePath = await downloadAndUnzipVSCode('stable');
  const [cli] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath, {
    reuseMachineInstall: true,
  });
  const profileArgs = [`--user-data-dir=${userDataDir}`, `--extensions-dir=${extensionsDir}`];

  const install = spawnSync(cli, [...profileArgs, '--install-extension', vsix], {
    encoding: 'utf8',
  });
  process.stdout.write(install.stdout);
  process.stderr.write(install.stderr);
  if (install.status !== 0) {
    throw new Error(`Installing ${vsix} failed with exit code ${String(install.status)}`);
  }

  const listed = spawnSync(cli, [...profileArgs, '--list-extensions', '--show-versions'], {
    encoding: 'utf8',
  });
  const expected = `${extensionId}@${manifest.version}`;
  if (!listed.stdout.split('\n').includes(expected)) {
    throw new Error(`Expected ${expected} in the isolated profile, found:\n${listed.stdout}`);
  }
  console.log(`Installed ${expected} into ${extensionsDir}`);

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: path.join(root, 'test', 'vsix', 'harness'),
    extensionTestsPath: path.join(root, 'out', 'vsix', 'installed-extension.js'),
    launchArgs: profileArgs,
    extensionTestsEnv: {
      EXPECTED_EXTENSION_ID: extensionId,
      EXPECTED_EXTENSIONS_DIR: extensionsDir,
      SCRATCH_DIR: sandbox,
    },
  });
  console.log(`${extensionId} activated from the isolated profile`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
