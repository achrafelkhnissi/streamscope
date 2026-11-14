import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

function report(kind, { text, location }) {
  console.error(`✘ [${kind}] ${text}`);
  if (location) {
    console.error(`    ${location.file}:${String(location.line)}:${String(location.column)}:`);
  }
}

const problemMatcherPlugin = {
  name: 'problem-matcher',
  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd((result) => {
      for (const message of result.errors) {
        report('ERROR', message);
      }
      for (const message of result.warnings) {
        report('WARNING', message);
      }
      console.log('[watch] build finished');
    });
  },
};

const host = {
  outdir: 'dist',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  external: ['vscode'],
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  keepNames: true,
  logLevel: 'silent',
  plugins: [problemMatcherPlugin],
};

const contexts = await Promise.all([
  esbuild.context({
    ...host,
    entryPoints: { extension: 'src/extension.ts' },
    banner: { js: '"use strict";\nconst streamscopeLoadedAt = performance.now();' },
  }),
  esbuild.context({
    ...host,
    entryPoints: {
      'format-worker': 'src/response/format-worker.ts',
      'capture-worker': 'src/capture/body-worker.ts',
    },
  }),
  esbuild.context({
    entryPoints: { 'response-view': 'src/webview/main.ts' },
    outdir: 'dist',
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2023',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    logLevel: 'silent',
    plugins: [problemMatcherPlugin],
  }),
]);

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
