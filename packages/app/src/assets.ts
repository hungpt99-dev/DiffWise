/**
 * Locating the built web report bundle.
 *
 * The same React application is used in three places: the VS Code webview, the
 * local report server and the standalone HTML export. All three read the same
 * build output, so a fix to the UI reaches every surface.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface WebAssets {
  dir: string;
  indexHtml: string;
  jsFile: string;
  cssFile: string;
  js: string;
  css: string;
}

function candidates(from: string): string[] {
  const list: string[] = [];
  if (process.env.DIFFWISE_WEBVIEW_DIST) list.push(resolve(process.env.DIFFWISE_WEBVIEW_DIST));
  // packages/app/dist -> packages/webview/dist
  list.push(resolve(from, '..', '..', 'webview', 'dist'));
  // installed layout: node_modules/@diffwise/app/dist -> node_modules/@diffwise/webview/dist
  list.push(resolve(from, '..', '..', '..', '@diffwise', 'webview', 'dist'));
  return list;
}

export class MissingWebAssetsError extends Error {
  constructor(searched: string[]) {
    super(
      `The web report bundle was not found. Looked in:\n  ${searched.join('\n  ')}\n`
      + 'Build it with "npm run build -w @diffwise/webview", or set DIFFWISE_WEBVIEW_DIST to the built directory.',
    );
    this.name = 'MissingWebAssetsError';
  }
}

/** Load the built bundle, resolving asset file names from index.html. */
export async function loadWebAssets(): Promise<WebAssets> {
  const searched = candidates(__dirname);
  for (const dir of searched) {
    const indexHtml = join(dir, 'index.html');
    if (!existsSync(indexHtml)) continue;
    const html = await readFile(indexHtml, 'utf8');
    const jsMatch = /<script[^>]+src="([^"]+\.js)"/.exec(html);
    const cssMatch = /<link[^>]+href="([^"]+\.css)"/.exec(html);
    if (!jsMatch?.[1] || !cssMatch?.[1]) continue;
    const jsPath = join(dir, jsMatch[1].replace(/^\//, ''));
    const cssPath = join(dir, cssMatch[1].replace(/^\//, ''));
    if (!existsSync(jsPath) || !existsSync(cssPath)) continue;
    return {
      dir: dirname(jsPath),
      indexHtml: html,
      jsFile: jsMatch[1],
      cssFile: cssMatch[1],
      js: await readFile(jsPath, 'utf8'),
      css: await readFile(cssPath, 'utf8'),
    };
  }
  throw new MissingWebAssetsError(searched);
}

/**
 * A Content-Security-Policy that works for the bundled app: no inline script
 * (the export injects data, not code), styles allowed inline because Vite
 * inlines a small runtime style, and no network access beyond self.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Escape a JSON payload for embedding in a <script> element. */
export function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
