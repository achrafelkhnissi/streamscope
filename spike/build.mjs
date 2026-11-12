import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['spike/src/extension.ts'],
  outfile: 'spike/dist/extension.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'warning',
});
