#!/usr/bin/env node
/**
 * Render a captured PTY transcript with xterm.js and screenshot it.
 *
 *   node tools/evidence/terminal-shot.mjs <ansi-file> <out.png> [--cols 118] [--rows 38] [--title "..."]
 *
 * The transcript is produced by running the real CLI under a pseudo-terminal
 * (`script`), so the image shows actual command output, not a mock-up.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  return value && !value.startsWith('--') ? value : true;
};

const ansiFile = process.argv[2];
const outFile = process.argv[3];
if (!ansiFile || !outFile) {
  console.error('usage: terminal-shot.mjs <ansi-file> <out.png> [--cols N] [--rows N] [--title text]');
  process.exit(2);
}
const cols = Number(arg('cols', 118));
const rows = Number(arg('rows', 38));
// xterm's monospace cell at 13px is ~7.85px wide; 8 leaves a safety margin so a
// full-width line is never clipped at the frame edge.
const frameWidth = Math.max(1180, Math.ceil(cols * 8) + 26);
const title = String(arg('title', 'diffwise'));
const data = await readFile(ansiFile, 'utf8');

const xtermJs = await readFile(resolve(root, 'node_modules/@xterm/xterm/lib/xterm.js'), 'utf8');
const xtermCss = await readFile(resolve(root, 'node_modules/@xterm/xterm/css/xterm.css'), 'utf8');

const browser = await chromium.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] });
const page = await browser.newPage({ viewport: { width: frameWidth, height: 760 }, deviceScaleFactor: 2 });
await page.setContent(`<!doctype html><html><head><meta charset="utf-8">
<style>
  ${xtermCss}
  body { margin: 0; background: #0b0d12; padding: 0; }
  .frame { width: ${frameWidth}px; background: #0b0d12; }
  .bar { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: #12151d;
         border-bottom: 1px solid #232833; font: 12px ui-sans-serif, system-ui, sans-serif; color: #8b94a7; }
  .dots { display: flex; gap: 6px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; }
  .dot:nth-child(1){background:#ff5f57}.dot:nth-child(2){background:#febc2e}.dot:nth-child(3){background:#28c840}
  .title { color: #cfd6e4; font-weight: 600; }
  .meta { margin-left: auto; font-family: ui-monospace, monospace; color: #5b6376; }
  #term { padding: 10px 8px 8px 12px; }
</style></head><body>
<div class="frame">
  <div class="bar"><div class="dots"><i class="dot"></i><i class="dot"></i><i class="dot"></i></div>
    <span class="title">${title.replace(/[<>&]/g, '')}</span>
    <span class="meta">${cols}×${rows} · real PTY session</span></div>
  <div id="term"></div>
</div>
<script>${xtermJs}</script>
</body></html>`);

await page.evaluate(async ({ data, cols, rows }) => {
  const term = new window.Terminal({
    cols,
    rows,
    fontFamily: 'ui-monospace, "JetBrains Mono", "DejaVu Sans Mono", Menlo, monospace',
    fontSize: 13,
    lineHeight: 1.25,
    theme: {
      background: '#0b0d12', foreground: '#dfe4ee', cursor: '#7aa2f7',
      black: '#0b0d12', red: '#ff7a7a', green: '#7ee787', yellow: '#f0c674',
      blue: '#7aa2f7', magenta: '#c8a2ff', cyan: '#7dd3fc', white: '#dfe4ee',
      brightBlack: '#5b6376', brightRed: '#ff9b9b', brightGreen: '#a5f3a5',
      brightYellow: '#ffd580', brightBlue: '#9ab8ff', brightMagenta: '#ddb8ff',
      brightCyan: '#a5e9ff', brightWhite: '#ffffff',
    },
  });
  term.open(document.getElementById('term'));
  await new Promise((r) => requestAnimationFrame(r));
  term.write(data);
  await new Promise((r) => setTimeout(r, 120));
  window.__term = term;
}, { data, cols, rows });

await page.waitForTimeout(400);
const height = await page.evaluate(() => document.querySelector('.frame').getBoundingClientRect().height);
await page.setViewportSize({ width: frameWidth, height: Math.ceil(height) });
await page.waitForTimeout(200);
await page.screenshot({ path: outFile, fullPage: true });
await browser.close();
console.log(`terminal shot: ${outFile}`);
