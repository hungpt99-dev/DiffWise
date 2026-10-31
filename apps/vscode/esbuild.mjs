import esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

await rm(resolve(here, 'dist'), { recursive: true, force: true });
await mkdir(resolve(here, 'dist'), { recursive: true });

/** Bundle the extension and the workspace packages into one CommonJS file. */
const options = {
  entryPoints: [resolve(here, 'src/extension.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: resolve(here, 'dist/extension.js'),
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}

/** Copy the built webview next to the extension so the panel can load it. */
const webviewDist = resolve(here, '../../packages/webview/dist');
if (!existsSync(webviewDist)) {
  console.error('webview/dist is missing — run `npm run build -w @diffwise/webview` first.');
  process.exit(1);
}
await rm(resolve(here, 'media/webview'), { recursive: true, force: true });
await cp(webviewDist, resolve(here, 'media/webview'), { recursive: true });
