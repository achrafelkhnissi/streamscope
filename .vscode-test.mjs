import { defineConfig } from '@vscode/test-cli';

const shared = {
  files: 'out/integration/**/*.test.js',
  launchArgs: ['--disable-extensions'],
  mocha: { ui: 'bdd', timeout: 20_000 },
};

export default defineConfig([
  { ...shared, label: 'stable', version: 'stable' },
  { ...shared, label: 'minimum', version: '1.101.0' },
]);
