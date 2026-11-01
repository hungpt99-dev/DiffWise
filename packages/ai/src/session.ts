/**
 * AI review session.
 *
 * The session owns the AI half of the pipeline and nothing else:
 *
 *   1. select reviewers for this change              (core, deterministic)
 *   2. run them concurrently with budgets            (core orchestrator)
 *   3. validate each proposal's evidence             (core, deterministic)
 *   4. decide which finding groups are worth an
 *      independent AI verification and run it        (core policy → ai verifiers)
 *
 * It never decides a verdict. Verdicts come from the core verification engine,
 * which treats a verifier opinion as one evidence class among five.
 */
import {
  REVIEWER_SPECS, buildVerificationPlan, finalizeVerification, locateQuote, prepareVerification,
  runReviewers, selectReviewers, stableId, validateProposalEvidence,
} from '@diffwise/core';
import type {
  Evidence, Finding, FindingGroup, PreparedVerification, ReviewPlan, ReviewPolicy, ReviewReport, ReviewerId,
  ReviewerProposal, ReviewerRun, ReviewerScopeInput, ReviewerSpec, SelectionInput, TokenUsage, VerificationContext,
  VerificationOutcome, VerificationPolicy, VerifierOpinion,
} from '@diffwise/core';
import { createReviewerAgents } from './reviewers/agent';
import { buildReviewerScope } from './reviewers/scope';
import { verifyIndependently } from './reviewers/verifier';
import { AiVerifier } from './reviewers/verifier';
import type { LlmProvider } from './types';

export interface ReviewSessionOptions {
  provider: LlmProvider;
  /** Separate provider for verification, when a cheaper model is configured. */
  verifierProvider?: LlmProvider;
  /** Per-reviewer model overrides. */
  models?: Partial<Record<string, string>>;
  /** Bounded concurrency across reviewers. */
  concurrency?: number;
  /** Hard cap on AI verification calls for one review. */
  maxVerificationCalls?: number;
  /**
   * Per-reviewer wall-clock limit. Defaults to each reviewer's own budget
   * (120s); raise it for reasoning models instead of silently losing a
   * reviewer to a timeout.
   */
  reviewerTimeoutMs?: number;
  /** Repository conventions injected into every reviewer prompt. */
  conventions?: string[];
}

export interface ReviewerStageInput {
  report: ReviewReport;
  repoFiles: Map<string, string>;
  policy?: ReviewPolicy;
  requirements?: Array<{ id: string; title: string; body: string; source: string }>;
  skills?: Map<string, { id: string; version: string; instructions: string }>;
  signal?: AbortSignal;
  log?(message: string): void;
}

export interface ReviewerStageResult {
  plan: ReviewPlan;
  runs: ReviewerRun[];
  findings: Finding[];
  rejected: Array<{ reviewerId: ReviewerId; title: string; reason: string }>;
  tokens: TokenUsage;
  durationMs: number;
  cancelled: boolean;
  skippedReason?: string;
}

export interface VerificationStageResult {
  prepared: PreparedVerification[];
  outcomes: VerificationOutcome[];
  /** Groups that received AI opinions. */
  verified: number;
  /** Groups skipped because a deterministic verdict already decides them. */
  skipped: number;
  /** Groups skipped because the call budget ran out. */
  deferred: number;
  opinions: number;
  durationMs: number;
}

export interface ReviewSessionResult {
  reviewers: ReviewerStageResult;
  verification?: VerificationStageResult;
}

function toFinding(
  proposal: ReviewerProposal,
  reviewerId: ReviewerId,
  repoFiles: Map<string, string>,
  run?: { model?: string },
): Finding {
  const evidence: Evidence[] = [];
  for (const item of proposal.evidence.slice(0, 4)) {
    const file = (item.file ?? proposal.file).replace(/^\.\//, '');
    const content = repoFiles.get(file);
    if (content === undefined) continue;
    const line = locateQuote(content, item.quote);
    if (line === null) continue;
    evidence.push({
      kind: file === proposal.file ? 'code' : 'diff',
      file,
      line,
      snippet: item.quote.split(/\r?\n/).slice(0, 6).join('\n').slice(0, 500),
      note: item.note ?? 'Quoted from the repository.',
      source: 'ai',
    });
  }
  return {
    id: stableId('ai', reviewerId, proposal.file, proposal.startLine, proposal.title),
    title: proposal.title,
    description: proposal.description,
    severity: proposal.severity,
    category: proposal.category,
    kind: proposal.kind,
    confidence: proposal.confidence,
    file: proposal.file,
    range: { start: proposal.startLine, end: proposal.endLine ?? proposal.startLine },
    evidence,
    whyItMatters: proposal.whyItMatters ?? proposal.description,
    consequences: proposal.consequences ?? [],
    ...(proposal.reproduction ? { reproduction: proposal.reproduction } : {}),
    recommendation: proposal.recommendation,
    ruleId: `reviewer:${reviewerId}`,
    source: 'ai',
    tags: [...(proposal.tags ?? []), `reviewer:${reviewerId}`],
    validated: true,
    reviewerId,
    ...(proposal.reasoning ? { reasoning: proposal.reasoning } : {}),
    ...(run?.model ? { model: run.model } : {}),
  };
}

export class ReviewSession {
  constructor(private readonly options: ReviewSessionOptions) {}

  /** Deterministic reviewer selection. Exposed so the CLI can explain a plan without a model. */
  plan(report: ReviewReport, policy?: ReviewPolicy, overrides: { maxReviewers?: number; fullSweep?: boolean } = {}): ReviewPlan {
    const selection: SelectionInput = {
      changes: report.changes,
      symbols: report.symbols,
      graph: report.architecture.graph,
      tests: report.tests,
      findings: report.findings,
      risk: { level: report.risk.level, score: report.risk.score },
      policy: {
        ...(policy ? { disabled: policy.reviewers.disabled, enabled: policy.reviewers.enabled } : {}),
        maxReviewers: overrides.maxReviewers ?? policy?.reviewers.maxReviewers ?? 3,
        fullSweep: overrides.fullSweep ?? policy?.reviewers.fullSweep ?? false,
        route: { provider: this.options.provider.id, model: this.options.provider.model },
      },
    };
    return selectReviewers(selection);
  }

  async runReviewers(input: ReviewerStageInput): Promise<ReviewerStageResult> {
    const plan = this.plan(input.report, input.policy);
    const t0 = Date.now();
    if (plan.reviewers.length === 0) {
      return {
        plan, runs: [], findings: [], rejected: [], tokens: { prompt: 0, completion: 0 }, durationMs: 0,
        cancelled: false, skippedReason: 'no reviewer was applicable to this change',
      };
    }
    const specs: ReviewerSpec[] = plan.reviewers.map((id) => REVIEWER_SPECS[id]);
    const agents = createReviewerAgents(specs, this.options.provider, {
      ...(this.options.models ? { models: this.options.models } : {}),
      ...(input.policy?.reviewers.skills.length ? {} : {}),
    });

    // Skills: resolve the first active skill for each reviewer, if any.
    const scopeCache = new Map<ReviewerId, ReviewerScopeInput & { redactions: number; truncated: boolean }>();
    const buildScope = (spec: ReviewerSpec): ReviewerScopeInput => {
      const cached = scopeCache.get(spec.id);
      if (cached) return cached;
      const skillId = input.policy?.reviewers.skills.find((id) => id.startsWith(`${spec.id}:`) || id === spec.id);
      const built = buildReviewerScope({
        report: input.report,
        repoFiles: input.repoFiles,
        spec,
        ...(input.requirements?.length
          ? {
            requirements: input.requirements.map((r) => ({
              id: r.id, title: r.title, body: r.body, source: r.source as 'document', fetchedAt: new Date().toISOString(), trusted: false as const,
            })),
          }
          : {}),
        ...(skillId && input.skills?.has(skillId) ? { skill: input.skills.get(skillId) } : {}),
      });
      if (built.truncated) input.log?.(`${spec.id}: context was truncated to fit the reviewer budget.`);
      if (built.redactions > 0) input.log?.(`${spec.id}: ${built.redactions} secret value(s) redacted before sending.`);
      scopeCache.set(spec.id, built);
      return built;
    };

    const result = await runReviewers({
      agents,
      plan,
      concurrency: this.options.concurrency ?? Math.min(3, plan.reviewers.length),
      ...(this.options.reviewerTimeoutMs ? { timeoutMs: this.options.reviewerTimeoutMs } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      scope: buildScope,
      accept: (spec, proposal) => validateProposalEvidence(proposal, input.repoFiles, locateQuote).ok
        ? { ok: true }
        : validateProposalEvidence(proposal, input.repoFiles, locateQuote),
      onUpdate: (runs) => {
        const running = runs.filter((r) => r.status === 'running').map((r) => r.reviewerId);
        if (running.length) input.log?.(`reviewers running: ${running.join(', ')}`);
      },
    });

    const findings = result.proposals.map(({ reviewerId, proposal }) => toFinding(
      proposal,
      reviewerId,
      input.repoFiles,
      result.runs.find((r) => r.reviewerId === reviewerId),
    ));
    return {
      plan,
      runs: result.runs,
      findings,
      rejected: result.rejected,
      tokens: result.tokens,
      durationMs: result.durationMs,
      cancelled: result.cancelled,
      ...(result.runs.every((r) => r.status === 'skipped') ? { skippedReason: 'every reviewer was skipped' } : {}),
      ...(Date.now() - t0 < 0 ? {} : {}),
    };
  }

  /**
   * Independent AI verification.
   *
   * Verifier effort is spent where it can change the answer: a finding that a
   * deterministic check already confirms or rejects is not sent to a model. That
   * is both a cost control and an honesty control — it stops a model from
   * overturning a demonstrated fact.
   */
  async verify(input: {
    report: ReviewReport;
    repoFiles: Map<string, string>;
    oldContents?: Map<string, string | null>;
    policy?: ReviewPolicy;
    verificationPolicy?: Partial<VerificationPolicy>;
    contexts: { addedLines: Map<string, Set<number>>; changedFiles: Set<string> };
    signal?: AbortSignal;
    log?(message: string): void;
  }): Promise<VerificationStageResult> {
    const t0 = Date.now();
    const policy = input.verificationPolicy ?? {};
    const minStatus = input.policy?.verification.minimumStatus ?? 'LIKELY';
    const independent = input.policy?.verification.independentVerifiers ?? 2;
    const budget = this.options.maxVerificationCalls ?? 12;

    const candidates = input.report.findings.map((finding) => ({
      producer: finding.source === 'deterministic' ? `rule:${finding.ruleId}` : `reviewer:${finding.reviewerId ?? 'unknown'}`,
      finding: {
        id: finding.id,
        title: finding.title,
        description: finding.description,
        severity: finding.severity,
        category: finding.category,
        kind: finding.kind,
        confidence: finding.confidence,
        file: finding.file,
        range: finding.range,
        evidence: finding.evidence,
        recommendation: finding.recommendation,
        ruleId: finding.ruleId,
        source: finding.source,
        tags: finding.tags,
      },
    }));

    const ctx: VerificationContext = {
      files: input.repoFiles,
      ...(input.oldContents ? { oldFiles: input.oldContents } : {}),
      addedLines: input.contexts.addedLines,
      changedFiles: input.contexts.changedFiles,
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
    // Preliminary verdict with no model opinions: this is what the checks alone say.
    const preliminary = finalizeVerification(prepared, ctx, { policy: { ...policy, minimumStatus: minStatus } });
    const preliminaryByKey = new Map(preliminary.map((o) => [o.group.key, o.verification.status]));

    const needsVerification = prepared.filter(({ group }) => {
      const status = preliminaryByKey.get(group.key);
      return status === 'LIKELY' || status === 'UNVERIFIED' || status === 'DISPUTED';
    });
    const selected = needsVerification.slice(0, budget);
    const deferred = needsVerification.length - selected.length;

    if (input.policy && input.policy.verification.aiVerification === false) {
      const outcomes = finalizeVerification(prepared, ctx, { policy: { ...policy, minimumStatus: minStatus } });
      return { prepared, outcomes, verified: 0, skipped: prepared.length, deferred: 0, opinions: 0, durationMs: Date.now() - t0 };
    }

    const provider = this.options.verifierProvider ?? this.options.provider;
    const opinionsByGroup = new Map<string, VerifierOpinion[]>();
    const limit = Math.max(1, Math.min(3, independent));

    // Bounded pool over groups; each group fans out to `limit` verifiers.
    const queue = [...selected];
    const workers = Array.from({ length: Math.min(3, Math.max(1, queue.length)) }, async () => {
      for (;;) {
        if (input.signal?.aborted) return;
        const next = queue.shift();
        if (!next) return;
        const group: FindingGroup = next.group;
        const content = input.repoFiles.get(group.file);
        if (content === undefined) continue;
        const opinions = await verifyIndependently(
          provider,
          {
            finding: {
              title: group.canonical.finding.title,
              description: group.canonical.finding.description,
              category: group.canonical.finding.category,
              kind: group.canonical.finding.kind,
              file: group.file,
              range: group.range,
              recommendation: group.canonical.finding.recommendation,
              evidence: group.evidence.slice(0, 6).map((e) => ({
                ...(e.file ? { file: e.file } : {}),
                ...(e.line !== undefined ? { line: e.line } : {}),
                ...(e.snippet ? { snippet: e.snippet } : {}),
                note: e.note,
              })),
            },
            fileContent: content.length > 24_000 ? content.slice(0, 24_000) : content,
            deterministicChecks: next.checks.map((c) => ({ id: c.id, outcome: c.outcome, detail: c.detail })),
          },
          limit,
          input.signal,
        );
        opinionsByGroup.set(group.key, opinions);
      }
    });
    await Promise.all(workers);

    const outcomes = finalizeVerification(prepared, ctx, { policy: { ...policy, minimumStatus: minStatus }, opinionsByGroup });
    const opinionCount = [...opinionsByGroup.values()].reduce((n, list) => n + list.length, 0);
    input.log?.(`verified ${opinionsByGroup.size} finding group(s) with ${opinionCount} independent opinion(s); ${prepared.length - needsVerification.length} decided by deterministic evidence alone.`);
    return {
      prepared,
      outcomes,
      verified: opinionsByGroup.size,
      skipped: prepared.length - needsVerification.length,
      deferred,
      opinions: opinionCount,
      durationMs: Date.now() - t0,
    };
  }
}

/** Sanity helper used by tests and the CLI: which verifier lenses exist. */
export { AiVerifier };
