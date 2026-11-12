import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

const root = path.resolve(import.meta.dirname, '..');
const sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), 'ssr-')));
const workspace = path.join(sandbox, 'workspace');
const userDataDir = path.join(sandbox, 'ud');
const extensionsDir = path.join(sandbox, 'ext');

cpSync(path.join(root, 'test', 'fixtures', 'restricted'), workspace, { recursive: true });
mkdirSync(path.join(userDataDir, 'User'), { recursive: true });
mkdirSync(extensionsDir);
writeFileSync(
  path.join(userDataDir, 'User', 'settings.json'),
  JSON.stringify({
    'security.workspace.trust.enabled': true,
    'security.workspace.trust.startupPrompt': 'never',
    'security.workspace.trust.banner': 'never',
    'rest-client.environmentVariables': { $shared: { userToken: 'synthetic-user-token' } },
  }),
);

try {
  const executable = await downloadAndUnzipVSCode('stable');
  const args = [
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-updates',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-extensions',
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extensionsDir}`,
    `--extensionDevelopmentPath=${root}`,
    `--extensionTestsPath=${path.join(root, 'out', 'restricted', 'index.js')}`,
    workspace,
  ];
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (exitCode, signal) => {
      resolve(exitCode ?? (signal === null ? 0 : 1));
    });
  });
  if (code !== 0) {
    throw new Error(`Restricted workspace tests failed with exit code ${String(code)}`);
  }
  console.log('Restricted workspace tests passed');
} finally {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
