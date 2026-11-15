import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from '@vscode/test-electron';

export function installedVersionProblem(listOutput, extensionId, version) {
  const lines = listOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const expected = `${extensionId}@${version}`;
  if (lines.includes(expected)) {
    return undefined;
  }
  const found = lines.filter((line) => line.startsWith(`${extensionId}@`));
  return `Expected ${expected} in the clean profile, found: ${found.length === 0 ? 'nothing' : found.join(', ')}`;
}

export async function verifyInCleanProfile({ root, install, extensionId, version }) {
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

    const installed = spawnSync(cli, [...profileArgs, '--install-extension', ...install], {
      encoding: 'utf8',
    });
    process.stdout.write(installed.stdout);
    process.stderr.write(installed.stderr);
    if (installed.status !== 0) {
      throw new Error(
        `Installing ${install.join(' ')} failed with exit code ${String(installed.status)}`,
      );
    }

    const listed = spawnSync(cli, [...profileArgs, '--list-extensions', '--show-versions'], {
      encoding: 'utf8',
    });
    const problem = installedVersionProblem(listed.stdout, extensionId, version);
    if (problem !== undefined) {
      throw new Error(problem);
    }
    console.log(`Installed ${extensionId}@${version} into ${extensionsDir}`);

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
}
