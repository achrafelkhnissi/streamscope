import { defineConfig } from '@vscode/test-cli';

const shared = {
  files: 'out/integration/**/*.test.js',
  launchArgs: ['--disable-extensions'],
  mocha: { ui: 'bdd', timeout: 20_000 },
};

const workspace = {
  ...shared,
  files: 'out/integration-workspace/**/*.test.js',
  workspaceFolder: 'test/fixtures/workspace',
};

export default defineConfig([
  { ...shared, label: 'stable', version: 'stable' },
  { ...shared, label: 'minimum', version: '1.101.0' },
  { ...workspace, label: 'workspace-stable', version: 'stable' },
  { ...workspace, label: 'workspace-minimum', version: '1.101.0' },
]);
