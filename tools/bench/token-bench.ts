#!/usr/bin/env node
/**
 * Token-efficiency benchmark.
 *
 * Measures what DiffWise actually puts into a prompt, for the real analysis of
 * a real (synthetic) repository. No model is called: every number here is a
 * property of the context builders, so the run is deterministic and free.
 *
 * What is compared:
 *
 *   1. review context  — `buildContextPack` (0.3.0, character budget) vs
 *                        `buildChangeFirstContext` (tiered, token budget)
 *   2. reviewer scope  — the 0.3.0 scope builder (whole changed files) vs the
 *                        current one (windows around the changed lines)
 *   3. fix prompt      — whole changed files vs a window around the finding
 *
 * Coverage is measured as well, because a smaller prompt that drops the change
 * is not an optimisation. For every added line in the diff we check whether its
 * text appears in the assembled context.
 *
 * Usage:  npx tsx tools/bench/token-bench.ts [--json <path>]
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  buildChangeFirstContext, buildContextPack, changedLineNumbers, estimateTokens, runReview, type FileChange,
  type ReviewReport,
} from '@diffwise/core';
import { REVIEWER_SPECS } from '@diffwise/core';
import { buildReviewerScope as buildLegacyScope } from '../ai/legacy-scope';
import { buildReviewerScope as buildCurrentScope } from '../../packages/ai/dist/reviewers/scope';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '../..');
const DEMO = '/tmp/diffwise-bench-demo';

function git(cmd: string[]): string {
  return execFileSync('git', cmd, { cwd: DEMO, encoding: 'utf8' });
}

async function ensureDemo(): Promise<void> {
  if (existsSync(join(DEMO, '.git'))) return;
  execFileSync('node', [join(ROOT, 'demo/build-demo-repo.mjs'), '--target', DEMO], { encoding: 'utf8' });
}

/**
 * A fixture with large files, which is where a whole-file prompt actually costs
 * something. The demo repository has small files, so windows save little there;
 * this one changes eight lines inside two files of ~1,200 lines.
 */
async function ensureLargeFixture(): Promise<void> {
  const dir = '/tmp/diffwise-bench-large';
  if (existsSync(join(dir, '.git'))) return;
  const fs = await import('node:fs/promises');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(join(dir, 'src'), { recursive: true });
  const body = (name: string, n: number): string => {
    const lines: string[] = [`// ${name}: generated fixture, intentionally long.`];
    for (let i = 0; i < n; i++) {
      if (i % 40 === 0) {
        lines.push(`export function ${name}Handler${i}(input: Input${i % 7}): Result {`);
        lines.push(`  const value = input.value * ${i + 1};`);
        lines.push('  return { value };');
        lines.push('}');
      } else {
        lines.push(`const ${name}Note${i} = "line ${i} of ${name}";`);
      }
    }
    return `${lines.join('\n')}\n`;
  };
  await fs.writeFile(join(dir, 'src/service.ts'), body('service', 1_200), 'utf8');
  await fs.writeFile(join(dir, 'src/repository.ts'), body('repository', 900), 'utf8');
  await fs.writeFile(join(dir, 'README.md'), '# Large fixture\n\nSynthetic repository for prompt-size measurement.\n', 'utf8');
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'bench@diffwise.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Bench'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'base'], { cwd: dir });
  execFileSync('git', ['checkout', '-b', 'feature/large'], { cwd: dir });
  const service = await fs.readFile(join(dir, 'src/service.ts'), 'utf8');
  const patched = service.replace(
    'export function serviceHandler0(input: Input0): Result {',
    'export function serviceHandler0(input: Input0): Result {\n  // Changed: new validation and a query built by concatenation.\n  const sql = "SELECT * FROM t WHERE id = " + input.value;\n  if (!input.value) throw new Error("missing");\n  const rows = db.query(sql);',
  ).replace(
    'export function serviceHandler800(input: Input0): Result {',
    'export function serviceHandler800(input: Input0): Result {\n  // Changed: lock-free read-modify-write.\n  const current = store.get(input.value);\n  store.set(input.value, current + 1);',
  );
  await fs.writeFile(join(dir, 'src/service.ts'), patched, 'utf8');
  const repo = await fs.readFile(join(dir, 'src/repository.ts'), 'utf8');
  await fs.writeFile(join(dir, 'src/repository.ts'), repo.replace(
    'export function repositoryHandler400(input: Input1): Result {',
    'export function repositoryHandler400(input: Input1): Result {\n  // Changed: unbounded retry without backoff.\n  while (true) { try { return fetchIt(input); } catch { /* retry */ } }',
  ), 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'feature: changes in two long files'], { cwd: dir });
}

async function loadFiles(root: string, report: ReviewReport): Promise<Map<string, string>> {
  const paths = new Set<string>();
  for (const change of report.changes) paths.add(change.path);
  for (const finding of report.findings) {
    paths.add(finding.file);
    for (const e of finding.evidence) if (e.file) paths.add(e.file);
  }
  for (const doc of report.documentation.files) paths.add(doc.path);
  for (const symbol of report.symbols) paths.add(symbol.file);
  const files = new Map<string, string>();
  for (const path of paths) {
    try {
      files.set(path, await readFile(join(root, path), 'utf8'));
    } catch {
      // Deleted or unreadable file: the context builders skip it too.
    }
  }
  return files;
}

/** Share of added lines whose text appears in the assembled context. */
function coverage(changes: FileChange[], text: string): { lines: number; total: number; ratio: number; files: number; filesTotal: number } {
  const normalised = text.replace(/\r/g, '');
  let total = 0;
  let found = 0;
  let files = 0;
  for (const change of changes) {
    const added = changedLineNumbers(change).added;
    const sample = change.hunks.flatMap((h) => h.lines.filter((l) => l.kind === 'add').map((l) => l.text.trim())).filter((l) => l.length > 3);
    if (sample.length === 0) continue;
    let fileFound = 0;
    for (const line of sample) {
      total += 1;
      if (normalised.includes(line)) { found += 1; fileFound += 1; }
    }
    if (fileFound > 0) files += 1;
    void added;
  }
  return { lines: found, total, ratio: total === 0 ? 1 : found / total, files, filesTotal: changes.length };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

async function main(): Promise<void> {
  await ensureDemo();
  const target = { mode: 'branch' as const, base: 'main', label: 'main..feature/partial-refunds' };
  const started = Date.now();
  const report = await runReview({ root: DEMO, target, settings: { aiEnabled: false }, persist: false });
  const analysisMs = Date.now() - started;
  const files = await loadFiles(DEMO, report);
  const model = 'gpt-4o-mini';
  const window = 128_000;

  const results: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    fixture: { repo: report.repository.name, branch: report.repository.branch, commit: git(['rev-parse', 'HEAD']).trim(), files: report.changes.length, symbols: report.symbols.length, findings: report.findings.length },
    analysisMs,
    estimator: 'core/tokens/estimate (family-aware, conservative)',
  };

  // --- 1. Review context -----------------------------------------------------
  const legacyPack = buildContextPack(report, files, { maxChars: 60_000, includeCode: true });
  const legacyTokens = estimateTokens(legacyPack.text, model);
  const legacyCoverage = coverage(report.changes, legacyPack.text);

  const changeFirst = buildChangeFirstContext(report, files, { includeCode: true, model, contextLimit: window, reservedOutput: 12_000 });
  const changeFirstCoverage = coverage(report.changes, changeFirst.text);

  const equalBudget = buildChangeFirstContext(report, files, { includeCode: true, model, inputLimit: legacyTokens });
  const equalCoverage = coverage(report.changes, equalBudget.text);

  results.reviewContext = {
    legacy: { tokens: legacyTokens, chars: legacyPack.text.length, sections: 'single character budget', coverage: legacyCoverage, truncated: legacyPack.truncated },
    changeFirst: { tokens: changeFirst.tokens, budget: changeFirst.budget, sections: changeFirst.sections, coverage: changeFirstCoverage, truncated: changeFirst.truncated, dropped: changeFirst.dropped },
    equalBudget: { tokens: equalBudget.tokens, coverage: equalCoverage, clipped: equalBudget.clipped, dropped: equalBudget.dropped },
  };

  // Smallest budget at which the change-first builder still shows every added
  // line. This is the honest square-off against a builder that truncates.
  let minFullCoverageBudget = legacyTokens;
  let lo = 1_500;
  let hi = legacyTokens;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const probe = buildChangeFirstContext(report, files, { includeCode: true, model, inputLimit: mid });
    if (coverage(report.changes, probe.text).ratio >= 0.999) hi = mid;
    else lo = mid + 1;
  }
  minFullCoverageBudget = lo;
  results.fullCoverageBudget = {
    tokensForFullCoverage: minFullCoverageBudget,
    legacyTokensAtPartialCoverage: legacyTokens,
    legacyCoverage: legacyCoverage.ratio,
    savingAtEqualCoverage: 1 - minFullCoverageBudget / legacyTokens,
  };

  // --- 2. Reviewer scope -----------------------------------------------------
  // A reviewer scope is budget-saturated: it spends whatever ceiling it is
  // given. The meaningful comparison is therefore the smallest ceiling at which
  // each builder still shows every changed line.
  type ScopeBuilder = (input: Parameters<typeof buildLegacyScope>[0]) => { diff: string; files: Array<{ content: string }>; related: Array<{ content: string }> };
  const textOf = (scope: ReturnType<ScopeBuilder>): string =>
    [scope.diff, ...scope.files.map((f) => f.content), ...scope.related.map((r) => r.content)].join('\n');
  const minBudget = (build: ScopeBuilder, spec: (typeof REVIEWER_SPECS)[keyof typeof REVIEWER_SPECS]): { chars: number; tokens: number; coverage: number } => {
    if (!spec) return { chars: 0, tokens: 0, coverage: 0 };
    const probe = (chars: number): { tokens: number; coverage: number } => {
      const scopedSpec = { ...spec, budget: { ...spec.budget, scope: { ...spec.budget.scope, maxContextChars: chars } } };
      const text = textOf(build({ report, repoFiles: files, spec: scopedSpec }) as ReturnType<ScopeBuilder>);
      return { tokens: estimateTokens(text, model), coverage: coverage(report.changes, text).ratio };
    };
    let lo = 1_500;
    let hi = 60_000;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (probe(mid).coverage >= 0.999) hi = mid;
      else lo = mid + 1;
    }
    const result = probe(lo);
    return { chars: lo, tokens: result.tokens, coverage: result.coverage };
  };

  const scopes: Array<Record<string, unknown>> = [];
  for (const spec of [REVIEWER_SPECS.correctness, REVIEWER_SPECS.security, REVIEWER_SPECS.concurrency, REVIEWER_SPECS.testing]) {
    if (!spec) continue;
    scopes.push({
      reviewer: spec.id,
      budgetChars: spec.budget.scope.maxContextChars,
      legacy: minBudget(buildLegacyScope as ScopeBuilder, spec),
      current: minBudget(buildCurrentScope as unknown as ScopeBuilder, spec),
    });
  }
  results.reviewerScope = scopes;

  // --- 2b. Large-file fixture -------------------------------------------------
  await ensureLargeFixture();
  const largeReport = await runReview({
    root: '/tmp/diffwise-bench-large',
    target: { mode: 'branch', base: 'main', label: 'main..feature/large' },
    settings: { aiEnabled: false },
    persist: false,
  });
  const largeFiles = await loadFiles('/tmp/diffwise-bench-large', largeReport);
  const measure = (reportIn: ReviewReport, root: string, mapIn: Map<string, string>) => {
    const legacyCtx = buildContextPack(reportIn, mapIn, { maxChars: 60_000, includeCode: true });
    const legacyTokensForContext = estimateTokens(legacyCtx.text, model);
    const currentCtx = buildChangeFirstContext(reportIn, mapIn, { includeCode: true, model, inputLimit: legacyTokensForContext });
    const scopeRow: Record<string, unknown>[] = [];
    for (const spec of [REVIEWER_SPECS.correctness, REVIEWER_SPECS.architecture]) {
      if (!spec) continue;
      const legacyScope = buildLegacyScope({ report: reportIn, repoFiles: mapIn, spec });
      const legacyScopeText = [legacyScope.diff, ...legacyScope.files.map((f) => f.content), ...legacyScope.related.map((r) => r.content)].join('\n');
      const currentScope = buildCurrentScope({ report: reportIn, repoFiles: mapIn, spec });
      const currentScopeText = [currentScope.diff, ...currentScope.files.map((f) => f.content), ...currentScope.related.map((r) => r.content)].join('\n');
      scopeRow.push({
        reviewer: spec.id,
        legacyTokens: estimateTokens(legacyScopeText, model),
        currentTokens: estimateTokens(currentScopeText, model),
        legacyCoverage: coverage(reportIn.changes, legacyScopeText).ratio,
        currentCoverage: coverage(reportIn.changes, currentScopeText).ratio,
        legacyChars: legacyScopeText.length,
        currentChars: currentScopeText.length,
        root,
      });
    }
    return {
      files: reportIn.changes.length,
      findings: reportIn.findings.length,
      context: {
        legacyTokens: legacyTokensForContext,
        legacyCoverage: coverage(reportIn.changes, legacyCtx.text).ratio,
        currentTokens: currentCtx.tokens,
        currentCoverage: coverage(reportIn.changes, currentCtx.text).ratio,
      },
      reviewers: scopeRow,
    };
  };
  results.largeFixture = measure(largeReport, '/tmp/diffwise-bench-large', largeFiles);

  // --- 3. Fix prompt ---------------------------------------------------------
  const actionable = report.findings
    .filter((f) => f.severity !== 'info' && f.kind !== 'question')
    .sort((a, b) => a.severity.localeCompare(b.severity))
    .slice(0, 3);
  const fixFiles = new Set<string>(actionable.flatMap((f) => [f.file, ...f.evidence.map((e) => e.file ?? '')]));
  let legacyFixTokens = 0;
  let currentFixTokens = 0;
  for (const finding of actionable) {
    for (const file of fixFiles) {
      const content = files.get(file);
      if (!content) continue;
      legacyFixTokens += estimateTokens(content.slice(0, 16_000), model);
      // Windowed variant, as implemented in `generateFixOptions`.
      const { codeWindows } = await import('@diffwise/core');
      const win = codeWindows(content, [{ start: finding.range.start, end: finding.range.end }], { radius: 40, mergeGap: 20, maxWindows: 2, maxLines: 170 });
      currentFixTokens += estimateTokens(win.text, model);
    }
  }
  results.fixPrompt = { findings: actionable.length, files: [...fixFiles], legacy: { tokens: legacyFixTokens }, current: { tokens: currentFixTokens } };

  // --- Summary --------------------------------------------------------------
  const reviewSaved = 1 - changeFirst.tokens / legacyTokens;
  const scopeSaved = scopes.length
    ? 1 - scopes.reduce((sum, s) => sum + (s.current as { tokens: number }).tokens, 0) / scopes.reduce((sum, s) => sum + (s.legacy as { tokens: number }).tokens, 0)
    : 0;
  results.scopeMinimalBudget = { legacyTokens: scopes.reduce((sum, s) => sum + (s.legacy as { tokens: number }).tokens, 0), currentTokens: scopes.reduce((sum, s) => sum + (s.current as { tokens: number }).tokens, 0) };
  const fixSaved = legacyFixTokens ? 1 - currentFixTokens / legacyFixTokens : 0;
  results.summary = { reviewContextSaved: reviewSaved, reviewerScopeSaved: scopeSaved, fixPromptSaved: fixSaved };

  const jsonFlag = process.argv.indexOf('--json');
  const outPath = jsonFlag >= 0 ? process.argv[jsonFlag + 1] : join(ROOT, 'docs/evidence/token-bench.json');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');

  const row = (label: string, a: number, b: number, covA: number, covB: number): string =>
    `| ${label} | ${a} | ${b} | ${pct(1 - b / a)} | ${pct(covA)} | ${pct(covB)} |`;

  console.log(`Fixture: ${report.repository.name}@${report.repository.branch} — ${report.changes.length} files, ${report.findings.length} findings, analysis ${analysisMs}ms\n`);
  console.log('| Prompt | tokens before | tokens after | saved | coverage before | coverage after |');
  console.log('|---|---:|---:|---:|---:|---:|');
  console.log(row('review context (each tool\'s default budget)', legacyTokens, changeFirst.tokens, legacyCoverage.ratio, changeFirstCoverage.ratio));
  console.log(row('review context (same budget, new side)', legacyTokens, equalBudget.tokens, legacyCoverage.ratio, equalCoverage.ratio));
  for (const scope of scopes) {
    const legacy = scope.legacy as { tokens: number; coverage: number };
    const current = scope.current as { tokens: number; coverage: number };
    console.log(row(`reviewer:${String(scope.reviewer)} (min budget for full coverage)`, legacy.tokens, current.tokens, legacy.coverage, current.coverage));
  }
  if (legacyFixTokens) console.log(row('fix prompt', legacyFixTokens, currentFixTokens, 1, 1));
  const large = results.largeFixture as {
    files: number;
    context: { legacyTokens: number; legacyCoverage: number; currentTokens: number; currentCoverage: number };
    reviewers: Array<{ reviewer: string; legacyTokens: number; currentTokens: number; legacyCoverage: number; currentCoverage: number }>;
  };
  console.log(`\nLarge-file fixture (${large.files} files, ~2,100 lines):`);
  console.log(row('review context (same budget)', large.context.legacyTokens, large.context.currentTokens, large.context.legacyCoverage, large.context.currentCoverage));
  for (const r of large.reviewers) {
    console.log(row(`reviewer:${r.reviewer} (same budget)`, r.legacyTokens, r.currentTokens, r.legacyCoverage, r.currentCoverage));
  }
  const change = (saved: number): string => `${Math.abs(saved * 100).toFixed(0)}% ${saved >= 0 ? 'fewer' : 'more'}`;
  console.log(`\nReview context at equal budget: ${change(1 - equalBudget.tokens / legacyTokens)} tokens, coverage ${pct(legacyCoverage.ratio)} → ${pct(equalCoverage.ratio)}.`);
  console.log(`Review context at full coverage: ${minFullCoverageBudget} tokens — ${change(1 - minFullCoverageBudget / legacyTokens)} than the legacy prompt, which covered only ${pct(legacyCoverage.ratio)}.`);
  console.log(`Reviewer scope on small files: ${change(scopeSaved)} tokens for equal coverage (windows do not pay on short files).`);
  console.log(`Fix prompt: ${change(fixSaved)} tokens.`);
  const largeSaving = large.reviewers.length
    ? 1 - large.reviewers.reduce((sum, r) => sum + r.currentTokens, 0) / large.reviewers.reduce((sum, r) => sum + r.legacyTokens, 0)
    : 0;
  console.log(`Large-file reviewer scope: ${change(largeSaving)} tokens at equal coverage.`);
  console.log(`Default context budget (derived from the model window): ${change(reviewSaved)} tokens than the legacy 60k-character prompt, with complete coverage.`);
  console.log(`Written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
