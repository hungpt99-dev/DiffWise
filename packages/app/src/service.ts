/**
 * DiffWise application services.
 *
 * This is the only place where a review is run, persisted, discussed and
 * modified. The CLI, the MCP server, the report server and the VS Code
 * extension are thin adapters over this class — if a behaviour is missing here,
 * it does not exist in the product.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildReviewEnvelope, buildSarif, computeState, evaluateApproval, finalizeFindings, openStore, parsePatch,
  runReview, verificationSummary, DEFAULT_POLICY,
  EmptyReviewError, type AgentEvent, type AnalysisStage, type AppliedFix, type ApprovalStatus, type FixSolution,
  type Finding, type ReviewDecision, type ReviewEnvelope, type ReviewIndexEntry, type ReviewReport, type ReviewState,
  type ReviewStore, type ReviewTarget, type ReviewPlatformHooks, type SarifLog, type TestExecution,
  type VerificationRecord, type Severity,
} from '@diffwise/core';
import { AiReviewer, ReportChat, type ChatAnswer, type LlmProvider } from '@diffwise/ai';
import type { ChatTurn } from '@diffwise/core';
import {
  analysisSettingsFrom, loadConfig, resolveProvider, type DiffWiseConfig, type LoadedConfig,
} from './config';
import { attachVerification, buildPlatform, publishFindings, verifyDeterministically, type Platform } from './orchestrate';
import { applyFix, listJournals, previewFix, rollbackFix, staleFiles, type ApplyFixResult, type FixPreview } from './fix';
import { findRepoRoot, loadReportFiles, openRepoStore, storeDir } from './repo';
import { runVerificationCommand } from './verify';

export const TOOL_NAME = 'diffwise';
export const TOOL_VERSION = '0.2.0';

export interface ServiceOptions {
  /** Repository root. Defaults to the git root of `cwd`. */
  root?: string;
  cwd?: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Override provider construction (tests inject a fake provider). */
  provider?: LlmProvider;
  fastProvider?: LlmProvider;
  /** Disable persistence for a one-shot review. */
  persist?: boolean;
}

export interface ReviewRunOptions {
  target: ReviewTarget;
  signal?: AbortSignal;
  onProgress?(stages: AnalysisStage[]): void;
  /** Force AI off for this run (`--no-ai`). */
  disableAi?: boolean;
  /** Force AI on even when config disables it (`--ai`). */
  enableAi?: boolean;
  reportId?: string;
}

export interface ReviewRunResult {
  report: ReviewReport;
  path?: string;
  aiReason?: string;
}

export class ServiceError extends Error {
  constructor(message: string, readonly code: string = 'SERVICE_ERROR') {
    super(message);
    this.name = 'ServiceError';
  }
}

export class DiffWiseService {
  readonly root: string;
  readonly config: DiffWiseConfig;
  readonly configPath?: string;
  readonly configWarnings: string[];
  private storePromise?: Promise<ReviewStore>;
  private providedProvider?: LlmProvider;
  private providedFastProvider?: LlmProvider;
  private readonly env: NodeJS.ProcessEnv;
  private readonly persistDefault: boolean;

  private constructor(root: string, loaded: LoadedConfig, options: ServiceOptions) {
    this.root = root;
    this.config = loaded.config;
    this.configPath = loaded.path;
    this.configWarnings = loaded.warnings;
    this.env = options.env ?? process.env;
    this.providedProvider = options.provider;
    this.providedFastProvider = options.fastProvider;
    this.persistDefault = options.persist !== false;
  }

  static async create(options: ServiceOptions = {}): Promise<DiffWiseService> {
    const cwd = options.cwd ?? process.cwd();
    const root = options.root ? await findRepoRoot(options.root) : await findRepoRoot(cwd);
    const loaded = await loadConfig(root, {
      ...(options.configPath ? { configPath: options.configPath } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
    return new DiffWiseService(root, loaded, options);
  }

  private store(): Promise<ReviewStore> {
    this.storePromise ??= openRepoStore(this.root);
    return this.storePromise;
  }

  /** Provider resolution, honouring an injected provider first (tests, extension). */
  providers(): { provider?: LlmProvider; fastProvider?: LlmProvider; reason?: string; apiKeyPresent: boolean } {
    if (this.providedProvider) {
      return {
        provider: this.providedProvider,
        ...(this.providedFastProvider ? { fastProvider: this.providedFastProvider } : {}),
        apiKeyPresent: true,
      };
    }
    const resolved = resolveProvider(this.config, this.env);
    return {
      ...(resolved.provider ? { provider: resolved.provider } : {}),
      ...(resolved.fastProvider ? { fastProvider: resolved.fastProvider } : {}),
      ...(resolved.reason ? { reason: resolved.reason } : {}),
      apiKeyPresent: resolved.apiKeyPresent,
    };
  }

  /** Run a full review through the shared pipeline and persist it. */
  async review(options: ReviewRunOptions): Promise<ReviewRunResult> {
    const settings = analysisSettingsFrom(this.config);
    if (options.disableAi) settings.aiEnabled = false;
    if (options.enableAi) settings.aiEnabled = true;

    const { provider, fastProvider, reason } = this.providers();
    const platform = await buildPlatform({
      root: this.root,
      ...(provider ? { provider } : {}),
      ...(fastProvider ? { fastProvider } : {}),
      log: (message) => options.onProgress?.([]),
    });

    const hooks = this.platformHooks(platform, () => options.onProgress?.([]));

    const report = await runReview({
      root: this.root,
      target: options.target,
      settings,
      hooks,
      policy: platform.policy,
      policySnapshot: platform.policySnapshot,
      rulePacks: platform.rulePacks,
      persist: this.persistDefault,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.reportId ? { reportId: options.reportId } : {}),
      execution: {
        tool: TOOL_NAME,
        toolVersion: TOOL_VERSION,
        command: 'diffwise review',
        cwd: process.cwd(),
        nodeVersion: process.version,
        platform: `${process.platform}-${process.arch}`,
      },
    });

    // Policy problems are part of the review outcome, not a console warning.
    if (platform.problems.length > 0) {
      report.contextSources = [
        ...(report.contextSources ?? []),
        {
          id: 'policy',
          kind: 'document',
          label: 'Review policy',
          origin: platform.policySnapshot.layers.map((l) => l.source).join(', ') || 'defaults only',
          fetchedAt: new Date().toISOString(),
          items: platform.policySnapshot.layers.length,
          status: 'fresh',
          detail: platform.problems.map((p) => `${p.path}: ${p.message}`).join(' | ').slice(0, 2_000),
        },
      ];
    }

    const path = this.persistDefault ? join(storeDir(this.root), 'reviews', `${report.id}.json`) : undefined;
    const aiReason = settings.aiEnabled
      ? (provider ? reason : 'No AI provider is configured; the review is deterministic only.')
      : 'AI is disabled for this run.';
    return { report, ...(path ? { path } : {}), ...(aiReason ? { aiReason } : {}) };
  }

  /**
   * Bridge the AI session into the core pipeline hooks.
   *
   * The session is created only when a provider exists. A review with no
   * provider still runs the full deterministic pipeline and the full
   * verification engine — it simply has no model opinions to weigh.
   */
  private platformHooks(platform: Platform, log: (message: string) => void): ReviewPlatformHooks {
    const session = platform.session;
    const policy = platform.policy;
    const deterministicVerify = (input: {
      report: ReviewReport;
      repoFiles: Map<string, string>;
      oldContents: Map<string, string | null>;
      addedLines: Map<string, Set<number>>;
    }): ReturnType<typeof verifyDeterministically> => verifyDeterministically({
      report: input.report,
      repoFiles: input.repoFiles,
      oldContents: input.oldContents,
      addedLines: input.addedLines,
      changedFiles: new Set(input.report.changes.map((c) => c.path)),
      policy,
    });

    if (!session) {
      // No provider: the deterministic verification engine still runs.
      return {
        verify: async (input) => {
          const result = deterministicVerify(input);
          log(`verified ${result.verdicts.length} finding(s) with static evidence only (no provider configured).`);
          return result;
        },
      };
    }

    return {
      runReviewers: async (input) => {
        const result = await session.runReviewers({
          report: input.report,
          repoFiles: input.repoFiles,
          ...(input.policy ? { policy: input.policy } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
          log: input.log,
        });
        return {
          findings: result.findings,
          runs: result.runs,
          plan: result.plan,
          tokens: result.tokens,
          durationMs: result.durationMs,
          cancelled: result.cancelled,
          proposed: result.runs.reduce((n, r) => n + r.proposed, 0),
          evidenceRejected: result.runs.reduce((n, r) => n + r.evidenceRejected, 0),
          ...(result.skippedReason ? { skippedReason: result.skippedReason } : {}),
        };
      },
      verify: async (input) => {
        const result = await session.verify({
          report: input.report,
          repoFiles: input.repoFiles,
          policy,
          verificationPolicy: { minimumStatus: policy.verification.minimumStatus },
          oldContents: input.oldContents,
          contexts: {
            addedLines: input.addedLines,
            changedFiles: new Set(input.report.changes.map((c) => c.path)),
          },
          ...(input.signal ? { signal: input.signal } : {}),
          log: input.log,
        });
        const withVerification = attachVerification(input.findings, result.outcomes);
        const { published, withheld } = publishFindings(withVerification, policy);
        if (withheld.length > 0) {
          log(`${withheld.length} finding(s) withheld: below the published minimum ${policy.verification.minimumStatus}.`);
        }
        const summary = verificationSummary(result.outcomes);
        return {
          findings: published,
          ...(withheld.length > 0 ? { withheld } : {}),
          summary: {
            performed: true,
            policy: 'default/v1',
            ...summary,
            durationMs: result.durationMs,
          },
          verdicts: result.outcomes.map((o) => ({ findingId: o.findingId, status: o.verification.status })),
          durationMs: result.durationMs,
        };
      },
    };
  }

  async latestReview(): Promise<ReviewReport | null> {
    const store = await this.store();
    const entry = (await store.listReviews(1))[0];
    if (!entry) return null;
    return store.loadReport(entry.id);
  }

  async listReviews(limit = 20): Promise<ReviewIndexEntry[]> {
    return (await this.store()).listReviews(limit);
  }

  async loadReview(ref: string): Promise<ReviewReport> {
    const store = await this.store();
    if (ref === 'latest' || ref === 'previous') {
      const entries = await store.listReviews(ref === 'latest' ? 1 : 2);
      const entry = ref === 'latest' ? entries[0] : entries[1];
      if (!entry) throw new ServiceError(`No review available for "${ref}". Run "diffwise review" first.`, 'NO_REVIEW');
      const report = await store.loadReport(entry.id);
      if (!report) throw new ServiceError(`Review ${entry.id} could not be read from disk.`, 'NO_REVIEW');
      return report;
    }
    const report = await store.loadReport(ref);
    if (!report) {
      const entries = await store.listReviews(5);
      const hint = entries.length ? ` Known reviews: ${entries.map((e) => e.id).join(', ')}.` : ' No reviews recorded yet.';
      throw new ServiceError(`Review "${ref}" was not found.${hint}`, 'NO_REVIEW');
    }
    return report;
  }

  async findByFinding(findingRef: string): Promise<{ report: ReviewReport; finding: Finding }> {
    const ref = findingRef.trim();
    if (!ref) throw new ServiceError('A finding id is required (for example DW-001).', 'NO_FINDING');
    const store = await this.store();
    for (const entry of await store.listReviews(10)) {
      const report = await store.loadReport(entry.id);
      const finding = report?.findings.find((f) => f.id === ref);
      if (report && finding) return { report, finding };
    }
    throw new ServiceError(`Finding "${ref}" was not found in the 10 most recent reviews.`, 'NO_FINDING');
  }

  /** Persist a mutated report (fixes, verification, applied fixes). */
  async save(report: ReviewReport): Promise<void> {
    await (await this.store()).saveReport(report);
  }

  /**
   * Append a human decision and recompute the review state.
   *
   * Only `actorKind: 'human'` decisions can satisfy an approval requirement. An
   * AI or CI decision is recorded because the audit trail needs it, but it is
   * counted separately and can never move a review to APPROVED.
   */
  async recordDecision(input: {
    reviewId: string;
    findingId?: string;
    action: ReviewDecision['action'];
    actor: string;
    actorKind: ReviewDecision['actorKind'];
    role?: string;
    rationale: string;
    aiRecommendation?: string;
  }): Promise<{ decision: ReviewDecision; state: ReviewState; approvals: ApprovalStatus; review: ReviewReport }> {
    const report = await this.loadReview(input.reviewId);
    if (input.findingId && !report.findings.some((f) => f.id === input.findingId)) {
      throw new ServiceError(`Finding ${input.findingId} is not part of review ${report.id}.`, 'NO_FINDING');
    }
    const decision: ReviewDecision = {
      id: `D-${randomUUID().slice(0, 8)}`,
      reviewId: report.id,
      ...(input.findingId ? { findingId: input.findingId } : {}),
      action: input.action,
      actor: input.actor,
      actorKind: input.actorKind,
      ...(input.role ? { role: input.role } : {}),
      rationale: input.rationale,
      at: new Date().toISOString(),
      ...(input.aiRecommendation ? { aiRecommendation: input.aiRecommendation } : {}),
    };
    const decisions = [...(report.decisions ?? []), decision];
    const policy = report.policy?.policy ?? DEFAULT_POLICY;
    const approvals = evaluateApproval({
      risk: report.risk,
      policy,
      changes: report.changes.map((c) => ({ path: c.path })),
      findings: report.findings,
      decisions,
    });
    const state = computeState({ findings: report.findings, policy, decisions, approvals });
    const updated: ReviewReport = { ...report, decisions, approvals, state };
    await this.save(updated);
    return { decision, state, approvals, review: updated };
  }

  /** Append an agent record (feedback, intent, decisions taken by a coding agent). */
  async recordEvent(event: Omit<AgentEvent, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): Promise<AgentEvent> {
    const store = await this.store();
    const full: AgentEvent = {
      id: event.id ?? `evt-${randomUUID().slice(0, 8)}`,
      createdAt: event.createdAt ?? new Date().toISOString(),
      type: event.type,
      title: event.title,
      detail: event.detail,
      ...(event.actor ? { actor: event.actor } : {}),
      ...(event.files ? { files: event.files } : {}),
      ...(event.status ? { status: event.status } : {}),
      ...(event.metadata ? { metadata: event.metadata } : {}),
    };
    await store.appendAgentEvent(full);
    return full;
  }

  async chat(input: {
    question: string;
    reviewRef?: string;
    findingId?: string;
    history?: ChatTurn[];
    signal?: AbortSignal;
  }): Promise<{ answer: ChatAnswer; provider: string; model: string; reportId: string }> {
    const { provider } = this.providers();
    if (!provider) {
      throw new ServiceError(
        this.providers().reason ?? 'No AI provider is configured. Set the API key environment variable named in .diffwise/config.json.',
        'NO_PROVIDER',
      );
    }
    const report = await this.loadReview(input.reviewRef ?? 'latest');
    const repoFiles = await loadReportFiles(this.root, report);
    const chat = new ReportChat(provider, report, repoFiles, {
      sendRepositoryContent: this.config.ai.sendRepositoryContent,
    });
    const answer = await chat.ask(input.question, {
      ...(input.findingId ? { findingId: input.findingId } : {}),
      ...(input.history ? { history: input.history } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return { answer, provider: provider.id, model: provider.model, reportId: report.id };
  }

  /** All fix options known for a finding: deterministic guidance + generated. */
  async fixOptions(findingId: string, options: { generate?: boolean; signal?: AbortSignal } = {}): Promise<{
    report: ReviewReport; finding: Finding; fixes: FixSolution[]; warnings: string[];
  }> {
    const { report, finding } = await this.findByFinding(findingId);
    const warnings: string[] = [];
    let fixes = report.fixes.filter((f) => f.findingId === finding.id);

    const wantsGeneration = options.generate ?? fixes.length === 0;
    const { provider, fastProvider, reason } = this.providers();
    if (wantsGeneration && provider) {
      const reviewer = new AiReviewer(provider, {
        ...(fastProvider ? { fixProvider: fastProvider } : {}),
        generateFixes: true,
        maxFixFindings: 1,
      });
      try {
        const repoFiles = await loadReportFiles(this.root, report, 400);
        const changed = new Map(report.changes
          .filter((c) => c.status !== 'deleted')
          .map((c) => [c.path, repoFiles.get(c.path) ?? '']));
        const result = await reviewer.generateFixesFor({
          report,
          repoFiles,
          changedContents: changed,
          root: this.root,
          findings: [finding],
          ...(options.signal ? { signal: options.signal } : {}),
        });
        warnings.push(...result.failures);
        if (result.fixes.length > 0) {
          fixes = [...fixes, ...result.fixes];
          report.fixes = [...report.fixes, ...result.fixes.filter((f) => !report.fixes.some((x) => x.id === f.id))];
          await this.save(report);
        }
      } catch (err) {
        warnings.push(`Fix generation failed: ${(err as Error).message}`);
      }
    } else if (wantsGeneration && !provider && reason) {
      warnings.push(reason);
    }
    if (fixes.length === 0) {
      warnings.push(`No patch was generated for ${finding.id}. Deterministic guidance is shown instead.`);
    }
    return { report, finding, fixes, warnings };
  }

  /**
   * Register a patch supplied by the developer (or an agent acting on their
   * behalf) as a fix option for a finding, after validating it. The patch still
   * goes through preview → approval → apply; registering it only makes it
   * visible to every interface.
   */
  async registerPatch(input: {
    findingId: string;
    diff: string;
    label?: string;
    description?: string;
  }): Promise<{ fix: FixSolution; preview: FixPreview; report: ReviewReport }> {
    const { report, finding } = await this.findByFinding(input.findingId);
    const preview = await previewFix(this.root, input.diff);
    const files = preview.files;
    const id = `fix-${createHash('sha256').update(input.diff).digest('hex').slice(0, 10)}`;
    const existing = report.fixes.find((f) => f.id === id);
    const fix: FixSolution = existing ?? {
      id,
      findingId: finding.id,
      label: input.label ?? 'Developer-supplied patch',
      approach: 'Apply the patch exactly as supplied, after validating it against the working tree.',
      description: (input.description ?? `Patch touching ${files.join(', ') || 'no files'}.`),
      filesAffected: files,
      advantages: ['Written by the developer, so it matches local intent and conventions.'],
      disadvantages: ['Not generated by the analyser: DiffWise validates applicability but does not reason about the design.'],
      performance: 'unchanged',
      sideEffects: [],
      complexity: 'low',
      testing: ['Run the project test suite after applying.'],
      compatibility: 'Determined by the supplied patch.',
      patch: {
        diff: input.diff,
        files,
        destructive: /^deleted file mode/m.test(input.diff),
        validation: {
          applies: preview.applies,
          ...(preview.reason ? { reason: preview.reason } : {}),
          ...(preview.fuzz ? { fuzz: preview.fuzz } : {}),
        },
      },
      source: 'developer-patch',
    };
    if (!existing) {
      report.fixes = [...report.fixes, fix];
      await this.save(report);
    }
    return { fix, preview, report };
  }

  async previewFix(findingId: string, solutionId: string): Promise<{ fix: FixSolution; preview: FixPreview; report: ReviewReport }> {
    const { report, finding } = await this.findByFinding(findingId);
    const fix = report.fixes.find((f) => f.id === solutionId && f.findingId === finding.id)
      ?? report.fixes.find((f) => f.id === solutionId)
      ?? report.fixes.find((f) => f.findingId === finding.id);
    if (!fix) throw new ServiceError(`No fix "${solutionId}" exists for ${findingId}. Run "diffwise fix ${findingId}" to generate options.`, 'NO_FIX');
    if (!fix.patch?.diff) throw new ServiceError(`Fix "${fix.label}" has no patch; only guidance is available.`, 'NO_PATCH');
    const preview = await previewFix(this.root, fix.patch.diff);
    const stale = await staleFiles(this.root, preview.hashes);
    return { fix, preview: { ...preview, stale }, report };
  }

  /**
   * Apply an approved fix. `approved` must come from an explicit developer
   * action; every other caller path is refused by the fix engine.
   */
  async applyFix(input: {
    findingId: string;
    solutionId: string;
    approved: boolean;
    reviewRef?: string;
    allowDelete?: boolean;
  }): Promise<{ applied: ApplyFixResult; report: ReviewReport; finding: Finding; fix: FixSolution }> {
    const { report, finding } = await this.findByFinding(input.findingId);
    const fix = report.fixes.find((f) => f.id === input.solutionId) ?? report.fixes.find((f) => f.findingId === finding.id);
    if (!fix) throw new ServiceError(`No fix "${input.solutionId}" exists for ${input.findingId}.`, 'NO_FIX');
    if (!fix.patch?.diff) throw new ServiceError(`Fix "${fix.label}" has no patch to apply.`, 'NO_PATCH');

    const preview = await previewFix(this.root, fix.patch.diff);
    if (!preview.applies) {
      const result: ApplyFixResult = {
        applied: false, files: [], backupDir: join(storeDir(this.root), 'backups'), fuzz: preview.fuzz,
        errors: [preview.reason ?? 'The patch does not apply to the current working tree.'], entries: [],
      };
      return { applied: result, report, finding, fix };
    }
    const result = await applyFix({
      root: this.root,
      diff: fix.patch.diff,
      backupDir: join(storeDir(this.root), 'backups'),
      expectedHashes: preview.hashes,
      approved: input.approved,
      findingId: finding.id,
      solutionId: fix.id,
      reviewId: report.id,
      ...(input.allowDelete ? { allowDelete: true } : {}),
    });

    if (result.applied) {
      const applied: AppliedFix = {
        id: `fix-${randomUUID().slice(0, 8)}`,
        reviewId: report.id,
        findingId: finding.id,
        solutionId: fix.id,
        appliedAt: new Date().toISOString(),
        files: result.files,
        diff: fix.patch.diff,
        backupDir: result.backupDir,
      };
      report.appliedFixes = [...report.appliedFixes, applied];
      await this.save(report);
    }
    return { applied: result, report, finding, fix };
  }

  async rollback(appliedFixId: string): Promise<{ reverted: string[]; errors: string[]; report: ReviewReport }> {
    const store = await this.store();
    for (const entry of await store.listReviews(10)) {
      const report = await store.loadReport(entry.id);
      const applied = report?.appliedFixes.find((a) => a.id === appliedFixId);
      if (!report || !applied) continue;
      const journal = join(storeDir(this.root), 'transactions');
      const journals = await listJournals(this.root);
      const match = journals.find((j) => j.reviewId === report.id && j.findingId === applied.findingId && j.status === 'applied');
      const result = match
        ? await rollbackFix(this.root, join(journal, `${match.id}.json`))
        : await rollbackFix(this.root, join(storeDir(this.root), 'transactions', `${applied.id}.json`));
      applied.revertedAt = new Date().toISOString();
      await this.save(report);
      return { ...result, report };
    }
    throw new ServiceError(`Applied fix "${appliedFixId}" was not found in recent reviews.`, 'NO_APPLIED_FIX');
  }

  /** Run the configured verification command and record the real result. */
  async verify(input: { findingId?: string; approved?: boolean; reviewRef?: string; signal?: AbortSignal } = {}): Promise<{
    execution: TestExecution; report: ReviewReport; record: VerificationRecord;
  }> {
    const report = await this.loadReview(input.reviewRef ?? 'latest');
    const command = this.config.verification.command;
    if (!command) {
      throw new ServiceError('No verification command is configured. Set verification.command in .diffwise/config.json (for example "npm test").', 'NO_VERIFICATION_COMMAND');
    }
    const execution = await runVerificationCommand({
      root: this.root,
      command,
      timeoutMs: this.config.verification.timeoutMs,
      ranBy: input.findingId ? 'verification-after-fix' : 'user-command',
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const record: VerificationRecord = {
      id: `verify-${randomUUID().slice(0, 8)}`,
      at: new Date().toISOString(),
      ...(input.findingId ? { findingId: input.findingId } : {}),
      execution,
      approvedBy: 'cli',
    };
    report.verification = [...report.verification, record];
    report.tests.execution = execution;
    if (input.findingId) {
      const applied = report.appliedFixes.filter((a) => a.findingId === input.findingId);
      for (const fix of applied) fix.verification = execution;
    }
    await this.save(report);
    return { execution, report, record };
  }

  /** Structural comparison of two reviews: counts, risk and finding deltas. */
  async compare(leftRef: string, rightRef: string): Promise<{
    left: ReviewReport; right: ReviewReport;
    summary: {
      risk: { left: number; right: number; delta: number };
      findings: { left: number; right: number; delta: number };
      files: { left: number; right: number; delta: number };
    };
    resolved: Finding[];
    introduced: Finding[];
    persisted: Finding[];
  }> {
    const left = await this.loadReview(leftRef);
    const right = await this.loadReview(rightRef);
    const byKey = (f: Finding): string => `${f.ruleId}|${f.file}|${f.title}`;
    const leftKeys = new Map(left.findings.map((f) => [byKey(f), f]));
    const rightKeys = new Map(right.findings.map((f) => [byKey(f), f]));
    const resolved = left.findings.filter((f) => !rightKeys.has(byKey(f)));
    const introduced = right.findings.filter((f) => !leftKeys.has(byKey(f)));
    const persisted = right.findings.filter((f) => leftKeys.has(byKey(f)));
    return {
      left,
      right,
      summary: {
        risk: { left: left.risk.score, right: right.risk.score, delta: right.risk.score - left.risk.score },
        findings: { left: left.findings.length, right: right.findings.length, delta: right.findings.length - left.findings.length },
        files: { left: left.changes.length, right: right.changes.length, delta: right.changes.length - left.changes.length },
      },
      resolved,
      introduced,
      persisted,
    };
  }

  envelope(report: ReviewReport): ReviewEnvelope {
    return buildReviewEnvelope(report);
  }

  sarif(report: ReviewReport, options: { minSeverity?: Severity } = {}): SarifLog {
    return buildSarif(report, {
      toolVersion: TOOL_VERSION,
      ...(options.minSeverity ? { minSeverity: options.minSeverity } : {}),
      command: report.execution?.command ?? 'diffwise review',
    });
  }

  /** Quality gate result for CI. `failOn: none` never fails. */
  qualityGate(report: ReviewReport): { failed: boolean; threshold: string; offending: Finding[] } {
    const threshold = this.config.qualityGate.failOn;
    if (threshold === 'none') return { failed: false, threshold, offending: [] };
    const rank: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    const offending = report.findings.filter((f) => rank[f.severity] <= rank[threshold]);
    return { failed: offending.length > 0, threshold, offending };
  }

  /** Write an artefact next to the review (used by the CLI and CI). */
  async writeArtefact(report: ReviewReport, kind: 'json' | 'envelope' | 'sarif', target?: string): Promise<string> {
    const path = target ?? join(storeDir(this.root), 'artefacts', `${report.id}.${kind === 'envelope' ? 'json' : kind}`);
    await mkdir(join(path, '..'), { recursive: true });
    const payload = kind === 'json'
      ? JSON.stringify(report, null, 2)
      : kind === 'envelope'
        ? JSON.stringify(buildReviewEnvelope(report), null, 2)
        : JSON.stringify(buildSarif(report, { toolVersion: TOOL_VERSION }), null, 2);
    await writeFile(path, `${payload}\n`, 'utf8');
    return path;
  }

  /** Load a patch from disk (used by `diffwise fix --patch-file`). */
  async readPatch(file: string): Promise<string> {
    return readFile(file, 'utf8');
  }

  /** Parse a patch just to report what it touches, without applying. */
  patchFiles(diff: string): string[] {
    return parsePatch(diff).map((p) => p.path);
  }
}

export { EmptyReviewError, finalizeFindings };
