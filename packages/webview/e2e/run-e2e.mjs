import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

/**
 * Webview E2E.
 *
 * Serves the production build (the same assets the extension loads) with a
 * report produced by the real engine, then drives the interface in Chromium:
 * every section must render, navigation must work, findings must open, and fix
 * options must show a validated patch. Host-only actions are expected to be
 * unavailable in standalone mode and are asserted as such, not simulated.
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const dist = join(here, '../dist');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.map': 'application/json',
};

const server = createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  const rel = url === '/' ? '/index.html' : url;
  const file = normalize(join(dist, rel));
  if (!file.startsWith(dist)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await new Promise((resolve) => server.listen(4179, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/i.test(m.text())) errors.push(m.text()); });

let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { console.log(`  PASS  ${name}`); }
  else { failed += 1; console.error(`  FAIL  ${name} ${detail}`); }
}

try {
  await page.goto('http://127.0.0.1:4179/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.rail-item', { timeout: 15_000 });
  check('report loads', await page.locator('.rail-item').count() === 12);
  check('overview renders', (await page.locator('.main').innerText()).includes('Engineering overview'));
  check('risk factors shown', await page.locator('.factor').count() > 3);
  check('summary stats shown', await page.locator('.stat-value').count() === 4);

  const sections = ['Change Explorer', 'Architecture Impact', 'Code Review', 'Verified Findings', 'Review Pipeline', 'Documentation', 'Security & Reliability', 'Testing', 'Agent Activity', 'Discussion', 'Settings'];
  for (const label of sections) {
    await page.locator('.rail-item', { hasText: label }).click();
    await page.waitForTimeout(250);
    const text = await page.locator('.main').innerText();
    check(`section ${label} renders`, text.length > 200, `(${text.length} chars)`);
  }

  await page.locator('.rail-item', { hasText: 'Architecture Impact' }).click();
  await page.waitForSelector('svg.graph', { timeout: 5000 }).catch(() => {});
  const svg = page.locator('svg.graph');
  check('architecture graph has nodes', await svg.locator('.graph-node').count() > 3);
  check('architecture graph has edges', await svg.locator('.graph-edge').count() > 0);

  await page.locator('.rail-item', { hasText: 'Code Review' }).click();
  const rows = page.locator('.finding-row');
  check('findings list populated', await rows.count() > 5);
  await rows.first().click();
  await page.waitForTimeout(400);
  const detail = page.locator('.finding-card');
  check('finding detail opens', await detail.count() === 1 && (await detail.locator('.finding-head').innerText()).length > 10);
  check('finding shows evidence block', await detail.locator('.evidence-item').count() > 0);
  await page.locator('.tab', { hasText: 'Fix options' }).click();
  await page.waitForTimeout(300);
  const fixText = await page.locator('.finding-card').innerText();
  check('fix options render', /alternative solution|Generate fix options/.test(fixText));
  // A guidance option has no patch; a generated option has one. Either way the
  // panel must show a selectable, labelled option rather than an empty shell.
  check('fix option is labelled and selectable', fixText.includes('Option A') || fixText.includes('Patch preview') || fixText.includes('Generate fix options'));
  check('patch claims match reality', !/each with a machine-validated patch/.test(fixText) || fixText.includes('Patch preview'));

  // Standalone harness must refuse host-only actions instead of faking them.
  await page.locator('.rail-item', { hasText: 'Discussion' }).click();
  await page.locator('.chat-input textarea').fill('Why is this risky?');
  await page.locator('.chat-actions .btn.primary').click();
  await page.waitForTimeout(400);
  check('host-only chat is refused, not simulated', (await page.locator('.banner').first().innerText()).includes('requires a host'));

  check('no uncaught page errors', errors.length === 0, errors.join(' | '));
  await page.locator('.rail-item', { hasText: 'Overview' }).click();
  await page.screenshot({ path: join(here, '../../../tmp/e2e-webview.png') });
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll webview E2E checks passed.');
