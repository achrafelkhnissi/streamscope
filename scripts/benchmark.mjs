import { spawnSync } from 'node:child_process';
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['test/benchmark/main.ts'],
  outfile: 'out/benchmark/main.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'warning',
});

const result = spawnSync(
  process.execPath,
  ['--expose-gc', 'out/benchmark/main.js', ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
