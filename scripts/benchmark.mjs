import { spawnSync } from 'node:child_process';
import * as esbuild from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'warning',
};

await esbuild.build({
  ...shared,
  entryPoints: ['test/benchmark/main.ts'],
  outfile: 'out/benchmark/main.js',
  external: ['@vscode/test-electron'],
});

await esbuild.build({
  ...shared,
  entryPoints: ['test/benchmark/view/driver.ts'],
  outfile: 'out/benchmark/view-driver.js',
  external: ['vscode'],
});

const result = spawnSync(
  process.execPath,
  ['--expose-gc', 'out/benchmark/main.js', ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
