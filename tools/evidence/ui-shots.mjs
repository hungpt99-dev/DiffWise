#!/usr/bin/env node
/**
 * Screenshot the real webview build for visual review.
 *
 * Usage: node tools/evidence/ui-shots.mjs
 * Output: docs/screenshots/ui-{overview,usage,review}-{wide,narrow}.png
 */
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '../..');
const dist = join(root, 'packages/webview/dist');
const out = join(root, 'docs/screenshots');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

const server = createServer(async (req, res) => {
  const rel = (req.url ?? '/').split('?')[0];
  const file = normalize(join(dist, rel === '/' ? '/index.html' : rel));
  if (!file.startsWith(dist)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    if (!res.headersSent) res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(4181, '127.0.0.1', r));
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
try {
  for (const [label, viewport] of [['wide', { width: 1600, height: 1000 }], ['narrow', { width: 860, height: 720 }]]) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    await page.goto('http://127.0.0.1:4181/', { waitUntil: 'networkidle' });
    await page.waitForSelector('.usage-card', { timeout: 15_000 });
    await page.screenshot({ path: join(out, `ui-overview-${label}.png`) });
    await page.locator('.usage-card').screenshot({ path: join(out, `ui-usage-${label}.png`) });
    await page.locator('.rail-item', { hasText: 'Code Review' }).click();
    await page.waitForSelector('.finding-row');
    await page.locator('.finding-row').first().click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, `ui-review-${label}.png`) });
    await page.close();
    console.log(`  ${label} ${viewport.width}x${viewport.height} → docs/screenshots/ui-*-${label}.png`);
  }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
