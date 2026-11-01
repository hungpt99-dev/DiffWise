#!/usr/bin/env node
/**
 * Evidence capture — runs the real product and records screenshots, GIFs and
 * logs. Nothing here fabricates output:
 *
 *   - CLI images are real `script` (PTY) transcripts replayed in xterm.js;
 *   - web images come from the local report server rendering a real report;
 *   - GIFs are frame sequences captured while driving the real UI;
 *   - every log line in docs/evidence/logs is command output.
 *
 * The demo fixture is deterministic, but it is analysed by the real pipeline.
 * A live model is used when OPENCODE_GO_API_KEY (or DIFFWISE_API_KEY) is set;
 * otherwise the run is deterministic and the manifest says so.
 *
 *   node tools/evidence/capture.mjs [--no-ai] [--skip-install]
 */
import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const WORK = process.env.DIFFWISE_EVIDENCE_DIR ?? '/tmp/diffwise-evidence';
const DEMO = join(WORK, 'demo');
const LOGS = join(WORK, 'logs');
const FRAMES = join(WORK, 'frames');
const SHOTS = join(ROOT, 'docs/screenshots');
const DEMOS = join(ROOT, 'docs/demos');
const CLI = join(ROOT, 'packages/cli/bin/diffwise.js');
const ANSI = join(WORK, 'ansi');

const NO_AI = process.argv.includes('--no-ai');
const SKIP_INSTALL = process.argv.includes('--skip-install');

const ffmpeg = ['ffmpeg', '/root/.hermes/tools/ffmpeg-9.0.1-linux-x64/bin/ffmpeg', '/usr/bin/ffmpeg']
  .find((candidate) => candidate === 'ffmpeg' || existsSync(candidate));

const started = new Date();
const evidence = [];
const failures = [];
const notes = [];

function log(message) {
  process.stdout.write(`${message}\n`);
}

function record(entry) {
  evidence.push(entry);
}

async function ensureDirs() {
  for (const dir of [WORK, LOGS, FRAMES, SHOTS, DEMOS, ANSI]) await mkdir(dir, { recursive: true });
}

/** Run a command and capture stdout/stderr separately. */
async function run(command, args, options = {}) {
  const startedAt = Date.now();
  try {
    const result = await exec(command, args, {
      cwd: options.cwd ?? DEMO,
      env: { ...process.env, NO_COLOR: '1', ...(options.env ?? {}) },
      timeout: options.timeout ?? 600_000,
      maxBuffer: 40 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr, durationMs: Date.now() - startedAt };
  } catch (err) {
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? String(err),
      durationMs: Date.now() - startedAt,
    };
  }
}

/** Run a command under a real PTY and return everything it printed. */
async function pty(id, command, options = {}) {
  const cols = options.cols ?? 118;
  const rows = options.rows ?? 40;
  const scriptPath = join(WORK, `${id}.sh`);
  await writeFile(scriptPath, `#!/bin/bash\nset +e\nstty cols ${cols} rows ${rows} 2>/dev/null\n${command}\necho "__EXIT:$?"\n`, 'utf8');
  const result = await run('script', ['-q', '-e', '-c', `bash ${scriptPath}`, '/dev/null'], {
    cwd: DEMO,
    env: { COLUMNS: String(cols), LINES: String(rows), TERM: 'xterm-256color', ...(options.env ?? {}) },
    timeout: options.timeout ?? 900_000,
  });
  const raw = result.stdout.replace(/\r\n/g, '\n').replace(/\n__EXIT:(\d+)\s*$/, '');
  const exitMatch = /__EXIT:(\d+)\s*$/.exec(result.stdout.replace(/\r\n/g, '\n'));
  const code = exitMatch ? Number(exitMatch[1]) : result.code;
  const text = raw.replace(/\n__EXIT:\d+\s*$/, '');
  await writeFile(join(ANSI, `${id}.ansi`), text, 'utf8');
  await writeFile(join(LOGS, `${id}.log`), `$ ${command}\n\n${text}\n\nexit: ${code}\n`, 'utf8');
  return { code, text, cols, rows };
}

async function shot(id, ansiId, title) {
  const target = join(SHOTS, `${id}.png`);
  const result = await run(process.execPath, [
    join(here, 'terminal-shot.mjs'), join(ANSI, `${ansiId}.ansi`), target,
    '--cols', '118', '--rows', '40', '--title', title,
  ], { cwd: ROOT, timeout: 120_000 });
  if (result.code !== 0) throw new Error(`terminal-shot failed for ${id}: ${result.stderr}`);
  return target;
}

async function frameGif(name, captureFn, options = {}) {
  const dir = join(FRAMES, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  let index = 0;
  let lastAt = 0;
  const frame = async (page, force = false) => {
    const now = Date.now();
    if (!force && now - lastAt < (options.minIntervalMs ?? 220)) return;
    lastAt = now;
    index += 1;
    await page.screenshot({ path: join(dir, `frame-${String(index).padStart(4, '0')}.png`) });
  };
  await captureFn(frame);
  if (index < 2) {
    notes.push(`GIF ${name}: only ${index} frame(s) captured`);
    return null;
  }
  const gif = join(DEMOS, `${name}.gif`);
  const fps = options.fps ?? 6;
  const args = [
    '-y', '-loglevel', 'error', '-framerate', String(fps), '-i', join(dir, 'frame-%04d.png'),
    '-vf', 'scale=1280:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
    '-loop', '0', gif,
  ];
  const result = await run(ffmpeg, args, { cwd: ROOT, timeout: 300_000 });
  if (result.code !== 0) {
    failures.push(`ffmpeg failed for ${name}: ${result.stderr.slice(0, 300)}`);
    return null;
  }
  log(`  gif  ${name}.gif (${index} frames)`);
  return gif;
}

async function configureDemo() {
  const apiKeyVar = process.env.OPENCODE_GO_API_KEY ? 'OPENCODE_GO_API_KEY' : 'DIFFWISE_API_KEY';
  const config = {
    schemaVersion: 1,
    provider: {
      id: 'openai-compatible',
      baseUrl: process.env.DIFFWISE_BASE_URL ?? 'https://opencode.ai/zen/go/v1',
      model: process.env.DIFFWISE_MODEL ?? 'glm-5.3-flash',
      apiKeyEnvVar: apiKeyVar,
      fastModel: process.env.DIFFWISE_MODEL ?? 'glm-5.3-flash',
      maxTokens: 8000,
      temperature: 0.1,
      timeoutMs: 300000,
      extraHeaders: { 'x-opencode-session': `diffwise-evidence-${Date.now()}` },
    },
    ai: { enabled: !NO_AI, sendRepositoryContent: false },
    analysis: { maxFiles: 200, maxFileBytes: 400000, ignoreGlobs: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/*.min.js', '**/package-lock.json', '**/.diffwise/**', '**/artifacts/**'] },
    verification: { command: 'npx vitest run', timeoutMs: 300000 },
    qualityGate: { failOn: 'high' },
  };
  await mkdir(join(DEMO, '.diffwise'), { recursive: true });
  await writeFile(join(DEMO, '.diffwise/config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { apiKeyVar, model: config.provider.model, baseUrl: config.provider.baseUrl };
}

async function main() {
  await ensureDirs();
  log('DiffWise evidence capture');
  log(`  workspace: ${WORK}`);
  log(`  started:   ${started.toISOString()}`);

  // ------------------------------------------------------------------ prepare
  log('\n[1/7] preparing the demo repository (real fixture, real git history)');
  await run(process.execPath, [join(ROOT, 'demo/build-demo-repo.mjs'), '--target', DEMO], { cwd: ROOT });
  const installed = await readFile(join(ROOT, 'package.json'), 'utf8');
  void installed;
  if (!SKIP_INSTALL) {
    const install = await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: DEMO, timeout: 600_000 });
    if (install.code !== 0) notes.push(`npm install in demo failed: ${install.stderr.slice(0, 400)}`);
  }
  const provider = await configureDemo();
  const hasKey = Boolean(process.env[provider.apiKeyVar]);
  if (!hasKey) notes.push(`No ${provider.apiKeyVar} in the environment: AI review, chat and AI fix generation were not exercised.`);
  log(`  provider: ${provider.model} (${provider.apiKeyVar}: ${hasKey ? 'present' : 'missing'})`);

  // --------------------------------------------------------------------- CLI
  log('\n[2/7] CLI sessions (real PTY transcripts)');
  const help = await pty('t01-help', `node ${CLI} --help`);
  await shot('01-cli-help', 't01-help', 'diffwise --help');

  const review = await pty('t02-review', `node ${CLI} review main..feature/partial-refunds`, { timeout: 900_000 });
  await shot('02-cli-review', 't02-review', 'diffwise review main..feature/partial-refunds');
  const reviewReportId = /review ([0-9]{8}-[0-9]{6}-[0-9a-f]{6})/.exec(review.text)?.[1];
  log(`  review exit ${review.code}, report ${reviewReportId ?? 'unknown'}`);

  const findings = await pty('t03-findings', `node ${CLI} findings --severity high`);
  await shot('03-cli-findings', 't03-findings', 'diffwise findings --severity high');

  const jsonStep = await pty(
    't04-json',
    `node ${CLI} report latest --format json --out artifacts/envelope.json >/dev/null && node ${join(here, 'validate-json.mjs')} artifacts/envelope.json`,
  );
  await shot('04-cli-json', 't04-json', 'diffwise report latest --format json → validated contract');

  const sarifStep = await pty(
    't19-sarif',
    `node ${CLI} report latest --format sarif --out artifacts/diffwise.sarif >/dev/null && node ${join(here, 'validate-sarif.mjs')} artifacts/diffwise.sarif`,
  );
  await shot('19-ci-sarif', 't19-sarif', 'diffwise report latest --format sarif → validated SARIF 2.1.0');

  await pty('t05-html', `node ${CLI} report latest --format html --out artifacts/report.html`, { timeout: 120_000 });
  const htmlPath = join(DEMO, 'artifacts/report.html');

  // Register the developer-supplied patch that fixes the callers of the changed
  // signature, so the fix workflow has a real, validated patch to preview and
  // apply through the UI.
  const sigLookup = await run(process.execPath, [CLI, 'findings', '--search', 'signature changed: calculateFee', '--json'], { cwd: DEMO });
  let signatureFinding;
  try {
    signatureFinding = JSON.parse(sigLookup.stdout).findings?.[0]?.id;
  } catch { signatureFinding = undefined; }
  if (signatureFinding) {
    await pty('t20-fix-preview', `node ${CLI} fix ${signatureFinding} --patch-file ${join(ROOT, 'demo/fixes/calculate-fee-callers.patch')} --preview`, { timeout: 300_000 });
  } else {
    notes.push('Could not locate the signature-change finding to register the demo patch.');
  }

  log('\n[3/7] MCP session (real stdio client)');
  const mcp = await pty('t18-mcp', `node ${join(here, 'mcp-session.mjs')} --root ${DEMO}`, { timeout: 600_000 });
  await shot('18-mcp-integration', 't18-mcp', 'MCP: coding-agent session (stdio JSON-RPC)');

  // ------------------------------------------------------------------- web UI
  log('\n[4/7] starting the local report server');
  const server = spawn(process.execPath, [CLI, 'report', 'latest', '--serve', '--port', '4711'], {
    cwd: DEMO,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverUrl = '';
  server.stdout.setEncoding('utf8');
  server.stderr.setEncoding('utf8');
  const serverLog = [];
  server.stdout.on('data', (chunk) => {
    serverLog.push(chunk);
    const match = /(http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+)/.exec(serverLog.join(''));
    if (match && !serverUrl) serverUrl = match[1];
  });
  server.stderr.on('data', (chunk) => serverLog.push(chunk));
  const deadline = Date.now() + 20_000;
  while (!serverUrl && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  if (!serverUrl) {
    failures.push(`report server did not start: ${serverLog.join('').slice(0, 400)}`);
    throw new Error('report server did not start');
  }
  log(`  server: ${serverUrl.replace(/token=.*/, 'token=…')}`);
  await writeFile(join(LOGS, 'server.log'), `${serverLog.join('')}\n`, 'utf8');

  const browser = await chromium.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  context.on('page', (extra) => {
    if (extra !== page) extra.close().catch(() => {});
  });
  const consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/favicon|net::ERR_/i.test(msg.text())) consoleErrors.push(msg.text());
  });

  await page.goto(serverUrl, { waitUntil: 'networkidle' });
  await page.waitForSelector('.rail-item', { timeout: 30_000 });
  await page.waitForTimeout(600);

  const section = async (label) => {
    await page.locator('.rail-item', { hasText: label }).click();
    await page.waitForTimeout(500);
  };

  log('\n[5/7] capturing the web report');
  await section('Overview');
  await page.screenshot({ path: join(SHOTS, '05-dashboard-overview.png') });

  await section('Code Review');
  await page.waitForSelector('.finding-row', { timeout: 20_000 });
  await page.locator('.finding-row').first().click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS, '06-dashboard-findings.png') });

  // Diff viewer: Change Explorer → Files tab → a changed file.
  await section('Change Explorer');
  await page.locator('.tab', { hasText: 'Files' }).first().click().catch(() => {});
  await page.waitForTimeout(400);
  const fileRow = page.locator('.split .list-pane .list-item').first();
  if (await fileRow.count()) await fileRow.click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS, '07-dashboard-code-review.png') });

  await section('Architecture Impact');
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(SHOTS, '08-dashboard-architecture.png') });

  await section('Documentation');
  await page.screenshot({ path: join(SHOTS, '09-dashboard-documentation.png') });

  await section('Testing');
  await page.screenshot({ path: join(SHOTS, '10-dashboard-testing.png') });

  await section('Security & Reliability');
  await page.screenshot({ path: join(SHOTS, '11-dashboard-security.png') });

  // --------------------------------------------------------------------- chat
  log('\n[6/7] report-aware chat and the safe-fix workflow');
  await section('Discussion');
  const chatInput = page.locator('.chat-input textarea');
  const question = 'What is the safest way to fix the SQL statement built by string interpolation in the refund path, and what could break?';
  await chatInput.click();
  await chatInput.type(question, { delay: 8 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, '12-dashboard-ai-chat-question.png') }).catch(() => {});
  const chatGif = await frameGif('ai-chat-workflow', async (frame) => {
    await frame(page, true);
    await page.locator('.chat-actions .btn.primary').click();
    const startedChat = Date.now();
    let answered = false;
    while (Date.now() - startedChat < 150_000) {
      await page.waitForTimeout(300);
      await frame(page);
      const messages = await page.locator('.msg-assistant .msg-text').count();
      const typing = await page.locator('.typing').count();
      if (messages > 0 && typing === 0) { answered = true; break; }
    }
    if (!answered) notes.push('Chat did not return an answer within 150s.');
    await page.waitForTimeout(600);
    await frame(page, true);
  }, { fps: 2, minIntervalMs: 900 });

  const answer = await page.locator('.chat-log').innerText().catch(() => '');
  if (!/pong/i.test(answer) && answer.length < 120) {
    notes.push('Chat answer was short or unavailable; see docs/evidence/logs/web-chat.log');
  }
  await writeFile(join(LOGS, 'web-chat.log'), `${answer}\n`, 'utf8');
  await page.screenshot({ path: join(SHOTS, '12-dashboard-ai-chat.png') });

  // Fix workflow: pick a finding that has a patch, or generate one live.
  await section('Code Review');
  const calculateFeeRow = page.locator('.finding-row', { hasText: 'calculateFee' }).first();
  if (await calculateFeeRow.count()) {
    await calculateFeeRow.click();
    await page.waitForTimeout(400);
    await page.locator('.finding-actions .btn', { hasText: 'Compare fixes' }).first().click().catch(() => {});
    await page.waitForTimeout(600);
  }
  const picks = await page.locator('.finding-row').count();
  let opened = (await page.locator('.finding-card').innerText().catch(() => '')).includes('Patch preview');
  for (let i = 0; i < Math.min(picks, 8) && !opened; i += 1) {
    await page.locator('.finding-row').nth(i).click();
    await page.waitForTimeout(300);
    await page.locator('.finding-actions .btn', { hasText: 'Compare fixes' }).first().click().catch(() => {});
    await page.waitForTimeout(400);
    const hasPreview = await page.locator('.finding-card').innerText().then((t) => /Patch preview/.test(t)).catch(() => false);
    if (hasPreview) { opened = true; break; }
    const generate = page.locator('.finding-card .btn', { hasText: 'Generate fix options' });
    if (await generate.count()) {
      await generate.first().click();
      const startedGen = Date.now();
      while (Date.now() - startedGen < 180_000) {
        await page.waitForTimeout(1000);
        const text = await page.locator('.finding-card').innerText().catch(() => '');
        if (/Patch preview/.test(text)) { opened = true; break; }
        if (!/Generating options/.test(text) && Date.now() - startedGen > 8000) break;
      }
    }
  }
  if (!opened) failures.push('No fix with a validated patch was available for the fix-workflow screenshots.');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, '13-dashboard-fix-preview.png') });

  const approval = page.locator('.apply-box input[type="checkbox"]');
  if (await approval.count()) {
    await approval.first().check();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, '14-dashboard-fix-approval.png') });
    const applyGif = await frameGif('safe-fix-workflow', async (frame) => {
      await frame(page, true);
      await page.locator('.apply-actions .btn.primary').click();
      const startedApply = Date.now();
      while (Date.now() - startedApply < 60_000) {
        await page.waitForTimeout(400);
        await frame(page);
        const applied = await page.locator('.applied').count();
        if (applied > 0) break;
      }
      await page.waitForTimeout(400);
      await frame(page, true);
      // Verification: approve and run the configured command.
      const verifyBox = page.locator('.verify-approve input[type="checkbox"]');
      if (await verifyBox.count()) {
        await verifyBox.first().check();
        await frame(page, true);
        await page.locator('.verify-approve .btn').click();
        const startedVerify = Date.now();
        while (Date.now() - startedVerify < 240_000) {
          await page.waitForTimeout(600);
          await frame(page);
          const done = await page.locator('.applied .output').count();
          if (done > 0) break;
        }
      }
      await page.waitForTimeout(600);
      await frame(page, true);
    }, { fps: 4, minIntervalMs: 500 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(SHOTS, '15-dashboard-verification.png') });
    void applyGif;
  } else {
    failures.push('Approval control was not found; screenshots 14/15 could not be captured.');
  }

  // History menu + navigation GIF.
  const navGif = await frameGif('web-report-navigation', async (frame) => {
    for (const label of ['Overview', 'Change Explorer', 'Architecture Impact', 'Code Review', 'Documentation', 'Testing', 'Security & Reliability']) {
      await section(label);
      await page.waitForTimeout(350);
      await frame(page, true);
    }
  }, { fps: 2, minIntervalMs: 500 });

  await page.locator('.topbar-actions .btn.ghost', { hasText: 'History' }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, '16-dashboard-history.png') });
  await page.keyboard.press('Escape').catch(() => {});
  await page.locator('.topbar-actions').click({ position: { x: 5, y: 5 } }).catch(() => {});

  await section('Architecture Impact');
  await page.waitForTimeout(400);
  const graphGif = await frameGif('architecture-impact', async (frame) => {
    await frame(page, true);
    const nodes = page.locator('.graph-node');
    const count = Math.min(await nodes.count(), 6);
    for (let i = 0; i < count; i += 1) {
      await nodes.nth(i).hover().catch(() => {});
      await page.waitForTimeout(500);
      await frame(page, true);
    }
  }, { fps: 2, minIntervalMs: 400 });

  // Responsive layout, then the standalone HTML export.
  await context.close();
  const mobile = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(serverUrl, { waitUntil: 'networkidle' });
  await mobilePage.waitForSelector('.rail-item', { timeout: 20_000 });
  await mobilePage.waitForTimeout(800);
  await mobilePage.screenshot({ path: join(SHOTS, '20-responsive-report.png'), fullPage: false });
  await mobile.close();

  log('\n[7/7] standalone HTML export');
  const htmlPage = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const htmlErrors = [];
  htmlPage.on('pageerror', (err) => htmlErrors.push(err.message));
  await htmlPage.goto(`file://${htmlPath}`, { waitUntil: 'load' });
  await htmlPage.waitForSelector('.rail-item', { timeout: 20_000 });
  await htmlPage.waitForTimeout(700);
  await htmlPage.screenshot({ path: join(SHOTS, '17-html-report.png') });
  if (htmlErrors.length) failures.push(`standalone HTML page errors: ${htmlErrors.join(' | ')}`);

  await browser.close();
  server.kill('SIGINT');

  // ---------------------------------------------------------------- manifest
  const cliReviewGif = await frameGif('cli-review-workflow', async (frame) => {
    const gifBrowser = await chromium.launch({ args: ['--no-sandbox'] });
    const gifPage = await gifBrowser.newPage({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 1 });
    await gifPage.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      ${await readFile(join(ROOT, 'node_modules/@xterm/xterm/css/xterm.css'), 'utf8')}
      body{margin:0;background:#0b0d12;padding:14px}
      .bar{display:flex;gap:8px;align-items:center;padding:8px 12px;background:#12151d;border-bottom:1px solid #232833;
           font:12px ui-sans-serif,system-ui;color:#8b94a7}
      .dot{width:10px;height:10px;border-radius:50%}
      .d1{background:#ff5f57}.d2{background:#febc2e}.d3{background:#28c840}
      </style></head><body>
      <div class="bar"><i class="dot d1"></i><i class="dot d2"></i><i class="dot d3"></i>
        <span style="color:#cfd6e4;font-weight:600;margin-left:6px">diffwise review main..feature/partial-refunds</span></div>
      <div id="term" style="padding:10px"></div></body></html>`);
    await gifPage.addScriptTag({ path: join(ROOT, 'node_modules/@xterm/xterm/lib/xterm.js') });
    await gifPage.evaluate(async ({ text }) => {
      const term = new window.Terminal({
        cols: 118, rows: 42, fontSize: 13, lineHeight: 1.25,
        fontFamily: 'ui-monospace, "DejaVu Sans Mono", Menlo, monospace',
        theme: { background: '#0b0d12', foreground: '#dfe4ee', black: '#0b0d12', red: '#ff7a7a', green: '#7ee787', yellow: '#f0c674', blue: '#7aa2f7', magenta: '#c8a2ff', cyan: '#7dd3fc', white: '#dfe4ee', brightBlack: '#5b6376' },
      });
      term.open(document.getElementById('term'));
      window.__term = term;
      window.__lines = text.split('\n');
    }, { text: review.text });
    const total = await gifPage.evaluate(() => window.__lines.length);
    for (let i = 0; i < total; i += 2) {
      await gifPage.evaluate((upto) => {
        const term = window.__term;
        term.write(`${window.__lines.slice(upto, upto + 2).join('\n')}\n`);
      }, i);
      await frame(gifPage);
      await gifPage.waitForTimeout(60);
    }
    await frame(gifPage, true);
    await gifBrowser.close();
  }, { fps: 3, minIntervalMs: 120 });

  const summary = {
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    workspace: WORK,
    demoRepository: DEMO,
    reviewId: reviewReportId ?? null,
    provider: { model: provider.model, baseUrl: provider.baseUrl, keyVariable: provider.apiKeyVar, live: hasKey, aiEnabled: !NO_AI && hasKey },
    cli: {
      helpExit: help.code,
      reviewExit: review.code,
      jsonValidationExit: jsonStep.code,
      sarifValidationExit: sarifStep.code,
      mcpExit: mcp.code,
    },
    gifs: { cliReview: cliReviewGif, navigation: navGif, architecture: graphGif, chat: chatGif },
    notes: [...notes, ...consoleErrors.map((e) => `browser console error: ${e}`)],
    failures,
    evidence,
  };
  await writeFile(join(WORK, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeFile(join(LOGS, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  log(`\nDone. ${failures.length} failure(s), ${notes.length} note(s).`);
  for (const failure of failures) log(`  FAIL ${failure}`);
  for (const note of notes) log(`  note ${note}`);
  if (failures.length) process.exitCode = 1;
}

main().catch(async (err) => {
  failures.push(`capture crashed: ${err.stack ?? err.message}`);
  log(`\ncapture failed: ${err.stack ?? err.message}`);
  process.exitCode = 1;
});

export { evidence, stat, readdir };
