#!/usr/bin/env node
/**
 * Capture CLI screenshots for the README.
 *
 * Every image is a real PTY transcript rendered with xterm.js: the command is
 * executed in a materialised demo repository, its ANSI output is recorded by
 * `script`, and the recording is screenshotted. Nothing here is a mock-up, and
 * no output is typed by hand.
 *
 *   node tools/evidence/cli-shots.mjs
 *
 * Writes docs/screenshots/cli-*.png and keeps the raw transcripts in
 * /tmp/diffwise-cli-shots/ansi for inspection.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const WORK = '/tmp/diffwise-cli-shots';
const DEMO = join(WORK, 'demo');
const ANSI = join(WORK, 'ansi');
const SHOTS = join(ROOT, 'docs/screenshots');
const CLI = join(ROOT, 'packages/cli/bin/diffwise.js');
const BIN = join(WORK, 'bin');
// 100 columns: the width the summary wraps to, and the widest image that stays
// legible when GitHub scales it to a README column.
const COLS = 100;

function log(message) {
  process.stdout.write(`${message}\n`);
}

async function run(command, args, options = {}) {
  try {
    const { stdout, stderr } = await exec(command, args, {
      cwd: options.cwd ?? ROOT,
      env: { ...process.env, ...(options.env ?? {}) },
      maxBuffer: 32 * 1024 * 1024,
      timeout: options.timeout ?? 300_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? String(err) };
  }
}

/**
 * Run a shell snippet under a real PTY and keep the ANSI transcript.
 *
 * Progress lines use carriage returns, so every line is collapsed to the
 * segment a terminal would actually leave on screen; otherwise the spinner
 * frames survive as one absurdly long line.
 */
async function pty(id, script, prompt = '') {
  const path = join(WORK, `${id}.sh`);
  // The invocation is echoed the way a shell would show it. The output under
  // it is the unedited transcript of that exact command.
  const echo = prompt
    ? prompt.split('\n').map((line) => `printf '\\033[1;32m$\\033[0m %s\\n' ${JSON.stringify(line)}`).join('\n') + '\n'
    : '';
  // `diffwise` is put on PATH so the transcript reads like the command a user
  // types, not like an absolute path to a bin script.
  const prelude = `export PATH="${BIN}:$PATH"`;
  await writeFile(path, `#!/bin/bash\nset +e\n${prelude}\nstty cols ${COLS} rows 500 2>/dev/null\n${echo}${script}\necho "__EXIT:$?"\n`, 'utf8');
  const { stdout } = await run('script', ['-q', '-e', '-c', `bash ${path}`, '/dev/null'], {
    cwd: DEMO,
    env: { COLUMNS: String(COLS), LINES: '500', TERM: 'xterm-256color', NO_COLOR: '' },
  });
  const text = stdout
    .replace(/\r\n/g, '\n')
    .replace(/\n__EXIT:\d+\s*$/, '')
    .split('\n')
    .map((line) => line.slice(line.lastIndexOf('\r') + 1).replace(/\s+$/, ''))
    .join('\n')
    .trimEnd();
  await writeFile(join(ANSI, `${id}.ansi`), `${text}\n`, 'utf8');
  return text;
}

/** Visible width of a transcript, ignoring colour codes. */
function measure(text) {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  const lines = plain.split('\n');
  return {
    cols: Math.max(...lines.map((l) => l.length)),
    rows: lines.length,
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Fail loudly when a frame captured an error instead of the output it claims. */
function assertFrame(id, text, mustContain) {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  if (/command not found|No such file or directory|Traceback/.test(plain)) {
    throw new Error(`${id}: the transcript captured an error, not output:\n${plain.slice(0, 400)}`);
  }
  for (const needle of mustContain) {
    if (!plain.includes(needle)) {
      throw new Error(`${id}: transcript is missing "${needle}"; got:\n${plain.slice(0, 600)}`);
    }
  }
}

async function shot(id, title) {
  const target = join(SHOTS, `${id}.png`);
  const { cols, rows } = measure(await readFile(join(ANSI, `${id}.ansi`), 'utf8'));
  const result = await run(process.execPath, [
    join(here, 'terminal-shot.mjs'), join(ANSI, `${id}.ansi`), target,
    '--cols', String(clamp(cols + 2, 110, 170)), '--rows', String(clamp(rows, 8, 46)),
    '--title', title,
  ], { cwd: ROOT, timeout: 180_000 });
  if (result.code !== 0) throw new Error(`terminal-shot failed for ${id}: ${result.stderr}`);
  const { size } = await import('node:fs').then((fs) => fs.statSync(target));
  log(`  ✓ ${id}.png  (${Math.round(size / 1024)} KB)`);
}

async function main() {
  await mkdir(ANSI, { recursive: true });
  await mkdir(BIN, { recursive: true });
  await rm(join(BIN, 'diffwise'), { force: true });
  await (await import('node:fs/promises')).symlink(CLI, join(BIN, 'diffwise'));
  await mkdir(SHOTS, { recursive: true });
  await rm(DEMO, { recursive: true, force: true });

  log('materialising the demo repository');
  await run(process.execPath, [join(ROOT, 'demo/build-demo-repo.mjs'), '--target', DEMO], { cwd: ROOT });
  await run(process.execPath, [CLI, 'init'], { cwd: DEMO });

  // Configure a real verification command and deterministic AI so every frame
  // below is reproducible without a provider.
  const configPath = join(DEMO, '.diffwise/config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.ai = { enabled: false, sendRepositoryContent: false };
  config.verification = { command: `${ROOT}/node_modules/.bin/vitest run tests/paymentService.test.ts`, timeoutMs: 120_000 };
  config.qualityGate = { failOn: 'high' };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  // A stored review is needed before the read commands can say anything.
  await run(process.execPath, [CLI, 'review', 'main..feature/partial-refunds', '--no-ai'], { cwd: DEMO, timeout: 300_000 });
  const findings = JSON.parse((await run(process.execPath, [CLI, 'findings', '--json', '--limit', '40'], { cwd: DEMO })).stdout);
  const sqlInjection = findings.findings.find((f) => /SQL/i.test(f.title)) ?? findings.findings[0];
  const apiBreak = findings.findings.find((f) => /signature|parameter/i.test(f.title)) ?? sqlInjection;

  log(`review ${findings.reviewId}: ${findings.findings.length} findings, using ${sqlInjection.id} and ${apiBreak.id}`);

  const frames = [
    ['cli-review', 'diffwise review — a change, reviewed and verified',
      'diffwise review main..feature/partial-refunds --no-ai',
      ['DiffWise review', 'verified', 'Top findings']],
    ['cli-findings', 'diffwise findings — filter by severity',
      'diffwise findings --severity critical\ndiffwise findings --severity high --limit 4',
      ['SEVERITY', 'CRITICAL']],
    ['cli-show', 'diffwise show — the finding, its evidence and its verdict',
      `diffwise show ${sqlInjection.id}`,
      ['Evidence', 'Recommendation']],
    ['cli-verify', 'diffwise verify — a real command, a real exit code',
      `diffwise verify --finding ${apiBreak.id} 2>&1 | tail -n 20`,
      ['pass', 'fail']],
    // A developer-supplied patch: the deterministic path to a real diff, with
    // no provider configured. The patch is validated before it is shown.
    ['cli-fix-preview', 'diffwise fix --preview — a validated patch, not applied',
      `diffwise fix ${apiBreak.id} --patch-file ${ROOT}/demo/fixes/calculate-fee-callers.patch --preview`,
      ['Patch preview', 'applies cleanly']],
    ['cli-reviewers-plan', 'diffwise reviewers plan — which reviewers run, and why',
      'diffwise reviewers plan',
      ['reviewer', 'would run']],
    ['cli-rules', 'diffwise rules list — the deterministic catalogue',
      'diffwise rules list --category security',
      ['security.']],
    ['cli-policy', 'diffwise policy effective — every value and its source',
      'diffwise policy effective',
      ['Effective review policy', 'default']],
    ['cli-json', 'diffwise review --json — machine output for CI and agents',
      `diffwise review main..feature/partial-refunds --no-ai --json --out /tmp/dw.json >/dev/null 2>&1\njq '{schemaVersion, findings: (.findings|length), verification: .review.verification}' /tmp/dw.json | head -16`,
      ['schemaVersion', 'verification']],
    ['cli-evaluate', 'diffwise evaluate — measured quality on a labelled corpus',
      `diffwise evaluate --dataset ${ROOT}/evals 2>/dev/null | tail -n 12`,
      ['precision', 'recall']],
  ];

  for (const [id, title, script, expected] of frames) {
    log(`capturing ${id}`);
    const prompt = script.split('\n').filter((l) => l.startsWith('diffwise ') || l.startsWith('jq ')).join('\n')
      || script.split('\n')[0];
    const text = await pty(id, script, prompt);
    assertFrame(id, text, expected);
    await shot(id, title);
  }

  log('done');
}

await main();
