import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const sharedConfig = {
  bundle: true,
  minify: !watch,
  sourcemap: watch,
};

// Extension host bundle
const extConfig = {
  ...sharedConfig,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node18',
  external: ['vscode'],
};

// Webview bundle
const webviewConfig = {
  ...sharedConfig,
  entryPoints: ['src/webview/main.ts'],
  outfile: 'dist/webview.js',
  platform: 'browser',
  target: 'es2022',
};

if (watch) {
  const extCtx = await esbuild.context(extConfig);
  const webCtx = await esbuild.context(webviewConfig);
  await Promise.all([extCtx.watch(), webCtx.watch()]);
  console.log('Watching for changes...');
} else {
  await Promise.all([
    esbuild.build(extConfig),
    esbuild.build(webviewConfig),
  ]);
  console.log('Build complete.');
}
