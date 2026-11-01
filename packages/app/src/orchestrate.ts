/**
 * Review orchestration for the application layer.
 *
 * Builds the platform hooks that the core pipeline calls:
 *
 *   policy + rule packs  → core pipeline (stages 1–7)
 *   specialized reviewers → AI session       (stage 8)
 *   independent verification → core engine   (stage 10)
 *
 * Everything here degrades: no provider means reviewers are skipped and the
 * deterministic report still ships; a broken policy file becomes a recorded
 * layer error; a rule pack that fails to load is reported by name.
 */
import {
  DEFAULT_POLICY, resolvePolicy, snapshotPolicy, verificationSummary,
  loadRepositoryRulePacks, reviewerSpec, prepareVerification, finalizeVerification,
  type EffectivePolicy, type Finding, type LoadedRulePack, type ReviewPolicy, type VerificationOutcome,
  type VerificationStatus, type VerificationContext, type VerifyHookResult,
} from '@diffwise/core';
import { ReviewSession, type LlmProvider } from '@diffwise/ai';
import { loadPolicyFiles, type PolicyFileProblem } from './policyFile';

export interface PlatformBuildInput {
  root: string;
  provider?: LlmProvider;
  fastProvider?: LlmProvider;
  /** Paths to extra rule packs (in addition to `.diffwise/rules`). */
  rulePackPaths?: string[];
  /** Per-reviewer wall-clock limit, from configuration. */
  reviewerTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  log?(message: string): void;
}

export interface Platform {
  policy: ReviewPolicy;
  effective: EffectivePolicy;
  policySnapshot: ReturnType<typeof snapshotPolicy>;
  rulePacks: LoadedRulePack[];
  /** Problems that must be reported, even when the review succeeds. */
  problems: Array<{ path: string; message: string }>;
  session?: ReviewSession;
}

export async function buildPlatform(input: PlatformBuildInput): Promise<Platform> {
  const problems: Array<{ path: string; message: string }> = [];

  const files = await loadPolicyFiles(input.root, input.env ?? process.env);
  for (const problem of files.problems as PolicyFileProblem[]) problems.push({ path: problem.path, message: problem.message });

  const effective = resolvePolicy(files.layers);
  for (const warning of effective.warnings) problems.push({ path: 'policy', message: warning });
  for (const layer of effective.layers) {
    if (layer.error) problems.push({ path: layer.source, message: `layer not applied: ${layer.error}` });
  }

  let rulePacks: LoadedRulePack[] = [];
  try {
    const loaded = await loadRepositoryRulePacks(input.root, input.rulePackPaths ?? []);
    rulePacks = loaded.packs;
    for (const issue of loaded.issues) {
      problems.push({ path: issue.path, message: `${issue.level}: ${issue.message}` });
    }
    for (const pack of loaded.packs) {
      if (pack.blocked) problems.push({ path: pack.path, message: `rule pack ${pack.id} blocked: ${pack.blocked}` });
    }
  } catch (err) {
    problems.push({ path: '.diffwise/rules', message: `rule packs could not be loaded: ${(err as Error).message}` });
  }

  const session = input.provider
    ? new ReviewSession({
      provider: input.provider,
      ...(input.fastProvider ? { verifierProvider: input.fastProvider } : {}),
      ...(input.reviewerTimeoutMs ? { reviewerTimeoutMs: input.reviewerTimeoutMs } : {}),
    })
    : undefined;

  return {
    policy: effective.policy,
    effective,
    policySnapshot: snapshotPolicy(effective),
    rulePacks,
    problems,
    ...(session ? { session } : {}),
  };
}

/** A policy with only the built-in defaults, for reviews that must not read files. */
export function defaultPlatform(): Platform {
  const effective = resolvePolicy([]);
  return {
    policy: effective.policy,
    effective,
    policySnapshot: snapshotPolicy(effective),
    rulePacks: [],
    problems: [],
  };
}

/**
 * Attach verification outcomes to findings.
 *
 * Grouping during verification is not identical to deduplication during
 * correlation, so mapping is by finding id first and by location second. A
 * finding that no group covers gets an explicit UNVERIFIED verdict rather than
 * silently inheriting one.
 */
export function attachVerification(findings: Finding[], outcomes: VerificationOutcome[], now = new Date()): Finding[] {
  const byMember = new Map<string, VerificationOutcome>();
  for (const outcome of outcomes) {
    for (const member of outcome.group.members) byMember.set(member.finding.id, outcome);
  }

  return findings.map((finding) => {
    let outcome = byMember.get(finding.id);
    if (!outcome) {
      outcome = outcomes.find((o) =>
        o.group.file === finding.file
        && o.group.range.start <= finding.range.end
        && finding.range.start <= o.group.range.end
        && o.group.category === finding.category);
    }
    if (!outcome) {
      return {
        ...finding,
        verification: {
          status: 'UNVERIFIED' as VerificationStatus,
          method: 'No verification group covered this finding; nothing was checked.',
          policy: 'default/v1',
          checks: [],
          verifiers: [],
          evidenceClasses: { static: 0, model: 0, test: 0, runtime: 0, human: 0 },
          confidence: 'low' as const,
          severity: { original: finding.severity, effective: finding.severity, reason: 'Not verified, severity unchanged.' },
          history: [{ at: now.toISOString(), status: 'UNVERIFIED' as VerificationStatus, trigger: 'review' as const, note: 'no verification group' }],
          notes: ['This finding was produced but never verified. Treat it as a lead, not a defect.'],
          reproducible: true,
        },
      };
    }
    const verification = outcome.verification;
    const adjusted = verification.severity.effective !== finding.severity;
    return {
      ...finding,
      severity: verification.severity.effective,
      ...(adjusted ? { severityAssessed: finding.severity } : {}),
      confidence: verification.confidence,
      verification,
    };
  });
}

/** Filter findings by the policy's published minimum verification status. */
export function publishFindings(findings: Finding[], policy: ReviewPolicy): { published: Finding[]; withheld: Finding[] } {
  const minimum = policy.verification.minimumStatus;
  const rank: Record<VerificationStatus, number> = { CONFIRMED: 0, LIKELY: 1, DISPUTED: 2, UNVERIFIED: 3, REJECTED: 4 };
  const published: Finding[] = [];
  const withheld: Finding[] = [];
  for (const finding of findings) {
    const status = finding.verification?.status;
    if (!status) { published.push(finding); continue; }
    if (rank[status] <= rank[minimum]) published.push(finding);
    else withheld.push(finding);
  }
  return { published, withheld };
}

/**
 * Deterministic verification, with no model involved.
 *
 * This is what runs when no provider is configured, and it is the same engine
 * the AI path finalises with — an opinion from a model is an input to this
 * policy, not a replacement for it.
 */
export function verifyDeterministically(input: {
  report: import('@diffwise/core').ReviewReport;
  repoFiles: Map<string, string>;
  oldContents?: Map<string, string | null>;
  addedLines: Map<string, Set<number>>;
  changedFiles: Set<string>;
  policy: ReviewPolicy;
  verificationPolicy?: Partial<import('@diffwise/core').VerificationPolicy>;
}): VerifyHookResult {
  const t0 = Date.now();
  const candidates = input.report.findings.map((finding) => ({
    producer: finding.source === 'deterministic' ? `rule:${finding.ruleId}` : `reviewer:${finding.reviewerId ?? 'unknown'}`,
    finding: {
      id: finding.id, title: finding.title, description: finding.description, severity: finding.severity,
      category: finding.category, kind: finding.kind, confidence: finding.confidence, file: finding.file,
      range: finding.range, evidence: finding.evidence, recommendation: finding.recommendation,
      ruleId: finding.ruleId, source: finding.source, tags: finding.tags,
    },
  }));
  const ctx: VerificationContext = {
    files: input.repoFiles,
    ...(input.oldContents ? { oldFiles: input.oldContents } : {}),
    addedLines: input.addedLines,
    changedFiles: input.changedFiles,
    executions: input.report.verification.map((record) => ({
      id: record.id,
      ...(record.findingId ? { findingId: record.findingId } : {}),
      command: record.execution.command,
      status: record.execution.status,
      exitCode: record.execution.exitCode,
      at: record.at,
    })),
    ...(input.report.decisions?.length
      ? { humanDecisions: input.report.decisions.map((d) => ({ findingId: d.findingId ?? '', action: d.action, actor: d.actor, at: d.at, rationale: d.rationale })) }
      : {}),
  };
  const prepared = prepareVerification(candidates, ctx);
  const outcomes = finalizeVerification(prepared, ctx, {
    policy: { aiVerification: false, ...input.verificationPolicy, minimumStatus: input.policy.verification.minimumStatus },
  });
  const withVerification = attachVerification(input.report.findings, outcomes);
  const { published, withheld } = publishFindings(withVerification, input.policy);
  const summary = verificationSummary(outcomes);
  return {
    findings: published,
    ...(withheld.length ? { withheld } : {}),
    summary: { performed: true, policy: 'deterministic/v1', ...summary, durationMs: Date.now() - t0 },
    verdicts: outcomes.map((o) => ({ findingId: o.findingId, status: o.verification.status })),
    durationMs: Date.now() - t0,
  };
}

/** Human-readable problems for the CLI and the report banner. */
export function summariseProblems(problems: Array<{ path: string; message: string }>): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const problem of problems) {
    const key = `${problem.path}::${problem.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`${problem.path}: ${problem.message}`);
  }
  return lines;
}

export { DEFAULT_POLICY, reviewerSpec, verificationSummary };
export type { VerificationOutcome };
