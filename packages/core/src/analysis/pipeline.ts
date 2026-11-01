import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type {
  AnalysisSettings, AnalysisStage, ChangeGroup, ChangedSymbol, DocumentationFinding, DocumentationFile,
  ExecutionMetadata, FileChange, Finding, FixSolution, KnowledgeItem, ProviderStatus, RepositoryInfo, ReviewReport,
  ReviewTarget, TestAnalysis, GraphAnalysis, Convention, VerificationRecord,
} from '../types';
import { DEFAULT_ANALYSIS_SETTINGS, REPORT_SCHEMA_VERSION, SEVERITY_ORDER } from '../types';
import { GitClient, GitError } from '../git/git';
import { diffSymbols, extractSymbols, countReferences, parseSource } from '../analysis/symbols';
import { buildGraph, detectConventions } from '../analysis/graph';
import { groupChanges } from '../analysis/grouping';
import { analyseTests } from '../analysis/testAnalysis';
import { analyseDocumentation, docsToFindings, loadDocuments } from '../analysis/docAnalysis';
import { assessRisk } from '../analysis/risk';
import { buildAgentContext, emptyAgentContext } from '../agent/agentContext';
import { openStore, type ReviewStore } from '../store/store';
import { buildContextPack } from '../context/contextPack';
import { buildGuidanceFixes } from '../fixes/guidance';
import { matchesAnyGlob } from '../util/glob';
import { stableId } from '../util/text';
import { isCodeFile } from '../analysis/languages';
import { securityRules } from '../rules/security';
import { concurrencyRules } from '../rules/concurrency';
import { databaseRules } from '../rules/database';
import { apiRules } from '../rules/api';
import { qualityRules } from '../rules/quality';
import { architectureRules } from '../rules/architecture';
import type { Rule, RuleContext } from '../rules/types';
import type { LoadedRulePack } from '../rules/loader';
import type { ReviewPolicy } from '../policy/types';
import { runRuleSet, type RuleExecutionRecord } from '../rules/registry';
import type { ReviewPlatformHooks } from '../review/hooks';
import { emptyVerificationSummary } from '../review/hooks';
import { contextFromReport, runDeterministicVerification } from '../verification/run';
import type { AiReviewStatus, ReviewPipelineInfo } from '../review/types';

export class EmptyReviewError extends Error {
  constructor(message = 'No changes to review for the selected target.') { super(message); this.name = 'EmptyReviewError'; }
}
export class ReviewCancelledError extends Error {
  constructor(readonly stages: AnalysisStage[]) { super('Review cancelled.'); this.name = 'ReviewCancelledError'; }
}

export interface EnrichmentInput {
  root: string;
  report: ReviewReport;
  repoFiles: Map<string, string>;
  changedContents: Map<string, string>;
  settings: AnalysisSettings;
  signal?: AbortSignal;
  log(message: string): void;
}

export interface EnrichmentResult {
  findings?: Finding[];
  fixes?: FixSolution[];
  ai?: ReviewReport['ai'];
  provider?: ProviderStatus;
  knowledge?: KnowledgeItem[];
  detail?: string;
  /** Set when the enricher ran but produced no usable result. */
  warning?: string;
}

export interface ReviewEnricher {
  id: string;
  label: string;
  enrich(input: EnrichmentInput): Promise<EnrichmentResult>;
}

export interface RunReviewOptions {
  root: string;
  target: ReviewTarget;
  settings?: Partial<AnalysisSettings>;
  enrichers?: ReviewEnricher[];
  /** Reviewer/verifier implementations supplied by the AI layer. */
  hooks?: ReviewPlatformHooks;
  /** Effective review policy for this review. */
  policy?: ReviewPolicy;
  /** Snapshot of the effective policy with provenance, stored in the report. */
  policySnapshot?: import('../policy/types').EffectivePolicySnapshot;
  /** Extra declarative rule packs loaded from disk. */
  rulePacks?: LoadedRulePack[];
  signal?: AbortSignal;
  onProgress?(stages: AnalysisStage[]): void;
  reportId?: string;
  persist?: boolean;
  /**
   * When true, a review that could not run its AI stage is marked partial.
   * The report is still produced; the caller decides whether that is fatal.
   */
  aiRequired?: boolean;
  /**
   * Why no provider was available, from the layer that resolved it.
   * Reported verbatim: "which key is missing" is the difference between a
   * message a developer can act on and one they cannot.
   */
  providerReason?: string;
  storeDir?: string;
  /** Identity of the producing interface, recorded in the report. */
  execution?: Partial<Omit<ExecutionMetadata, 'indexedFiles'>>;
}

const RULES: Rule[] = [
  ...securityRules,
  ...concurrencyRules,
  ...databaseRules,
  ...apiRules,
  ...qualityRules,
  ...architectureRules,
];

const STAGE_DEFS: Array<{ id: string; label: string }> = [
  { id: 'collect', label: 'Collect git changes' },
  { id: 'project', label: 'Discover project structure' },
  { id: 'parse', label: 'Parse changed files and symbols' },
  { id: 'graph', label: 'Build dependency graph' },
  { id: 'context', label: 'Collect documentation and tests' },
  { id: 'agent', label: 'Load coding-agent context' },
  { id: 'rules', label: 'Run deterministic analysis' },
  { id: 'ai', label: 'AI interpretation' },
  { id: 'correlate', label: 'Correlate and deduplicate findings' },
  { id: 'verify', label: 'Independently verify findings' },
  { id: 'risk', label: 'Compute risk and summary' },
  { id: 'persist', label: 'Persist review' },
];

class Tracker {
  readonly stages: AnalysisStage[];
  constructor(private readonly onProgress?: (s: AnalysisStage[]) => void) {
    this.stages = STAGE_DEFS.map((d) => ({ id: d.id, label: d.label, status: 'pending' }));
  }
  private emit(): void { this.onProgress?.(this.snapshot()); }
  snapshot(): AnalysisStage[] { return this.stages.map((s) => ({ ...s })); }
  start(id: string): void {
    const s = this.find(id);
    s.status = 'running';
    s.startedAt = new Date().toISOString();
    this.emit();
  }
  complete(id: string, detail?: string, metrics?: Record<string, number | string>): void {
    const s = this.find(id);
    s.status = 'completed';
    s.finishedAt = new Date().toISOString();
    s.durationMs = s.startedAt ? Date.now() - Date.parse(s.startedAt) : 0;
    if (detail) s.detail = detail;
    if (metrics) s.metrics = metrics;
    this.emit();
  }
  fail(id: string, error: string): void {
    const s = this.find(id);
    s.status = 'failed';
    s.finishedAt = new Date().toISOString();
    s.durationMs = s.startedAt ? Date.now() - Date.parse(s.startedAt) : 0;
    s.error = error;
    this.emit();
  }
  skip(id: string, reason: string): void {
    const s = this.find(id);
    s.status = 'skipped';
    s.detail = reason;
    this.emit();
  }
  cancelled(id: string): void {
    const s = this.find(id);
    s.status = 'cancelled';
    this.emit();
  }
  detail(id: string, text: string): void {
    const s = this.find(id);
    s.detail = text;
    this.emit();
  }
  private find(id: string): AnalysisStage {
    const s = this.stages.find((x) => x.id === id);
    if (!s) throw new Error(`Unknown stage ${id}`);
    return s;
  }
}

function newReportId(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${randomUUID().slice(0, 6)}`;
}

/**
 * Run the full deterministic pipeline, then any registered enrichers (AI).
 *
 * Every stage records its own status. A failed stage is never presented as
 * complete: the report is marked `partial` and the failure is carried in
 * `stages[].error`.
 */
export async function runReview(options: RunReviewOptions): Promise<ReviewReport> {
  const startedAt = Date.now();
  const settings: AnalysisSettings = { ...DEFAULT_ANALYSIS_SETTINGS, ...options.settings };
  const tracker = new Tracker(options.onProgress);
  const signal = options.signal;
  const checkAbort = (stageId: string): void => {
    if (signal?.aborted) {
      tracker.cancelled(stageId);
      throw new ReviewCancelledError(tracker.snapshot());
    }
  };
  const git = new GitClient(options.root, { maxFileBytes: settings.maxFileBytes });
  const repoFiles = new Map<string, string>();
  const contents = new Map<string, string>();
  const oldContents = new Map<string, string | null>();
  const ruleFailures: string[] = [];
  const ruleExecutions: RuleExecutionRecord[] = [];
  let truncationNote: string | undefined;
  let pipelineInfo: ReviewPipelineInfo | undefined;

  // 1. Collect.
  tracker.start('collect');
  try {
    await git.assertRepo();
  } catch (err) {
    tracker.fail('collect', (err as Error).message);
    throw new GitError('DiffWise needs a git repository.', ['rev-parse'], (err as Error).message);
  }
  let changes: FileChange[];
  let baseRef: string;
  try {
    const diff = await git.diff(options.target, { signal });
    changes = diff.changes.filter((c) => !matchesAnyGlob(c.path, settings.ignoreGlobs));
    baseRef = diff.baseRef;
  } catch (err) {
    if (signal?.aborted) {
      // A cancelled git process rejects with AbortError; surface cancellation,
      // not a spurious git failure.
      tracker.cancelled('collect');
      throw new ReviewCancelledError(tracker.snapshot());
    }
    tracker.fail('collect', (err as Error).message);
    throw err;
  }
  if (signal?.aborted) {
    tracker.cancelled('collect');
    throw new ReviewCancelledError(tracker.snapshot());
  }
  if (changes.length === 0) {
    tracker.complete('collect', 'No changed files for this target.', { files: 0 });
    throw new EmptyReviewError();
  }
  if (changes.length > settings.maxFiles) {
    truncationNote = `Only the first ${settings.maxFiles} of ${changes.length} changed files were analysed (diffwise.analysis.maxFiles).`;
    changes = changes.slice(0, settings.maxFiles);
  }
  tracker.complete('collect', `${changes.length} changed file(s) against ${baseRef}.`, { files: changes.length });
  checkAbort('project');

  // 2. Project discovery.
  tracker.start('project');
  let repo: RepositoryInfo;
  try {
    repo = await git.info();
    const files = await git.listWorktreeFiles();
    const candidates = files.filter((f) => !matchesAnyGlob(f, settings.ignoreGlobs) && isReadable(f));
    const limited = candidates.slice(0, 4000);
    if (candidates.length > limited.length) truncationNote = `${truncationNote ? `${truncationNote} ` : ''}Repository index limited to ${limited.length} files.`;
    await pool(limited, 12, async (path) => {
      const content = await git.readWorktreeFile(path);
      if (content !== null) repoFiles.set(path, content);
    });
  } catch (err) {
    tracker.fail('project', (err as Error).message);
    throw err;
  }
  tracker.complete('project', `${repoFiles.size} file(s) indexed; ${repo.fileCount} tracked.`, { indexed: repoFiles.size, tracked: repo.fileCount });
  checkAbort('parse');

  // 3. Parse symbols.
  tracker.start('parse');
  const symbols: ChangedSymbol[] = [];
  for (const change of changes) {
    let oldContent: string | null = null;
    if (change.status !== 'added' && !change.untracked) {
      oldContent = await git.readFileAt(baseRef, change.oldPath ?? change.path);
      if (oldContent === null) oldContent = repoFiles.get(change.oldPath ?? change.path) ?? null;
    }
    let newContent: string | null = null;
    if (change.status !== 'deleted') {
      newContent = await git.readHeadContent(change, options.target);
      if (newContent === null) newContent = repoFiles.get(change.path) ?? null;
      if (newContent !== null) {
        contents.set(change.path, newContent);
        repoFiles.set(change.path, newContent);
      }
    }
    oldContents.set(change.path, oldContent);
    try {
      symbols.push(...diffSymbols({ change, oldContent, newContent }));
    } catch (err) {
      ruleFailures.push(`symbols(${change.path}): ${(err as Error).message}`);
    }
  }
  // Reference counts make signature and removal findings meaningful.
  const referenceCorpus = [...repoFiles.entries()].filter(([p]) => isCodeFile(p) || /\.(py|go|java|kt|rb|php|cs|rs)$/.test(p)).slice(0, 3000);
  for (const sym of symbols) {
    if (!sym.exported) continue;
    sym.referenceCount = countReferences(
      referenceCorpus.map(([path, content]) => ({ path, content })),
      sym.name,
      sym.file,
    ).count;
  }
  tracker.complete('parse', `${symbols.length} changed symbol(s) across ${changes.length} file(s).`, { symbols: symbols.length });
  checkAbort('graph');

  // 4. Graph.
  tracker.start('graph');
  let graph: GraphAnalysis;
  let conventions: Convention[] = [];
  try {
    const exportedSymbols = new Map<string, string[]>();
    for (const [path, content] of repoFiles) {
      if (!isCodeFile(path)) continue;
      for (const s of extractSymbols(path, content)) {
        if (!s.exported) continue;
        const list = exportedSymbols.get(s.name) ?? [];
        if (!list.includes(path)) list.push(path);
        exportedSymbols.set(s.name, list);
      }
    }
    graph = buildGraph({ files: repoFiles, changes, oldContents, exportedSymbols });
    conventions = detectConventions(repoFiles);
    const cycleFindings = graph.cycles.length;
    tracker.complete('graph', `${graph.fileCount} files, ${graph.edgeCount} edges, ${cycleFindings} cycle(s).`, {
      files: graph.fileCount, edges: graph.edgeCount, cycles: cycleFindings,
    });
  } catch (err) {
    tracker.fail('graph', (err as Error).message);
    graph = emptyGraph(changes);
    conventions = [];
  }
  checkAbort('context');

  // 5. Documentation + tests.
  tracker.start('context');
  let docs: DocumentationFile[] = [];
  let docTexts = new Map<string, string>();
  let docFindings: DocumentationFinding[] = [];
  let tests: TestAnalysis;
  try {
    const loaded = loadDocuments(repoFiles);
    docs = loaded.docs;
    docTexts = loaded.texts;
    docFindings = analyseDocumentation({ docs, docTexts, repoFiles, changes, symbols });
    tests = analyseTests(repoFiles, changes, symbols);
    tracker.complete('context', `${docs.length} document(s), ${tests.files.length} test file(s).`, {
      documents: docs.length, tests: tests.files.length, docFindings: docFindings.length,
    });
  } catch (err) {
    tracker.fail('context', (err as Error).message);
    tests = { files: [], uncoveredChanges: [], uncoveredSymbols: [], deletedTests: [], suggestions: [] };
  }
  checkAbort('agent');

  // 6. Agent context.
  tracker.start('agent');
  let agent = emptyAgentContext();
  let store: ReviewStore | null = null;
  try {
    store = await openStore(options.root, options.storeDir ?? '.diffwise');
    const events = await store.readAgentEvents();
    agent = buildAgentContext(events, changes);
    tracker.complete('agent', events.length
      ? `${events.length} recorded event(s); intent verdict: ${agent.intentAlignment[0]?.verdict ?? 'n/a'}.`
      : 'No agent events recorded for this repository.', { events: events.length });
  } catch (err) {
    tracker.fail('agent', (err as Error).message);
  }
  checkAbort('rules');

  // 7. Deterministic rules.
  tracker.start('rules');
  const ctx: RuleContext = {
    changes, contents, oldContents, repoFiles, symbols, docs, docTexts, tests, graph,
    settings, now: new Date(),
  };
  const addedLines = new Map<string, Set<number>>();
  for (const change of changes) {
    const set = new Set<number>();
    for (const hunk of change.hunks) {
      for (const line of hunk.lines) if (line.kind === 'add' && line.newLine !== undefined) set.add(line.newLine);
    }
    addedLines.set(change.path, set);
  }
  const ruleRun = runRuleSet(ctx, {
    builtinRules: RULES,
    ...(options.rulePacks ? { packs: options.rulePacks } : {}),
    ...(options.policy ? { policy: options.policy } : {}),
  });
  const candidates = ruleRun.findings;
  for (const record of ruleRun.records) {
    if (record.status === 'failed') ruleFailures.push(`${record.id}: ${record.error ?? 'failed'}`);
  }
  ruleExecutions.push(...ruleRun.records);
  tracker.complete('rules', `${candidates.length} candidate finding(s) from ${ruleRun.records.filter((r) => r.status === 'ran').length} rule(s)`
    + `${ruleRun.suppressed ? `, ${ruleRun.suppressed} suppressed` : ''}${ruleRun.overridden ? `, ${ruleRun.overridden} severity override(s)` : ''}.`, {
    candidates: candidates.length,
    failedRules: ruleFailures.length,
    suppressed: ruleRun.suppressed,
  });
  checkAbort('ai');

  // Assemble an intermediate report so enrichers see the full deterministic picture.
  const deterministicFindings = finalizeFindings(candidates, []);
  const docAsFindings = docsToFindings(docFindings);
  const provisionalFindings = finalizeFindings(candidates, docAsFindings);
  void deterministicFindings;
  const knowledge = buildKnowledge(docs, docTexts, agent.events);

  let report: ReviewReport = assembleReport({
    id: options.reportId ?? newReportId(new Date()),
    startedAt,
    target: options.target,
    repo,
    settings,
    stages: tracker.snapshot(),
    changes,
    symbols,
    graph,
    conventions,
    docs,
    docFindings,
    findings: provisionalFindings,
    tests,
    agent,
    fixes: buildGuidanceFixes(provisionalFindings),
    provider: {
      configured: false,
      providerId: settings.providerId,
      state: settings.aiEnabled ? 'not-configured' : 'disabled',
      ...(settings.model ? { model: settings.model } : {}),
      // Name the actual reason when the caller supplied one ("DIFFWISE_API_KEY is
      // not set" beats "no provider configured"): it is the message a developer
      // has to act on.
      message: settings.aiEnabled
        ? (options.providerReason ?? 'No AI provider configured for this run.')
        : 'AI analysis is disabled in settings.',
    },
    knowledge,
    completenessNote: truncationNote,
    execution: {
      tool: options.execution?.tool ?? 'diffwise-core',
      toolVersion: options.execution?.toolVersion ?? '0.1.0',
      command: options.execution?.command ?? 'runReview',
      cwd: options.execution?.cwd ?? options.root,
      nodeVersion: options.execution?.nodeVersion ?? process.version,
      platform: options.execution?.platform ?? `${process.platform}-${process.arch}`,
      indexedFiles: repoFiles.size,
    },
  });

  // 8. Reviewers. A hook (specialised reviewers) wins; the legacy single
  //    enricher path is preserved for interfaces that have not migrated.
  let reviewerFindings: Finding[] = [];
  if (!settings.aiEnabled) {
    tracker.skip('ai', 'AI review is disabled in settings; the report is deterministic only.');
  } else if (options.hooks?.runReviewers) {
    tracker.start('ai');
    try {
      const result = await options.hooks.runReviewers({
        report,
        repoFiles,
        changedContents: contents,
        oldContents,
        addedLines,
        ...(options.policy ? { policy: options.policy } : {}),
        ...(signal ? { signal } : {}),
        log: (m) => tracker.detail('ai', m),
      });
      reviewerFindings = result.findings;
      const active = result.runs.filter((r) => r.status !== 'skipped');
      const completed = active.filter((r) => r.status === 'completed');
      const failed = active.filter((r) => r.status === 'failed');
      pipelineInfo = {
        plan: result.plan ?? {
          reviewers: [], decisions: [], considered: [], maxReviewers: 0,
          route: { provider: 'none', model: 'none' }, truncated: false,
        },
        reviewerRuns: result.runs,
        totals: {
          durationMs: result.durationMs,
          tokens: result.tokens,
          proposed: result.proposed ?? result.findings.length,
          accepted: result.findings.length,
          evidenceRejected: result.evidenceRejected ?? 0,
        },
        cancelled: result.cancelled,
        verification: emptyVerificationSummary(false),
        ...(result.skippedReason ? { skippedReason: result.skippedReason } : {}),
      };
      if (result.cancelled) {
        tracker.cancelled('ai');
      } else if (active.length > 0 && completed.length === 0) {
        tracker.fail('ai', failed.map((f) => `${f.reviewerId}: ${f.error ?? 'failed'}`).join(' | ') || 'every reviewer failed');
      } else if (failed.length > 0) {
        tracker.complete('ai', `${completed.length} reviewer(s) completed, ${failed.length} failed; ${result.findings.length} finding(s).`, {
          reviewers: completed.length, findings: result.findings.length, failed: failed.length,
        });
        tracker.stages.find((s) => s.id === 'ai')!.error = failed.map((f) => `${f.reviewerId}: ${f.error ?? 'failed'}`).join(' | ');
      } else {
        tracker.complete('ai', `${completed.length} reviewer(s), ${result.findings.length} verified-by-evidence finding(s).`, {
          reviewers: completed.length,
          findings: result.findings.length,
          evidenceRejected: result.evidenceRejected ?? 0,
          tokens: result.tokens.prompt + result.tokens.completion,
        });
      }
    } catch (err) {
      tracker.fail('ai', (err as Error).message);
    }
  } else if (!options.enrichers?.length) {
    tracker.skip('ai', settings.aiEnabled ? (options.providerReason ?? 'No AI provider configured.') : 'AI analysis is disabled in settings.');
  } else {
    tracker.start('ai');
    const aiFindings: Finding[] = [];
    const fixes: FixSolution[] = [];
    let provider: ProviderStatus | undefined;
    let aiMeta: ReviewReport['ai'];
    const warnings: string[] = [];
    for (const enricher of options.enrichers) {
      try {
        const result = await enricher.enrich({
          root: options.root,
          report,
          repoFiles,
          changedContents: contents,
          settings,
          ...(signal ? { signal } : {}),
          log: (m) => tracker.detail('ai', m),
        });
        if (result.findings?.length) aiFindings.push(...result.findings);
        if (result.fixes?.length) fixes.push(...result.fixes);
        if (result.provider) provider = result.provider;
        if (result.ai) aiMeta = result.ai;
        if (result.warning) warnings.push(result.warning);
      } catch (err) {
        warnings.push(`${enricher.id}: ${(err as Error).message}`);
      }
    }
    reviewerFindings = aiFindings;
    if (warnings.length && aiFindings.length === 0 && fixes.length === 0) {
      tracker.fail('ai', warnings.join(' | '));
    } else if (warnings.length) {
      tracker.complete('ai', `AI produced results with warnings: ${warnings.join(' | ')}`, { findings: aiFindings.length, fixes: fixes.length });
      tracker.stages.find((s) => s.id === 'ai')!.error = warnings.join(' | ');
    } else {
      tracker.complete('ai', `${aiFindings.length} finding(s), ${fixes.length} fix option(s).`, {
        findings: aiFindings.length, fixes: fixes.length,
      });
    }
    report = {
      ...report,
      findings: finalizeFindings(candidates, [...docAsFindings, ...aiFindings]),
      fixes: [...report.fixes, ...fixes],
      provider: provider ?? report.provider,
      ai: aiMeta,
      knowledge: [...knowledge],
    };
  }
  checkAbort('correlate');

  // 9. Correlate.
  tracker.start('correlate');
  report.findings = finalizeFindings(candidates, [...docAsFindings, ...reviewerFindings]);
  report.fixes = report.fixes.map((fix) => ({ ...fix, findingId: alignFindingId(fix.findingId, report.findings) }));
  tracker.complete('correlate', `${report.findings.length} finding(s) after deduplication.`, { findings: report.findings.length });
  checkAbort('verify');

  // 10. Independent verification. Runs on every review: without a provider it
  //     is the deterministic engine alone, which is still a real verdict.
  tracker.start('verify');
  if (options.hooks?.verify) {
    try {
      const verified = await options.hooks.verify({
        report,
        findings: report.findings,
        repoFiles,
        changedContents: contents,
        oldContents,
        addedLines,
        ...(options.policy ? { policy: options.policy } : {}),
        ...(signal ? { signal } : {}),
        log: (m) => tracker.detail('verify', m),
      });
      report.findings = verified.findings;
      if (verified.withheld?.length) report.withheldFindings = verified.withheld;
      // A fix whose finding was withheld or dropped must not stay orphaned.
      report.fixes = report.fixes.filter((fix) => report.findings.some((f) => f.id === fix.findingId));
      const summary = verified.summary;
      if (!pipelineInfo) {
        pipelineInfo = {
          plan: { reviewers: [], decisions: [], considered: [], maxReviewers: 0, route: { provider: 'none', model: 'none' }, truncated: false },
          reviewerRuns: [],
          totals: { durationMs: 0, tokens: { prompt: 0, completion: 0 }, proposed: 0, accepted: 0, evidenceRejected: 0 },
          cancelled: false,
          verification: summary,
        };
      } else {
        pipelineInfo = { ...pipelineInfo, verification: summary };
      }
      tracker.complete('verify',
        `${summary.confirmed} confirmed, ${summary.likely} likely, ${summary.unverified} unverified, `
        + `${summary.disputed} disputed, ${summary.rejected} rejected.`,
        { confirmed: summary.confirmed, likely: summary.likely, rejected: summary.rejected, disputed: summary.disputed });
    } catch (err) {
      tracker.fail('verify', (err as Error).message);
    }
  } else {
    try {
      const verified = runDeterministicVerification({
        findings: report.findings,
        context: contextFromReport(
          report,
          repoFiles,
          oldContents,
          addedLines,
          new Set(report.changes.map((c) => c.path)),
        ),
        minimumStatus: options.policy?.verification.minimumStatus ?? 'UNVERIFIED',
      });
      report.findings = verified.findings;
      if (verified.withheld.length) report.withheldFindings = verified.withheld;
      report.fixes = report.fixes.filter((fix) => report.findings.some((f) => f.id === fix.findingId));
      const summary = verified.summary;
      if (!pipelineInfo) {
        pipelineInfo = {
          plan: { reviewers: [], decisions: [], considered: [], maxReviewers: 0, route: { provider: 'none', model: 'none' }, truncated: false },
          reviewerRuns: [],
          totals: { durationMs: 0, tokens: { prompt: 0, completion: 0 }, proposed: 0, accepted: 0, evidenceRejected: 0 },
          cancelled: false,
          verification: summary,
        };
      } else {
        pipelineInfo = { ...pipelineInfo, verification: summary };
      }
      tracker.complete('verify',
        `${summary.confirmed} confirmed, ${summary.likely} likely, ${summary.unverified} unverified, `
        + `${summary.disputed} disputed, ${summary.rejected} rejected (static evidence only).`,
        { confirmed: summary.confirmed, likely: summary.likely, rejected: summary.rejected, disputed: summary.disputed });
    } catch (err) {
      tracker.fail('verify', (err as Error).message);
    }
  }
  checkAbort('risk');

  // 11. Risk and summary.
  tracker.start('risk');
  const affected = new Set([...graph.directlyImpacted, ...graph.indirectlyImpacted]).size;
  const risk = assessRisk({
    findings: report.findings,
    changes: report.changes,
    tests: report.tests,
    affectedComponents: affected,
    documentationFindings: docFindings.length,
    changedLines: report.changes.reduce((n, c) => n + c.additions + c.deletions, 0),
  });
  report.risk = risk;
  // One assessment of the AI half, recorded on the report before the summary is
  // computed, so every interface reads the same answer.
  const aiStatus = assessAi({
    requested: settings.aiEnabled && Boolean(options.hooks?.runReviewers || options.enrichers?.length),
    required: Boolean(options.aiRequired),
    aiEnabled: settings.aiEnabled,
    ...(tracker.snapshot().find((s) => s.id === 'ai') ? { stage: tracker.snapshot().find((s) => s.id === 'ai')! } : {}),
    ...(pipelineInfo ? { info: pipelineInfo } : {}),
    ...(report.provider.message
      ? { unavailableReason: report.provider.message }
      : options.providerReason
        ? { unavailableReason: options.providerReason }
        : {}),
    aiRequests: report.ai?.requests ?? 0,
    ...(report.provider.model ? { providerModel: report.provider.model } : {}),
  });
  if (pipelineInfo) {
    report.review = { ...pipelineInfo, ruleRuns: ruleExecutions, ai: aiStatus };
  } else {
    // Always record the AI state, even when nothing else populated `review`:
    // the deterministic-only case is exactly the one that must not look like an
    // AI review, so it needs a place to say so.
    report.review = {
      plan: { reviewers: [], decisions: [], considered: [], maxReviewers: 0, route: { provider: 'none', model: 'none' }, truncated: false },
      reviewerRuns: [],
      totals: { durationMs: 0, tokens: { prompt: 0, completion: 0 }, proposed: 0, accepted: 0, evidenceRejected: 0 },
      cancelled: false,
      ruleRuns: ruleExecutions,
      verification: emptyVerificationSummary(false),
      ai: aiStatus,
    };
  }
  if (options.policySnapshot) report.policy = options.policySnapshot;
  report.stages = tracker.snapshot();
  report.summary = summarize(report, tracker.snapshot(), truncationNote);
  tracker.complete('risk', `${risk.level} ${risk.score}/100 from ${risk.factors.length} factor(s).`, { score: risk.score });
  checkAbort('persist');

  // 11. Persist.
  tracker.start('persist');
  const previousCompleteness = report.summary.completeness;
  report.stages = tracker.snapshot();
  report.summary = { ...report.summary, completeness: previousCompleteness };
  if (options.persist !== false && store) {
    try {
      // Freeze timing before persisting so the stored report and its duration
      // describe the same run. The persist stage is marked completed in the
      // saved snapshot; a write failure below overrides it with `failed`.
      report.durationMs = Date.now() - startedAt;
      tracker.complete('persist', 'Saved to .diffwise/reviews.', { persisted: 1 });
      report.stages = tracker.snapshot();
      await store.saveReport({ ...report, stages: tracker.snapshot() });
    } catch (err) {
      tracker.fail('persist', (err as Error).message);
      report.summary = { ...report.summary, completeness: 'partial', completenessNote: `Review could not be persisted: ${(err as Error).message}` };
    }
  } else {
    tracker.skip('persist', 'Persistence disabled for this run.');
  }
  report.stages = tracker.snapshot();
  report.durationMs = Date.now() - startedAt;
  report.summary = summarize(report, tracker.snapshot(), truncationNote);
  return report;
}

interface AssembleInput {
  id: string;
  startedAt: number;
  target: ReviewTarget;
  repo: RepositoryInfo;
  settings: AnalysisSettings;
  stages: AnalysisStage[];
  changes: FileChange[];
  symbols: ChangedSymbol[];
  graph: GraphAnalysis;
  conventions: ReturnType<typeof detectConventions>;
  docs: DocumentationFile[];
  docFindings: DocumentationFinding[];
  findings: Finding[];
  tests: TestAnalysis;
  agent: ReturnType<typeof buildAgentContext>;
  fixes: FixSolution[];
  provider: ProviderStatus;
  knowledge: KnowledgeItem[];
  completenessNote?: string;
  execution: ExecutionMetadata;
}

function assembleReport(input: AssembleInput): ReviewReport {
  const groups: ChangeGroup[] = groupChanges(input.changes, input.symbols);
  const report: ReviewReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    id: input.id,
    createdAt: new Date(input.startedAt).toISOString(),
    durationMs: Date.now() - input.startedAt,
    target: input.target,
    repository: input.repo,
    summary: {
      changedFiles: input.changes.length,
      changedSymbols: input.symbols.length,
      affectedComponents: new Set([...input.graph.directlyImpacted, ...input.graph.indirectlyImpacted]).size,
      findingsBySeverity: countSeverities(input.findings),
      findingsByCategory: countCategories(input.findings),
      documentationFindings: input.docFindings.length,
      testsExecuted: input.tests.execution?.status === 'passed' || input.tests.execution?.status === 'failed',
      aiUsed: false,
      completeness: 'complete',
      ...(input.completenessNote ? { completenessNote: input.completenessNote } : {}),
    },
    risk: {
      score: 0, level: 'low', summary: 'Not computed yet.', factors: [], method: '',
    },
    stages: input.stages,
    changes: input.changes,
    changeGroups: groups,
    symbols: input.symbols,
    architecture: {
      graph: input.graph,
      conventions: input.conventions,
      violations: input.findings.filter((f) => f.category === 'architecture'),
    },
    documentation: { files: input.docs, findings: input.docFindings },
    findings: input.findings,
    tests: input.tests,
    agent: input.agent,
    fixes: input.fixes,
    appliedFixes: [],
    provider: input.provider,
    knowledge: input.knowledge,
    execution: input.execution,
    verification: [],
    decisions: [],
    requirements: [],
    contextSources: [],
    state: 'PENDING',
    settings: {
      maxFiles: input.settings.maxFiles,
      maxFileBytes: input.settings.maxFileBytes,
      ignoreGlobs: input.settings.ignoreGlobs,
      aiEnabled: input.settings.aiEnabled,
      sendRepositoryContent: input.settings.sendRepositoryContent,
      providerId: input.settings.providerId,
      ...(input.settings.model ? { model: input.settings.model } : {}),
      ...(input.settings.verificationCommand ? { verificationCommand: input.settings.verificationCommand } : {}),
    },
  };
  void buildContextPack;
  void basename;
  void parseSource;
  return report;
}

/** Deduplicate, assign stable ids and sort by severity. */
export function finalizeFindings(candidates: Array<Omit<Finding, 'id' | 'source' | 'validated'>>, existing: Finding[]): Finding[] {
  const all: Finding[] = [];
  for (const c of candidates) {
    all.push({
      ...c,
      id: stableId('DW', c.ruleId, c.file, c.range.start, c.title.slice(0, 40)),
      source: 'deterministic',
    });
  }
  all.push(...existing);

  const kept: Finding[] = [];
  for (const f of all) {
    const duplicate = kept.find((k) => k.category === f.category
      && k.file === f.file
      && overlaps(k.range, f.range)
      && similarityTitle(k.title, f.title) > 0.45);
    if (!duplicate) { kept.push(f); continue; }
    // Prefer the deterministic finding, but keep AI evidence and a higher severity.
    if (SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[duplicate.severity]) duplicate.severity = f.severity;
    for (const e of f.evidence) {
      if (!duplicate.evidence.some((x) => x.note === e.note && x.file === e.file)) duplicate.evidence.push(e);
    }
    if (f.source === 'ai' && f.validated) duplicate.tags = [...new Set([...duplicate.tags, 'ai-corroborated'])];
  }
  return kept.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.file.localeCompare(b.file) || a.range.start - b.range.start);
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start <= b.end && b.start <= a.end;
}

function similarityTitle(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const tb = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

function alignFindingId(id: string, findings: Finding[]): string {
  return findings.some((f) => f.id === id) ? id : (findings[0]?.id ?? id);
}

/**
 * Decide, once, whether the AI half of the review actually ran.
 *
 * `requested` is what the caller asked for (AI enabled *and* an AI path wired),
 * not what the provider happened to do. A requested stage that did not complete
 * makes the review partial — a deterministic-only review is a legitimate
 * outcome, but it is never presented as a completed AI review.
 */
function assessAi(input: {
  requested: boolean;
  required: boolean;
  aiEnabled: boolean;
  stage?: AnalysisStage;
  info?: ReviewPipelineInfo;
  unavailableReason?: string;
  /** Model requests recorded by the enricher path (the legacy AI reviewer). */
  aiRequests?: number;
  providerModel?: string;
}): AiReviewStatus {
  const runs = input.info?.reviewerRuns ?? [];
  const active = runs.filter((r) => r.status !== 'skipped');
  const completed = active.filter((r) => r.status === 'completed');
  const failed = active.filter((r) => r.status === 'failed');
  const skipped = runs.length - active.length;
  const planned = input.info?.plan.reviewers.length ?? 0;
  const verificationSummary = input.info?.verification;
  const verification = {
    opinions: verificationSummary?.opinions ?? 0,
    // Without an explicit count, the verdict buckets are the count: every finding
    // that received any verdict is a group. Guessing anything else would be worse.
    groups: verificationSummary?.groups
      ?? (verificationSummary
        ? verificationSummary.confirmed + verificationSummary.likely + verificationSummary.unverified
          + verificationSummary.rejected + verificationSummary.disputed
        : 0),
    deferred: verificationSummary?.deferred ?? 0,
  };
  const models = [...new Set(completed.map((r) => r.model).filter((m): m is string => Boolean(m)))];

  if (!input.requested) {
    const status: AiReviewStatus['status'] = input.aiEnabled ? 'unavailable' : 'disabled';
    return {
      status,
      requested: false,
      required: input.required,
      reviewers: { planned: 0, completed: 0, failed: 0, skipped: 0 },
      verification,
      ...(models.length ? { models: { review: models.join(', ') } } : {}),
      reason: input.aiEnabled
        ? (input.unavailableReason ?? 'No AI provider was configured for this run.')
        : 'AI is disabled in settings (ai.enabled=false).',
    };
  }

  const stageFailed = input.stage?.status === 'failed' || input.stage?.status === 'cancelled';

  // There are two AI paths: the reviewer session (records reviewerRuns) and the
  // enricher (records usage only). The second is a real AI review, so it must not
  // be reported as "no reviewer produced a usable result".
  if (active.length === 0 && (input.aiRequests ?? 0) > 0) {
    return {
      status: stageFailed ? 'failed' : 'complete',
      requested: true,
      required: input.required,
      reviewers: { planned: 0, completed: 0, failed: 0, skipped: 0 },
      verification,
      ...(input.providerModel ? { models: { review: input.providerModel } } : {}),
      ...(stageFailed ? { reason: input.stage?.error ?? 'The AI stage failed.' } : {}),
    };
  }
  const reason = input.stage?.error
    ?? input.info?.skippedReason
    ?? (completed.length === 0
      ? 'The AI stage ran but no reviewer produced a usable result.'
      : failed.length > 0
        ? `${failed.length} reviewer(s) did not complete.`
        : undefined);
  const status: AiReviewStatus['status'] = stageFailed && completed.length === 0
    ? 'failed'
    : completed.length === 0
      ? 'partial'
      : failed.length > 0
        ? 'partial'
        : 'complete';

  return {
    status,
    requested: true,
    required: input.required,
    reviewers: { planned, completed: completed.length, failed: failed.length, skipped },
    verification,
    ...(models.length
      ? { models: { review: models.length === 1 ? models[0]! : models.join(', ') } }
      : {}),
    ...(status === 'complete' || !reason ? {} : { reason }),
  };
}

function summarize(report: ReviewReport, stages: AnalysisStage[], note?: string): ReviewReport['summary'] {
  const failed = stages.filter((s) => s.status === 'failed');
  // A stage that completed with an error produced a partial result (for example
  // findings succeeded but fix generation failed). The report must not claim
  // completeness in that case.
  const degraded = stages.filter((s) => s.status === 'completed' && s.error);
  const ai = report.review?.ai;
  // Requested-and-not-complete is partial; so is required-but-never-requested
  // (a team that requires AI must not get a "complete" badge without it).
  const aiIncomplete = Boolean(ai && ai.status !== 'complete' && (ai.requested || ai.required));
  const completeness: ReviewReport['summary']['completeness'] = failed.length > 0 || degraded.length > 0 || aiIncomplete
    ? 'partial'
    : 'complete';
  const notes: string[] = [];
  if (note) notes.push(note);
  if (failed.length) notes.push(`Failed stages: ${failed.map((s) => `${s.label} (${s.error ?? 'unknown error'})`).join('; ')}.`);
  if (degraded.length) notes.push(`Degraded stages: ${degraded.map((s) => `${s.label} (${s.error})`).join('; ')}.`);
  // The AI stage's own error is already reported above; repeating the same
  // sentence in the AI note makes a two-line banner out of a one-line problem.
  const aiReasonRepeated = Boolean(ai?.reason)
    && [...failed, ...degraded].some((s) => s.id === 'ai' && (s.error ?? '').trim() === ai!.reason!.trim());
  if (ai && ai.status !== 'complete') {
    // Say what the AI half did, not just that something was skipped: the stage is
    // the difference between an AI review and a deterministic one.
    const why = ai.reason && !aiReasonRepeated ? `: ${ai.reason.replace(/\.\s*$/, '')}` : '';
    notes.push(`AI review ${ai.status}${why}. Findings come from deterministic rules and static verification only.`);
  }
  return {
    changedFiles: report.changes.length,
    changedSymbols: report.symbols.length,
    affectedComponents: new Set([...report.architecture.graph.directlyImpacted, ...report.architecture.graph.indirectlyImpacted]).size,
    findingsBySeverity: countSeverities(report.findings),
    findingsByCategory: countCategories(report.findings),
    documentationFindings: report.documentation.findings.length,
    testsExecuted: report.tests.execution?.status === 'passed' || report.tests.execution?.status === 'failed',
    // AI counts as used when an enricher reported usage *or* the reviewer
    // pipeline actually completed a review. Keying only on `report.ai` made a
    // successful reviewer pass print "AI: not used".
    aiUsed: Boolean(report.ai)
      || Boolean(report.review?.reviewerRuns?.some((run) => run.status === 'completed'))
      || (report.ai?.requests ?? 0) > 0,
    completeness,
    ...(notes.length ? { completenessNote: notes.join(' ') } : {}),
  };
}

function countSeverities(findings: Finding[]): ReviewReport['summary']['findingsBySeverity'] {
  const out = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) out[f.severity]++;
  return out;
}

function countCategories(findings: Finding[]): ReviewReport['summary']['findingsByCategory'] {
  const out: ReviewReport['summary']['findingsByCategory'] = {};
  for (const f of findings) out[f.category] = (out[f.category] ?? 0) + 1;
  return out;
}

function buildKnowledge(docs: DocumentationFile[], texts: Map<string, string>, events: ReturnType<typeof buildAgentContext>['events']): KnowledgeItem[] {
  const items: KnowledgeItem[] = [];
  for (const d of docs.slice(0, 12)) {
    const text = texts.get(d.path) ?? '';
    const para = text.split(/\n\s*\n/).find((p) => p.trim() && !p.trim().startsWith('#')) ?? text;
    items.push({
      id: stableId('kn', d.path),
      title: d.title ?? d.path,
      kind: 'doc',
      path: d.path,
      text: para.replace(/\s+/g, ' ').trim().slice(0, 500),
    });
  }
  for (const e of events.filter((x) => x.type === 'decision' || x.type === 'constraint').slice(0, 15)) {
    items.push({ id: e.id, title: e.title, kind: 'decision', text: e.detail, ...(e.files?.[0] ? { path: e.files[0] } : {}) });
  }
  return items;
}

function isReadable(path: string): boolean {
  return /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs|py|java|kt|go|rs|cs|rb|php|sql|json|ya?ml|md|mdx|toml|mod|gradle|xml|txt|env|example)$/i.test(path)
    || /(^|\/)(Dockerfile|Makefile|README)$/i.test(path);
}

function emptyGraph(changes: FileChange[]): GraphAnalysis {
  return {
    edges: [], importers: {}, changedFiles: changes.map((c) => c.path),
    directlyImpacted: [], indirectlyImpacted: [], impactDepth: {}, cycles: [],
    newCoupling: [], removedCoupling: [], boundaryChanges: [], modules: [],
    fileCount: 0, edgeCount: 0,
  };
}

async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      const item = items[idx];
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

export { RULES, STAGE_DEFS };
