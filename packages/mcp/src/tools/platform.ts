/**
 * Platform tools for the MCP server (interface v2).
 *
 * These are additive: every v1 tool keeps its name and shape. A v2 client gets
 * the reviewer pipeline, finding verification, rule/policy introspection and the
 * verification plan; a v1 client is unaffected.
 *
 * Rules for this surface:
 *   - read tools are side-effect free and safe to call in a loop;
 *   - nothing here applies a patch or runs a command without an explicit flag;
 *   - every response is JSON text, with a stable `schemaVersion`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RULES, buildReproductionPlan, buildVerificationPlan, discoverCommands, explainPlan,
  listRules, resolvePolicy, selectReviewers, snapshotPolicy, runDeterministicVerification,
  contextFromReport, reviewerSpec,
  type ReviewerId, type VerificationLevel,
} from '@diffwise/core';
import type { ServerContext } from '../server';
import { AuditLog, withAudit } from './audit';

const RESPONSE_SCHEMA = '2.0';
const MAX_FINDING_TEXT = 400;

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function json(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }, null, 2) }], isError: true };
}

function brief(f: {
  id: string; title: string; severity: string; category: string; file: string;
  range: { start: number; end: number }; verification?: { status: string };
}): Record<string, unknown> {
  return {
    id: f.id,
    title: f.title.slice(0, MAX_FINDING_TEXT),
    severity: f.severity,
    category: f.category,
    file: f.file,
    lines: `${f.range.start}-${f.range.end}`,
    verification: f.verification?.status ?? 'UNVERIFIED',
  };
}

export function registerPlatformTools(server: McpServer, ctx: ServerContext): void {
  const audit = new AuditLog(ctx.root);
  const policyLayers = async () => {
    const { loadPolicyFiles } = await import('@diffwise/app');
    return loadPolicyFiles(ctx.root);
  };

  const register = <S extends z.ZodRawShape>(
    name: string,
    meta: { title: string; description: string; inputSchema: S; readOnly: boolean },
    // Tool arguments are validated by the Zod schema before the handler runs;
    // typing them as `any` here keeps each handler readable and the schema is
    // the single source of truth for the shape.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (args: any) => Promise<ToolResult>,
  ): void => {
    server.registerTool(
      name,
      {
        title: meta.title,
        description: `${meta.description} Interface v2.`,
        inputSchema: meta.inputSchema,
        annotations: { readOnlyHint: meta.readOnly, openWorldHint: false, ...(meta.readOnly ? {} : { destructiveHint: false }) },
      },
      withAudit(audit, name, handler as (args: never) => Promise<unknown>) as never,
    );
  };

  // ---------------------------------------------------------------- review ---

  register('get_review_status', {
    title: 'Get review pipeline status',
    description: 'Return every pipeline stage with its status, duration, detail and metrics, plus the reviewer runs. Use this to render progress without inventing state.',
    readOnly: true,
    inputSchema: { reviewId: z.string().optional().describe('Defaults to the latest review.') },
  }, async (args) => {
    const report = args.reviewId ? await ctx.service.loadReview(args.reviewId) : await ctx.service.latestReview();
    if (!report) return fail('No review exists yet. Run run_review first.');
    return json({
      schemaVersion: RESPONSE_SCHEMA,
      reviewId: report.id,
      state: report.state ?? 'PENDING',
      completeness: report.summary.completeness,
      stages: report.stages.map((s) => ({
        id: s.id, label: s.label, status: s.status, durationMs: s.durationMs ?? null,
        detail: s.detail ?? null, error: s.error ?? null, metrics: s.metrics ?? null,
      })),
      reviewers: (report.review?.reviewerRuns ?? []).map((r) => ({
        id: r.reviewerId, status: r.status, selectedBecause: r.selectedBecause,
        findings: r.accepted, evidenceRejected: r.evidenceRejected,
        durationMs: r.durationMs ?? null, tokens: r.tokens, model: r.model ?? null,
        error: r.error ?? null, skippedReason: r.skippedReason ?? null,
      })),
      verification: report.review?.verification ?? null,
      plan: report.review?.plan ?? null,
    });
  });

  register('get_review_findings', {
    title: 'List review findings with verification status',
    description: 'Return findings filtered by severity, category, verification status or file. Every entry carries its verification verdict so an agent can tell a demonstrated defect from a lead.',
    readOnly: true,
    inputSchema: {
      reviewId: z.string().optional(),
      severity: z.string().optional().describe('critical|high|medium|low|info'),
      category: z.string().optional(),
      verification: z.string().optional().describe('CONFIRMED|LIKELY|UNVERIFIED|REJECTED|DISPUTED'),
      file: z.string().optional(),
      limit: z.number().int().positive().max(200).optional(),
    },
  }, async (args) => {
    const report = args.reviewId ? await ctx.service.loadReview(args.reviewId) : await ctx.service.latestReview();
    if (!report) return fail('No review exists yet. Run run_review first.');
    let findings = report.findings;
    if (args.severity) findings = findings.filter((f) => f.severity === args.severity);
    if (args.category) findings = findings.filter((f) => f.category === args.category);
    if (args.file) findings = findings.filter((f) => f.file === args.file);
    if (args.verification) findings = findings.filter((f) => (f.verification?.status ?? 'UNVERIFIED') === args.verification);
    const limit = args.limit ?? 50;
    return json({
      schemaVersion: RESPONSE_SCHEMA,
      reviewId: report.id,
      total: findings.length,
      returned: Math.min(limit, findings.length),
      findings: findings.slice(0, limit).map(brief),
      withheld: (report.withheldFindings ?? []).length,
      note: 'Withheld findings failed the published verification floor; they are not listed here.',
    });
  });

  register('get_finding_details', {
    title: 'Get one finding with evidence and verification',
    description: 'Return the full finding: exact evidence with file/line, root cause, impact, reproduction, recommendation, verification checks and verifier opinions.',
    readOnly: true,
    inputSchema: { findingId: z.string() },
  }, async (args) => {
    const { report, finding } = await ctx.service.findByFinding(args.findingId);
    return json({
      schemaVersion: RESPONSE_SCHEMA,
      reviewId: report.id,
      finding: {
        ...finding,
        evidence: finding.evidence.map((e) => ({
          kind: e.kind, file: e.file ?? null, line: e.line ?? null,
          snippet: e.snippet ? e.snippet.slice(0, 600) : null, note: e.note, source: e.source,
        })),
      },
      verification: finding.verification ?? null,
      fixes: report.fixes.filter((f) => f.findingId === finding.id).map((f) => ({
        id: f.id, label: f.label, complexity: f.complexity, applies: f.patch?.validation.applies ?? null,
      })),
    });
  });

  register('get_review_risk', {
    title: 'Get risk factors and approval requirement',
    description: 'Return the risk score with every contributing factor, plus the approval requirement the policy derives from it. The score is always accompanied by its factors.',
    readOnly: true,
    inputSchema: { reviewId: z.string().optional() },
  }, async (args) => {
    const report = args.reviewId ? await ctx.service.loadReview(args.reviewId) : await ctx.service.latestReview();
    if (!report) return fail('No review exists yet.');
    return json({
      schemaVersion: RESPONSE_SCHEMA,
      reviewId: report.id,
      risk: report.risk,
      approvals: report.approvals ?? null,
      state: report.state ?? 'PENDING',
      note: 'Approval requirements are recommendations plus a gate. DiffWise never merges and never authorises a merge.',
    });
  });

  register('get_review_coverage', {
    title: 'Get what the review actually covered',
    description: 'Return the analysis coverage: rules that ran, failed or were suppressed, reviewers that were selected and skipped, and any truncation. Use it to judge how complete a review is.',
    readOnly: true,
    inputSchema: { reviewId: z.string().optional() },
  }, async (args) => {
    const report = args.reviewId ? await ctx.service.loadReview(args.reviewId) : await ctx.service.latestReview();
    if (!report) return fail('No review exists yet.');
    const runs = report.review?.ruleRuns ?? [];
    return json({
      schemaVersion: RESPONSE_SCHEMA,
      reviewId: report.id,
      completeness: report.summary.completeness,
      completenessNote: report.summary.completenessNote ?? null,
      filesChanged: report.changes.length,
      filesIndexed: report.execution.indexedFiles,
      rules: {
        total: runs.length,
        ran: runs.filter((r) => r.status === 'ran').length,
        disabled: runs.filter((r) => r.status === 'disabled').length,
        failed: runs.filter((r) => r.status === 'failed').map((r) => ({ id: r.id, error: r.error ?? null })),
        skipped: runs.filter((r) => r.status === 'skipped').map((r) => ({ id: r.id, reason: r.reason ?? null })),
      },
      reviewers: report.review?.plan.reviewers ?? [],
      reviewerPlanTruncated: report.review?.plan.truncated ?? false,
    });
  });

  // ----------------------------------------------------------- verification ---

  register('verify_finding', {
    title: 'Re-verify one finding',
    description: 'Re-run the deterministic verification checks for a finding against the current working tree and record the new verdict. Static evidence only: this never claims a runtime result.',
    readOnly: false,
    inputSchema: { findingId: z.string() },
  }, async (args) => {
    const { report, finding } = await ctx.service.findByFinding(args.findingId);
    const files = new Map<string, string>();
    const gitRoot = ctx.root;
    for (const change of report.changes) {
      try {
        files.set(change.path, await readFile(join(gitRoot, change.path), 'utf8'));
      } catch {
        // A deleted file stays absent; the checks report that honestly.
      }
    }
    const addedLines = new Map<string, Set<number>>();
    for (const change of report.changes) {
      const set = new Set<number>();
      for (const hunk of change.hunks) for (const line of hunk.lines) if (line.kind === 'add' && line.newLine !== undefined) set.add(line.newLine);
      addedLines.set(change.path, set);
    }
    const result = runDeterministicVerification({
      findings: [finding],
      context: contextFromReport(report, files, undefined, addedLines, new Set(report.changes.map((c) => c.path))),
      minimumStatus: 'UNVERIFIED',
    });
    const updated = result.findings[0] ?? result.withheld[0];
    return json({
      schemaVersion: RESPONSE_SCHEMA,
      reviewId: report.id,
      findingId: args.findingId,
      verification: updated?.verification ?? null,
      note: 'Re-verified against the current file content. A CONFIRMED verdict requires static, test, runtime or human evidence.',
    });
  });

  register('verify_review', {
    title: 'Re-verify every finding in a review',
    description: 'Re-run deterministic verification for the whole review and return the verdict distribution. Does not modify the stored review.',
    readOnly: true,
    inputSchema: { reviewId: z.string().optional() },
  }, async (args) => {
    const report = args.reviewId ? await ctx.service.loadReview(args.reviewId) : await ctx.service.latestReview();
    if (!report) return fail('No review exists yet.');
    const files = new Map<string, string>();
    for (const change of report.changes) {
      try {
        files.set(change.path, await readFile(join(ctx.root, change.path), 'utf8'));
      } catch { /* deleted */ }
    }
    const addedLines = new Map<string, Set<number>>();
    for (const change of report.changes) {
      const set = new Set<number>();
      for (const hunk of change.hunks) for (const line of hunk.lines) if (line.kind === 'add' && line.newLine !== undefined) set.add(line.newLine);
      addedLines.set(change.path, set);
    }
    const result = runDeterministicVerification({
      findings: report.findings,
      context: contextFromReport(report, files, undefined, addedLines, new Set(report.changes.map((c) => c.path))),
      minimumStatus: 'UNVERIFIED',
    });
    return json({ schemaVersion: RESPONSE_SCHEMA, reviewId: report.id, summary: result.summary, verdicts: result.verdicts });
  });

  // ---------------------------------------------------------------- context ---
  // Note: `search_project_knowledge` already exists in interface v1 and is not
  // re-registered here. A duplicate name makes the whole server fail to start,
  // which is the correct behaviour for an interface contract collision.

  register('get_affected_components', {
    title: 'Get affected components and impact depth',
    description: 'Return the modules the change touches and every file impacted transitively, with depth. Edges marked verified come from resolved imports; inferred edges are labelled.',
    readOnly: true,
    inputSchema: { reviewId: z.string().optional() },
  }, async (args) => {
    const report = args.reviewId ? await ctx.service.loadReview(args.reviewId) : await ctx.service.latestReview();
    if (!report) return fail('No review exists yet.');
    return json({
      schemaVersion: RESPONSE_SCHEMA,
      changedFiles: report.changes.map((c) => c.path),
      modules: report.architecture.graph.modules.map((m) => ({ id: m.id, name: m.name, files: m.files.length, changed: m.changed })),
      directlyImpacted: report.architecture.graph.directlyImpacted,
      indirectlyImpacted: report.architecture.graph.indirectlyImpacted,
      cycles: report.architecture.graph.cycles,
      boundaryChanges: report.architecture.graph.boundaryChanges,
    });
  });

  register('get_related_tests', {
    title: 'Get tests related to the change',
    description: 'Return the test files that cover the changed files or symbols, plus the gaps the analyser found. Coverage here is resolved by path and import, not by runtime coverage.',
    readOnly: true,
    inputSchema: { reviewId: z.string().optional() },
  }, async (args) => {
    const report = args.reviewId ? await ctx.service.loadReview(args.reviewId) : await ctx.service.latestReview();
    if (!report) return fail('No review exists yet.');
    return json({
      schemaVersion: RESPONSE_SCHEMA,
      testFiles: report.tests.files.map((t) => ({ path: t.path, framework: t.framework, targets: t.targets, tests: t.testCount })),
      uncoveredChanges: report.tests.uncoveredChanges,
      uncoveredSymbols: report.tests.uncoveredSymbols,
      deletedTests: report.tests.deletedTests,
      execution: report.tests.execution ?? null,
      note: 'Uncovered means no test file references the changed file or symbol. It is a signal, not proof of missing coverage.',
    });
  });

  register('get_relevant_documentation', {
    title: 'Get documentation affected by the change',
    description: 'Return documents whose references the change invalidates, with the code and document evidence for each finding.',
    readOnly: true,
    inputSchema: { reviewId: z.string().optional() },
  }, async (args) => {
    const report = args.reviewId ? await ctx.service.loadReview(args.reviewId) : await ctx.service.latestReview();
    if (!report) return fail('No review exists yet.');
    return json({
      schemaVersion: RESPONSE_SCHEMA,
      documents: report.documentation.files.map((d) => ({ path: d.path, kind: d.kind, title: d.title ?? null, references: d.references.length })),
      findings: report.documentation.findings.map((f) => ({
        id: f.id, document: f.document, status: f.status, title: f.title,
        reason: f.reason, suggestedUpdate: f.suggestedUpdate,
      })),
    });
  });

  // ------------------------------------------------------------------ rules ---

  register('list_rule_packs', {
    title: 'List installed rule packs',
    description: 'Return every installed rule pack with its version, rule count and any dependency problem.',
    readOnly: true,
    inputSchema: {},
  }, async () => {
    const { buildPlatform } = await import('@diffwise/app');
    const platform = await buildPlatform({ root: ctx.root });
    return json({
      schemaVersion: RESPONSE_SCHEMA,
      packs: platform.rulePacks.map((p) => ({
        id: p.id, name: p.name, version: p.version, rules: p.rules.length,
        requires: p.requires ?? [], blocked: p.blocked ?? null, path: p.path,
      })),
      builtinRules: RULES.length,
      problems: platform.problems,
    });
  });

  register('get_rule_details', {
    title: 'Get one rule definition',
    description: 'Return a rule with its detection, evidence policy, provenance and any policy override or suppression that applies to it.',
    readOnly: true,
    inputSchema: { ruleId: z.string() },
  }, async (args) => {
    const { buildPlatform } = await import('@diffwise/app');
    const platform = await buildPlatform({ root: ctx.root });
    const rule = listRules({ builtinRules: RULES, packs: platform.rulePacks, policy: platform.policy }).find((r) => r.id === args.ruleId);
    if (!rule) return fail(`No rule "${args.ruleId}". Call list_rule_packs or list rules via the CLI.`);
    return json({
      schemaVersion: RESPONSE_SCHEMA,
      rule,
      severityOverride: platform.policy.rules.severityOverride[args.ruleId] ?? null,
      suppression: platform.policy.rules.suppress.find((s) => s.ruleId === args.ruleId) ?? null,
      enabled: platform.policy.rules.enable[args.ruleId] ?? rule.enabled,
    });
  });

  register('validate_rule', {
    title: 'Validate a rule definition or pack directory',
    description: 'Validate rule YAML/JSON (as an object or a pack directory inside the repository) and return every error and warning with the file that caused it.',
    readOnly: true,
    inputSchema: {
      directory: z.string().optional().describe('Repository-relative pack directory. Omit to validate the definition object.'),
      definition: z.record(z.string(), z.unknown()).optional().describe('A rule definition to validate inline.'),
    },
  }, async (args) => {
    const { validateRuleDefinition, loadRulePacks } = await import('@diffwise/core');
    if (args.directory) {
      const loaded = await loadRulePacks([join(ctx.root, args.directory)]);
      return json({
        schemaVersion: RESPONSE_SCHEMA,
        packs: loaded.packs.map((p) => ({ id: p.id, version: p.version, rules: p.rules.map((r) => r.id), blocked: p.blocked ?? null })),
        issues: loaded.issues,
        ok: loaded.issues.every((i) => i.level !== 'error'),
      });
    }
    if (!args.definition) return fail('Provide either directory or definition.');
    const issues: Array<{ level: string; path: string; message: string }> = [];
    const rule = validateRuleDefinition(args.definition, '<inline>', { pack: 'inline' }, issues as never);
    return json({ schemaVersion: RESPONSE_SCHEMA, ok: Boolean(rule) && issues.every((i) => i.level !== 'error'), rule, issues });
  });

  register('explain_rule', {
    title: 'Explain why a rule did or did not fire',
    description: 'Return a rule\'s execution record from a review: whether it ran, how many findings it produced, how long it took and any error.',
    readOnly: true,
    inputSchema: { ruleId: z.string(), reviewId: z.string().optional() },
  }, async (args) => {
    const report = args.reviewId ? await ctx.service.loadReview(args.reviewId) : await ctx.service.latestReview();
    if (!report) return fail('No review exists yet.');
    const record = (report.review?.ruleRuns ?? []).find((r) => r.id === args.ruleId);
    if (!record) return fail(`Rule "${args.ruleId}" was not part of this review. Call get_review_coverage for the rule list.`);
    return json({ schemaVersion: RESPONSE_SCHEMA, reviewId: report.id, record });
  });

  register('get_effective_policy', {
    title: 'Get the effective review policy',
    description: 'Return the resolved policy plus, for each field, which layer supplied it (organization, repository, directory, file or default).',
    readOnly: true,
    inputSchema: { paths: z.array(z.string()).optional().describe('Changed paths used to select directory and file layers.') },
  }, async (args) => {
    const files = await policyLayers();
    const effective = resolvePolicy(files.layers, args.paths ?? []);
    return json({
      ...snapshotPolicy(effective),
      problems: files.problems,
      note: 'Precedence is organization → repository → directory → file. Arrays append; objects merge.',
    });
  });

  // ----------------------------------------------------------- verification ---

  register('discover_test_commands', {
    title: 'Discover verification commands',
    description: 'Read the repository manifests and return the commands it declares: test, typecheck, lint, build, e2e, security. Nothing is executed.',
    readOnly: true,
    inputSchema: {},
  }, async () => {
    const { GitClient } = await import('@diffwise/core');
    const git = new GitClient(ctx.root);
    const paths = await git.listWorktreeFiles();
    const files = new Map<string, string>();
    for (const path of paths.filter((p) => /^(package\.json|Makefile|pyproject\.toml|pytest\.ini|setup\.cfg|pom\.xml|build\.gradle(\.kts)?|go\.mod|Cargo\.toml|composer\.json|Gemfile\.lock|tsconfig\.json|.*lock.*)$/.test(p))) {
      try {
        files.set(path, await readFile(join(ctx.root, path), 'utf8'));
      } catch { /* unreadable */ }
    }
    const commands = discoverCommands({ files, changedFiles: [] });
    return json({
      schemaVersion: RESPONSE_SCHEMA,
      commands,
      note: 'Commands come from repository manifests or policy, never from a model. Execution still requires approval.',
    });
  });

  register('get_verification_plan', {
    title: 'Get a verification plan',
    description: 'Return the commands that would run for this review, their level, timeout, approval requirement and whether they can be isolated. Nothing is executed.',
    readOnly: true,
    inputSchema: {
      reviewId: z.string().optional(),
      levels: z.array(z.string()).optional().describe('static|typecheck|lint|build|unit|integration|contract|e2e|security|custom'),
      findingId: z.string().optional().describe('Build a reproduction plan for one finding.'),
    },
  }, async (args) => {
    const report = args.reviewId ? await ctx.service.loadReview(args.reviewId) : await ctx.service.latestReview();
    if (!report) return fail('No review exists yet.');
    const { GitClient } = await import('@diffwise/core');
    const git = new GitClient(ctx.root);
    const paths = await git.listWorktreeFiles();
    const files = new Map<string, string>();
    for (const path of paths.filter((p) => /^(package\.json|Makefile|pyproject\.toml|pom\.xml|build\.gradle(\.kts)?|go\.mod|Cargo\.toml|tsconfig\.json|.*lock.*)$/.test(p))) {
      try { files.set(path, await readFile(join(ctx.root, path), 'utf8')); } catch { /* skip */ }
    }
    const files_ = await policyLayers().catch(() => ({ layers: [] as never[] }));
    const policy = resolvePolicy(files_.layers).policy;
    const base = {
      files,
      changedFiles: report.changes.map((c) => c.path),
      testFiles: report.tests.files.map((t) => ({ path: t.path, framework: t.framework })),
      policyCommands: policy.verification.commands,
      requireApproval: policy.verification.requireApproval,
      sandbox: policy.verification.sandbox,
      defaultTimeoutMs: policy.verification.defaultTimeoutMs,
      ...(args.levels ? { levels: args.levels as VerificationLevel[] } : {}),
    };
    const plan = args.findingId
      ? buildReproductionPlan(base, (() => {
        const finding = report.findings.find((f) => f.id === args.findingId);
        return finding ? { file: finding.file, title: finding.title } : { file: '', title: args.findingId };
      })())
      : buildVerificationPlan(base);
    return json({ schemaVersion: RESPONSE_SCHEMA, reviewId: report.id, plan });
  });

  register('get_verification_result', {
    title: 'Get recorded verification runs',
    description: 'Return every verification command that actually ran for a review, with the real command, exit code, duration and output tail. Empty means nothing has run.',
    readOnly: true,
    inputSchema: { reviewId: z.string().optional(), findingId: z.string().optional() },
  }, async (args) => {
    const report = args.reviewId ? await ctx.service.loadReview(args.reviewId) : await ctx.service.latestReview();
    if (!report) return fail('No review exists yet.');
    const records = report.verification.filter((r) => (args.findingId ? r.findingId === args.findingId : true));
    return json({
      schemaVersion: RESPONSE_SCHEMA,
      reviewId: report.id,
      runs: records,
      configuredCommand: report.settings.verificationCommand ?? null,
      note: 'A passing run is a passing command, not proof that a specific finding is fixed.',
    });
  });

  // ------------------------------------------------------------ reviewers ---

  register('get_reviewer_plan', {
    title: 'Explain which reviewers run for a change',
    description: 'Return the reviewer selection for the latest review with the signals that produced it, including reviewers that were considered and rejected.',
    readOnly: true,
    inputSchema: { reviewId: z.string().optional() },
  }, async (args) => {
    const report = args.reviewId ? await ctx.service.loadReview(args.reviewId) : await ctx.service.latestReview();
    if (!report) return fail('No review exists yet.');
    // A deterministic-only review stored an empty plan; selection is still
    // computable and is what the caller is asking for.
    const stored = report.review?.plan;
    const plan = stored && stored.reviewers.length > 0 ? stored : selectReviewers({
      changes: report.changes,
      symbols: report.symbols,
      graph: report.architecture.graph,
      tests: report.tests,
      findings: report.findings,
      risk: { level: report.risk.level, score: report.risk.score },
    });
    return json({
      schemaVersion: RESPONSE_SCHEMA,
      reviewId: report.id,
      plan,
      explanation: explainPlan(plan).slice(0, 60),
      source: stored && stored.reviewers.length > 0 ? 'stored review' : 'computed for this review',
    });
  });

  register('explain_reviewer', {
    title: 'Explain a reviewer specification',
    description: 'Return a reviewer\'s instructions: what it looks for, what it must avoid, its languages and its budget.',
    readOnly: true,
    inputSchema: { reviewerId: z.string() },
  }, async (args) => {
    const id = args.reviewerId as ReviewerId;
    if (!(id in { correctness: 1, security: 1, concurrency: 1, database: 1, architecture: 1, performance: 1, tests: 1, 'business-logic': 1 })) {
      return fail(`Unknown reviewer "${args.reviewerId}".`);
    }
    return json({ schemaVersion: RESPONSE_SCHEMA, reviewer: reviewerSpec(id) });
  });

  // --------------------------------------------------------------- humans ---

  register('record_human_decision', {
    title: 'Record a human decision (not an AI decision)',
    description: 'Append a human decision to a review. actorKind must be "human" for an approval to count; an AI or CI actor is recorded but never satisfies an approval requirement. reject/false-positive/block require a rationale.',
    readOnly: false,
    inputSchema: {
      reviewId: z.string(),
      findingId: z.string().optional(),
      action: z.enum(['accept', 'reject', 'false-positive', 'request-evidence', 'approve-fix', 'reject-fix', 'approve-review', 'request-changes', 'block']),
      actor: z.string().min(1).describe('Person making the decision.'),
      actorKind: z.enum(['human', 'ai', 'ci']).default('human'),
      role: z.string().optional().describe('Reviewer role, matched against policy requiredRoles.'),
      rationale: z.string().optional(),
      aiRecommendation: z.string().optional().describe('What the AI suggested, kept separate from the decision.'),
    },
  }, async (args) => {
    if (['reject', 'false-positive', 'block', 'request-changes'].includes(args.action) && (!args.rationale || args.rationale.trim().length < 8)) {
      return fail(`A "${args.action}" decision requires a rationale of at least 8 characters.`);
    }
    const result = await ctx.service.recordDecision({
      reviewId: args.reviewId,
      ...(args.findingId ? { findingId: args.findingId } : {}),
      action: args.action,
      actor: args.actor,
      actorKind: args.actorKind,
      ...(args.role ? { role: args.role } : {}),
      rationale: args.rationale ?? '',
      ...(args.aiRecommendation ? { aiRecommendation: args.aiRecommendation } : {}),
    });
    return json({ schemaVersion: RESPONSE_SCHEMA, ...result });
  });

  register('get_review_history', {
    title: 'Get review history and decisions',
    description: 'Return stored reviews in order plus the decisions recorded against a review. Use it to answer "what changed since the last review".',
    readOnly: true,
    inputSchema: { limit: z.number().int().positive().max(50).optional(), reviewId: z.string().optional() },
  }, async (args) => {
    const history = await ctx.service.listReviews(args.limit ?? 10);
    const report = args.reviewId ? await ctx.service.loadReview(args.reviewId) : await ctx.service.latestReview();
    return json({
      schemaVersion: RESPONSE_SCHEMA,
      history: history.map((h) => ({ id: h.id, createdAt: h.createdAt, target: h.targetLabel, findings: h.findings, risk: h.riskLevel })),
      decisions: report?.decisions ?? [],
      state: report?.state ?? null,
    });
  });

  register('submit_finding_feedback', {
    title: 'Record feedback about a finding',
    description: 'Record whether a finding was a true positive, false positive, fixed or escaped. Feedback is stored as an agent record so evaluation can use it later; it does not change any rule or threshold.',
    readOnly: false,
    inputSchema: {
      findingId: z.string(),
      outcome: z.enum(['accepted', 'rejected', 'false-positive', 'confirmed', 'fixed', 'reopened', 'escaped']),
      note: z.string().min(3).optional(),
      actor: z.string().optional(),
    },
  }, async (args) => {
    const { report, finding } = await ctx.service.findByFinding(args.findingId);
    const event = {
      type: 'verification' as const,
      title: `Finding ${args.findingId}: ${args.outcome}`,
      detail: args.note ?? `Feedback recorded as ${args.outcome}.`,
      files: [finding.file],
      ...(args.actor ? { actor: args.actor } : {}),
      status: args.outcome,
      metadata: { findingId: args.findingId, reviewId: report.id, ruleId: finding.ruleId },
    };
    await ctx.service.recordEvent(event);
    return json({
      schemaVersion: RESPONSE_SCHEMA,
      ok: true,
      findingId: args.findingId,
      recorded: args.outcome,
      note: 'Feedback is stored for evaluation. It never silently changes a rule or a policy.',
    });
  });
}

export { AuditLog };
