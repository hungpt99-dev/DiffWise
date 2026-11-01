/**
 * Platform commands: rules, reviewers, policy, evaluate.
 *
 * These are the introspection commands an engineer or an agent uses to
 * understand *why* a review behaves the way it does: which rules exist, which
 * reviewers would run, which policy layer supplied a setting, and how the
 * detector scores on a labelled corpus.
 */
import { readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  REVIEWER_SPECS, RULES, allReviewerSpecs, explainPlan, listRules,
  loadRulePacks, runEvaluation, selectReviewers, snapshotPolicy, resolvePolicy,
  type ReviewerId,
} from '@diffwise/core';
import { buildPlatform, loadPolicyFiles } from '@diffwise/app';
import type { CommandContext } from '../context';
import { EXIT } from '../exit';
import { flagBool, flagString } from '../args';

function printJson(ctx: CommandContext, value: unknown): number {
  ctx.out.stdout(JSON.stringify(value, null, 2));
  return EXIT.OK;
}

export async function rulesCommand(ctx: CommandContext): Promise<number> {
  const sub = ctx.argv.positionals[0] ?? 'list';

  if (sub === 'list') {
    const platform = await buildPlatform({ root: ctx.root });
    const descriptors = listRules({ builtinRules: RULES, packs: platform.rulePacks, policy: platform.policy });
    const filtered = flagString(ctx.argv.flags, 'category')
      ? descriptors.filter((d) => d.category === flagString(ctx.argv.flags, 'category'))
      : descriptors;
    if (ctx.json) return printJson(ctx, { count: filtered.length, rules: filtered, problems: platform.problems });
    ctx.out.info(`${filtered.length} rule(s):`);
    for (const rule of filtered) {
      ctx.out.info(`  ${rule.id.padEnd(42)} ${rule.category.padEnd(16)} ${String(rule.severity).padEnd(12)} ${rule.pack}`);
    }
    if (platform.problems.length) {
      ctx.out.info('');
      for (const problem of platform.problems) ctx.out.info(`  ! ${problem.path}: ${problem.message}`);
    }
    return EXIT.OK;
  }

  if (sub === 'explain') {
    const id = ctx.argv.positionals[1];
    if (!id) { ctx.out.error('Usage: diffwise rules explain <rule-id>'); return EXIT.USAGE; }
    const platform = await buildPlatform({ root: ctx.root });
    const rule = listRules({ builtinRules: RULES, packs: platform.rulePacks, policy: platform.policy }).find((r) => r.id === id);
    if (!rule) { ctx.out.error(`No rule "${id}". Run "diffwise rules list".`); return EXIT.NOT_FOUND; }
    const suppressed = platform.policy.rules.suppress.find((entry) => entry.ruleId === id);
    const override = platform.policy.rules.severityOverride[id];
    if (ctx.json) return printJson(ctx, { rule, suppressed, severityOverride: override });
    ctx.out.info(rule.name);
    ctx.out.info(`  id          ${rule.id}`);
    ctx.out.info(`  version     ${rule.version}${rule.packVersion ? ` (pack ${rule.pack}@${rule.packVersion})` : ''}`);
    ctx.out.info(`  category    ${rule.category}`);
    ctx.out.info(`  severity    ${override ? `${rule.severity} (overridden from ${override === rule.severity ? 'policy' : 'policy'})` : rule.severity}`);
    ctx.out.info(`  mode        ${rule.mode}`);
    ctx.out.info(`  languages   ${Array.isArray(rule.languages) ? rule.languages.join(', ') : rule.languages}`);
    ctx.out.info(`  evidence    ${rule.requiresEvidence ? 'required' : 'optional'}`);
    ctx.out.info(`  source      ${rule.source}${rule.path ? ` (${rule.path})` : ''}`);
    ctx.out.info('');
    ctx.out.info(rule.description);
    for (const reference of rule.references ?? []) ctx.out.info(`  ref: ${reference.title}${reference.url ? ` — ${reference.url}` : ''}`);
    if (suppressed) ctx.out.info(`  suppressed until ${suppressed.expiresAt} by ${suppressed.approvedBy}: ${suppressed.reason}`);
    return EXIT.OK;
  }

  if (sub === 'validate') {
    const target = ctx.argv.positionals[1];
    if (!target) { ctx.out.error('Usage: diffwise rules validate <dir>'); return EXIT.USAGE; }
    const dirs = [resolve(ctx.root, target)];
    const loaded = await loadRulePacks(dirs);
    const errors = loaded.issues.filter((i) => i.level === 'error');
    if (ctx.json) {
      printJson(ctx, {
        packs: loaded.packs.map((p) => ({
          id: p.id, version: p.version, ruleCount: p.rules.length, rules: p.rules.map((r) => r.id),
          blocked: p.blocked ?? null,
          issues: p.issues,
        })),
        errors: errors.length,
        warnings: loaded.issues.filter((i) => i.level === 'warning').length,
      });
      // The exit code is the contract: CI branches on it, so machine output
      // must not silently turn a validation failure into success.
      return errors.length === 0 ? EXIT.OK : EXIT.USAGE;
    }
    for (const pack of loaded.packs) {
      ctx.out.info(`${pack.id}@${pack.version}: ${pack.rules.length} rule(s)${pack.blocked ? ` — BLOCKED: ${pack.blocked}` : ''}`);
      for (const issue of pack.issues) ctx.out.info(`  ${issue.level}: ${issue.message} (${issue.path})`);
    }
    for (const issue of loaded.issues) {
      if (!loaded.packs.some((p) => p.issues.includes(issue))) ctx.out.info(`${issue.level}: ${issue.message} (${issue.path})`);
    }
    ctx.out.info('');
    ctx.out.info(errors.length === 0 ? 'Valid.' : `${errors.length} error(s).`);
    return errors.length === 0 ? EXIT.OK : EXIT.USAGE;
  }

  if (sub === 'install') {
    const target = ctx.argv.positionals[1];
    if (!target) { ctx.out.error('Usage: diffwise rules install <dir>'); return EXIT.USAGE; }
    const loaded = await loadRulePacks([resolve(ctx.root, target)]);
    const errors = loaded.issues.filter((i) => i.level === 'error');
    if (errors.length > 0 && !flagBool(ctx.argv.flags, 'force')) {
      ctx.out.error(`Refusing to install: ${errors.length} validation error(s). Use --force to install anyway.`);
      return EXIT.USAGE;
    }
    const registry = await readOfficialPacks();
    const installed = await readInstalledPacks(ctx.root);
    const merged = [...new Set([...installed, ...loaded.packs.map((p) => p.id)])];
    await writeFile(join(ctx.root, '.diffwise', 'rule-packs.json'), `${JSON.stringify({ schemaVersion: 1, packs: merged, known: registry }, null, 2)}\n`, 'utf8');
    ctx.out.info(`Installed ${loaded.packs.map((p) => `${p.id}@${p.version}`).join(', ')} into .diffwise/rule-packs.json.`);
    ctx.out.info('The pack files themselves are read from .diffwise/rules/ or the path you pass to --rule-pack.');
    void ctx;
    return EXIT.OK;
  }

  ctx.out.error(`Unknown subcommand "rules ${sub}". Try: list, explain, validate, install.`);
  return EXIT.USAGE;
}

async function readInstalledPacks(root: string): Promise<string[]> {
  try {
    const raw = await import('node:fs/promises').then((fs) => fs.readFile(join(root, '.diffwise', 'rule-packs.json'), 'utf8'));
    const parsed = JSON.parse(raw) as { packs?: string[] };
    return Array.isArray(parsed.packs) ? parsed.packs : [];
  } catch {
    return [];
  }
}

async function readOfficialPacks(): Promise<string[]> {
  try {
    const entries = await readdir(join(__dirname, '..', '..', '..', '..', 'evals', 'packs'));
    return entries;
  } catch {
    return [];
  }
}

export async function reviewersCommand(ctx: CommandContext): Promise<number> {
  const sub = ctx.argv.positionals[0] ?? 'list';

  if (sub === 'list') {
    const specs = allReviewerSpecs();
    if (ctx.json) return printJson(ctx, { count: specs.length, reviewers: specs });
    ctx.out.info(`${specs.length} reviewers:`);
    for (const spec of specs) {
      ctx.out.info(`  ${spec.id.padEnd(16)} ${spec.name}`);
      ctx.out.info(`    ${spec.description}`);
      ctx.out.info(`    budget: ${spec.budget.maxFindings} findings, ${spec.budget.maxTokens} tokens, ${spec.budget.timeoutMs}ms; default ${spec.defaultEnabled ? 'on' : 'off'}`);
    }
    return EXIT.OK;
  }

  if (sub === 'explain') {
    const id = ctx.argv.positionals[1] as ReviewerId | undefined;
    if (!id || !(id in REVIEWER_SPECS)) {
      ctx.out.error(`Usage: diffwise reviewers explain <${Object.keys(REVIEWER_SPECS).join('|')}>`);
      return EXIT.USAGE;
    }
    const spec = REVIEWER_SPECS[id];
    if (ctx.json) return printJson(ctx, spec);
    ctx.out.info(`${spec.name} (${spec.id}@${spec.version})`);
    ctx.out.info('');
    ctx.out.info(spec.description);
    ctx.out.info('');
    ctx.out.info('Focus:');
    for (const line of spec.focus) ctx.out.info(`  - ${line}`);
    ctx.out.info('');
    ctx.out.info('Must not:');
    for (const line of spec.avoid) ctx.out.info(`  - ${line}`);
    ctx.out.info('');
    ctx.out.info(`Languages: ${spec.capabilities.languages === 'any' ? 'any' : spec.capabilities.languages.join(', ')}`);
    ctx.out.info(`Budget: ${spec.budget.maxFindings} findings, ${spec.budget.maxTokens} tokens, ${spec.budget.timeoutMs}ms, ${spec.budget.scope.maxContextChars} characters of context`);
    return EXIT.OK;
  }

  if (sub === 'plan') {
    // Explain which reviewers would run for the latest review, without a model.
    const report = await ctx.service.latestReview();
    if (!report) { ctx.out.error('No review yet. Run "diffwise review" first.'); return EXIT.NOT_FOUND; }
    const plan = selectReviewers({
      changes: report.changes,
      symbols: report.symbols,
      graph: report.architecture.graph,
      tests: report.tests,
      findings: report.findings,
      risk: { level: report.risk.level, score: report.risk.score },
    });
    if (ctx.json) return printJson(ctx, plan);
    for (const line of explainPlan(plan)) ctx.out.info(line);
    ctx.out.info('');
    ctx.out.info(`would run: ${plan.reviewers.join(', ')} (cap ${plan.maxReviewers}${plan.truncated ? ', some reviewers ranked out' : ''})`);
    return EXIT.OK;
  }

  ctx.out.error(`Unknown subcommand "reviewers ${sub}". Try: list, explain, plan.`);
  return EXIT.USAGE;
}

export async function policyCommand(ctx: CommandContext): Promise<number> {
  const sub = ctx.argv.positionals[0] ?? 'effective';
  if (sub !== 'effective') {
    ctx.out.error(`Unknown subcommand "policy ${sub}". Try: effective.`);
    return EXIT.USAGE;
  }
  const files = await loadPolicyFiles(ctx.root);
  const effective = resolvePolicy(files.layers, ctx.argv.positionals.slice(1));
  const snapshot = snapshotPolicy(effective);
  if (ctx.json) return printJson(ctx, snapshot);
  ctx.out.info('Effective review policy');
  ctx.out.info(`  schemaVersion ${snapshot.schemaVersion}`);
  ctx.out.info('');
  ctx.out.info('Layers (org → repository → directory → file):');
  if (snapshot.layers.length === 0) ctx.out.info('  (no policy files found; built-in defaults only)');
  for (const layer of snapshot.layers) {
    ctx.out.info(`  ${layer.loaded ? '✓' : '✗'} ${layer.kind.padEnd(13)} ${layer.appliesTo.padEnd(20)} ${layer.source}${layer.error ? ` — ${layer.error}` : ''}`);
  }
  ctx.out.info('');
  ctx.out.info('Selected values and where they came from:');
  for (const path of [
    'reviewers.maxReviewers', 'reviewers.fullSweep', 'verification.minimumStatus',
    'verification.aiVerification', 'verification.requireApproval', 'verification.sandbox',
    'qualityGate.failOn', 'security.blockingSeverity', 'approvals.requiredApprovals.high',
    'approvals.requiredApprovals.severe', 'rules.minSeverity',
  ]) {
    const value = path.split('.').reduce<unknown>((acc, key) => (acc as Record<string, unknown> | undefined)?.[key], snapshot.policy);
    ctx.out.info(`  ${path.padEnd(34)} ${String(value).padEnd(10)} ${snapshot.provenance[path] ?? 'default'}`);
  }
  if (snapshot.warnings.length) {
    ctx.out.info('');
    ctx.out.info('Warnings:');
    for (const warning of snapshot.warnings) ctx.out.info(`  - ${warning}`);
  }
  return EXIT.OK;
}

export async function evaluateCommand(ctx: CommandContext): Promise<number> {
  const dataset = flagString(ctx.argv.flags, 'dataset') ?? ctx.argv.positionals[0] ?? 'evals';
  const path = resolve(ctx.root, dataset);
  await ensureFixtures(ctx, path);
  const result = await runEvaluation({
    datasetPath: path,
    log: (message) => { if (!ctx.json) ctx.out.info(`  · ${message}`); },
  });

  if (ctx.json) return printJson(ctx, result);

  ctx.out.info(`Dataset: ${result.dataset.name} (${result.dataset.id}) — ${result.dataset.cases} case(s)`);
  ctx.out.info('');
  for (const c of result.results) {
    const status = c.error ? 'ERROR' : `${c.matched}/${c.expected}`;
    ctx.out.info(`  ${status.padEnd(6)} ${c.caseId.padEnd(24)} ${c.found} finding(s), ${c.durationMs}ms${c.error ? ` — ${c.error}` : ''}`);
    for (const m of c.matches.filter((x) => x.status !== 'matched')) {
      ctx.out.info(`         ${m.status}: ${m.expectedId} — ${m.note}`);
    }
    for (const f of c.forbiddenProduced) ctx.out.info(`         FORBIDDEN: ${f.id} — ${f.reason}`);
  }
  ctx.out.info('');
  const m = result.metrics;
  ctx.out.info(`precision ${m.precision ?? 'n/a'}  recall ${m.recall ?? 'n/a'}  f1 ${m.f1 ?? 'n/a'}  severity ${m.severityAccuracy ?? 'n/a'}  verification ${m.verificationRate ?? 'n/a'}`);
  ctx.out.info(`expected ${m.expected}  found ${m.found}  detected ${m.detected}  matched ${m.matched}  forbidden violations ${m.forbiddenViolations}`);
  ctx.out.info('');
  ctx.out.info(result.scope);
  return m.forbiddenViolations > 0 || m.casesFailed > 0 ? EXIT.GATE_FAILED : EXIT.OK;
}

/**
 * Build the fixtures on demand.
 *
 * They are generated rather than committed (each case is a git repository), so a
 * fresh clone has none. Building them here keeps `diffwise evaluate` a single
 * command while still printing exactly what ran.
 */
async function ensureFixtures(ctx: CommandContext, datasetPath: string): Promise<void> {
  const { access } = await import('node:fs/promises');
  const fixtures = join(datasetPath, 'fixtures');
  try {
    await access(fixtures);
    return;
  } catch {
    // Not built yet.
  }
  const builder = join(datasetPath, 'build-fixtures.mjs');
  try {
    await access(builder);
  } catch {
    return;
  }
  if (!ctx.json) ctx.out.info(`Fixtures are missing; building them with ${builder}`);
  const { execFile } = await import('node:child_process');
  await new Promise<void>((resolvePromise, reject) => {
    execFile(process.execPath, [builder], { cwd: datasetPath }, (err, stdout, stderr) => {
      if (err) { reject(new Error(`fixture build failed: ${stderr || err.message}`)); return; }
      if (!ctx.json && stdout.trim()) ctx.out.debug(stdout.trim());
      resolvePromise();
    });
  });
}
