#!/usr/bin/env node
/**
 * Headless review runner used by tests, the e2e screenshot harness and CI.
 *
 *   node scripts/analyze.mjs --repo /tmp/diffwise-demo --mode branch \
 *     --base main --head feature/partial-refunds --out report.json [--no-ai]
 *
 * The AI provider is configured through environment variables only:
 *   DIFFWISE_PROVIDER_ID, DIFFWISE_BASE_URL, DIFFWISE_MODEL, DIFFWISE_API_KEY,
 *   DIFFWISE_SEND_CONTENT=1, DIFFWISE_EXTRA_HEADERS (JSON)
 */
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const core = require(resolve(here, '../packages/core/dist/index.js'));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  return value && !value.startsWith('--') ? value : true;
}

const repo = resolve(arg('repo', process.cwd()));
const mode = arg('mode', 'branch');
const base = arg('base', 'main');
const head = arg('head', 'HEAD');
const out = arg('out', '');
const noAi = arg('no-ai', false) === true;

const settings = {
  maxFiles: Number(process.env.DIFFWISE_MAX_FILES ?? 200),
  maxFileBytes: 400000,
  maxEvidenceSnippets: 40,
  ignoreGlobs: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/*.min.js', '**/package-lock.json', '**/.diffwise/**'],
  aiEnabled: !noAi,
  sendRepositoryContent: process.env.DIFFWISE_SEND_CONTENT === '1',
  providerId: process.env.DIFFWISE_PROVIDER_ID ?? 'openai-compatible',
  model: process.env.DIFFWISE_MODEL,
  verificationCommand: process.env.DIFFWISE_VERIFY_COMMAND,
};

let enrichers = [];
if (!noAi && process.env.DIFFWISE_API_KEY) {
  const ai = require(resolve(here, '../packages/ai/dist/index.js'));
  const provider = ai.createProvider({
    id: settings.providerId,
    baseUrl: process.env.DIFFWISE_BASE_URL ?? 'https://api.openai.com/v1',
    apiKey: process.env.DIFFWISE_API_KEY,
    model: process.env.DIFFWISE_MODEL ?? 'gpt-4o-mini',
    extraHeaders: process.env.DIFFWISE_EXTRA_HEADERS ? JSON.parse(process.env.DIFFWISE_EXTRA_HEADERS) : {},
    maxTokens: Number(process.env.DIFFWISE_MAX_TOKENS ?? 4000),
    temperature: Number(process.env.DIFFWISE_TEMPERATURE ?? 0.1),
    timeoutMs: Number(process.env.DIFFWISE_TIMEOUT_MS ?? 180000),
  });
  const fixProvider = process.env.DIFFWISE_FAST_MODEL
    ? ai.createProvider({
      id: settings.providerId,
      baseUrl: process.env.DIFFWISE_BASE_URL ?? 'https://api.openai.com/v1',
      apiKey: process.env.DIFFWISE_API_KEY,
      model: process.env.DIFFWISE_FAST_MODEL,
      extraHeaders: process.env.DIFFWISE_EXTRA_HEADERS ? JSON.parse(process.env.DIFFWISE_EXTRA_HEADERS) : {},
      maxTokens: Number(process.env.DIFFWISE_MAX_TOKENS ?? 4000),
      temperature: 0.1,
      timeoutMs: Number(process.env.DIFFWISE_TIMEOUT_MS ?? 180000),
    })
    : undefined;
  enrichers = [new ai.AiReviewer(provider, {
    ...(fixProvider ? { fixProvider } : {}),
    maxFixFindings: Number(process.env.DIFFWISE_MAX_FIXES ?? 3),
  })];
}

const target = mode === 'working'
  ? { mode: 'working', label: 'Working tree' }
  : mode === 'staged'
    ? { mode: 'staged', label: 'Staged changes' }
    : mode === 'commits'
      ? { mode: 'commits', base, head, label: `Commits ${base}..${head}` }
      : { mode: 'branch', base, head, label: `Branch ${base}...${head}` };

const started = Date.now();
const report = await core.runReview({
  root: repo,
  target,
  settings,
  enrichers,
  onProgress: (stages) => {
    const running = stages.find((s) => s.status === 'running');
    if (running && process.env.DIFFWISE_VERBOSE === '1') {
      process.stderr.write(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${running.label}\n`);
    }
  },
});

const summary = {
  id: report.id,
  durationMs: report.durationMs,
  changedFiles: report.changes.length,
  findings: report.findings.length,
  bySeverity: report.summary.findingsBySeverity,
  risk: { level: report.risk.level, score: report.risk.score },
  docs: report.documentation.findings.length,
  fixes: report.fixes.length,
  ai: report.ai ?? null,
  provider: report.provider,
  completeness: report.summary.completeness,
  completenessNote: report.summary.completenessNote ?? null,
  stages: report.stages.map((s) => ({ id: s.id, status: s.status, ms: s.durationMs ?? 0, error: s.error })),
};
console.log(JSON.stringify(summary, null, 2));

if (out) {
  await writeFile(out, JSON.stringify(report, null, 2), 'utf8');
  console.error(`report written to ${out}`);
}
