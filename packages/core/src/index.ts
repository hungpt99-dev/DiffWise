/**
 * DiffWise core — deterministic analysis engine.
 *
 * The package has no dependency on VS Code, on a model provider, or on the
 * network. Everything exported here is testable in isolation.
 */
export * from './types';
export { GitClient, GitError, isInsideRepo } from './git/git';
export { parseUnifiedDiff, changedLineNumbers, makeUntracked, unquoteGitPath } from './git/diff';
export {
  runReview, finalizeFindings, EmptyReviewError, ReviewCancelledError, STAGE_DEFS, RULES,
} from './analysis/pipeline';
export type { ReviewEnricher, EnrichmentInput, EnrichmentResult, RunReviewOptions } from './analysis/pipeline';
export { diffSymbols, extractSymbols, extractAnySymbols, countReferences, parseSource } from './analysis/symbols';
export { buildGraph, detectConventions, extractImports, resolveImport } from './analysis/graph';
export { analyseTests } from './analysis/testAnalysis';
export { analyseImpact, serviceOf, moduleOfPath } from './analysis/impact';
export type { ImpactInput } from './analysis/impact';
export {
  buildDocumentationIndex, updateDocumentationIndex, retrieveDocumentation, documentationIndexSummary,
  categoriseDocument, isIndexableDocument, splitSections, sourceFor,
} from './docs/index';
export type { DocumentationIndexInput, DocumentationQuery } from './docs/index';
export {
  RuleStore, validateDraft, testRule, detectRuleConflicts, describeManaged, managedToDraft, ruleToYaml,
  readRepositoryFiles, RULE_CATEGORIES, RULE_CATEGORY_META, CUSTOM_PACK_ID, CUSTOM_RULES_DIR,
} from './rules/management';
export type {
  RuleDraft, ManagedRule, RuleTestMatch, RuleTestResult, RuleStoreOptions, TestRuleOptions,
} from './rules/management';
export { loadDocuments, analyseDocumentation, docsToFindings, extractReferences, makeDocPatch } from './analysis/docAnalysis';
export { groupChanges } from './analysis/grouping';
export { assessRisk } from './analysis/risk';
export { buildAgentContext, makeAgentEvent, emptyAgentContext } from './agent/agentContext';
export { JsonReviewStore, SqliteReviewStore, openStore, listReviewFiles } from './store/store';
export type { ReviewStore, ReviewIndexEntry } from './store/store';
export { buildContextPack, redactSecrets } from './context/contextPack';
export type { ContextPack } from './context/contextPack';
export { buildChangeFirstContext } from './context/changeFirst';
export type { ChangeFirstOptions, ChangeFirstPack, ContextSectionSummary } from './context/changeFirst';
export { codeWindows, selectWindows, mergeRanges, renderWindows } from './context/windows';
export type { CodeWindow, WindowOptions, RenderedWindows } from './context/windows';
export { estimateTokens, estimatePromptTokens, estimateJsonTokens, tokenFamilyFor } from './tokens/estimate';
export type { TokenFamily, ChatPromptPart } from './tokens/estimate';
export { TokenBudget, packSections, clipToTokens } from './tokens/budget';
export type { TokenBudgetPlan, PackableSection, PackedSection, PackResult, PackOptions, BudgetSource } from './tokens/budget';
export { resolvePrice, computeCost } from './tokens/pricing';
export type { ModelPrice, PriceTable, CostEstimate, TokenUsageLike } from './tokens/pricing';
export { UsageMeter } from './tokens/usage';
export type { AiTask, TaskUsageRecord, UsageSummary, UsageEntry } from './tokens/usage';
export { ContentCache, contentKey } from './cache/contentCache';
export type { CacheOptions, CacheStats, CacheRecord } from './cache/contentCache';
export {
  validateReport, assertReport, migrateReport, parseReport, findingsAtOrAbove,
  ReportValidationError, severityRank,
} from './report/schema';
export type { ReportValidationIssue, ReportValidationResult } from './report/schema';
export { buildReviewEnvelope, JSON_SCHEMA_VERSION } from './report/envelope';
export type { ReviewEnvelope } from './report/envelope';
export { buildSarif, validateSarif, SARIF_VERSION, SARIF_SCHEMA } from './report/sarif';
export type { SarifLog, SarifOptions } from './report/sarif';
export { parsePatch, applyPatch, applyPatchToContents, validatePatch, revertPatch, PatchError, isSafeRelativePath } from './fixes/patch';
export type { PatchFile, ApplyResult } from './fixes/patch';
export { detectLanguage, isTestFile, isDocumentationFile, isMigrationFile, isRouteFile, moduleOf, baseName } from './analysis/languages';
export { matchesAnyGlob, globToRegExp } from './util/glob';
export { stableId, similarity, splitLines, truncate, locateQuote, normalizeWhitespace, clamp } from './util/text';

// Review platform — orchestration contracts and selection.
export * from './review/types';
export { REVIEWER_SPECS, DEFAULT_MAX_REVIEWERS, reviewerSpec, allReviewerSpecs } from './review/registry';
export { selectReviewers, explainPlan } from './review/select';
export type { SelectionInput, ReviewerPolicyInput } from './review/select';
export { runReviewers, validateProposalEvidence, DEFAULT_REVIEWER_CONCURRENCY } from './review/orchestrator';
export * from './review/hooks';

// Review platform — finding verification.
export * from './verification/types';
export { normalizeCandidate, groupCandidates, jaccard, tokenize, rangesOverlap } from './verification/normalize';
export type { FindingGroup, NormalizedFinding } from './verification/normalize';
export { runDeterministicChecks } from './verification/checks';
export {
  prepareVerification, finalizeVerification, screenOpinions, classifyEvidence,
  passesMinimum, verificationSummary,
} from './verification/engine';
export type { PreparedVerification, VerificationOutcome } from './verification/engine';
export {
  runDeterministicVerification, applyOutcomes, splitByPolicy, contextFromReport,
} from './verification/run';
export type { DeterministicVerificationResult } from './verification/run';

// Review platform — policy and approvals.
export * from './policy/types';
export { resolvePolicy, normalizePolicyLayer, snapshotPolicy, isSuppressed, activeSuppressions } from './policy/resolve';
export { requiredApproval, evaluateApproval, computeState, blockingFindings, severityBlocks } from './policy/approval';
export type { ApprovalInput, StateInput } from './policy/approval';

// Review platform — declarative rules and the rule registry.
export {
  validateRuleDefinition, satisfiesVersion, regexRisk,
} from './rules/definition';
export type {
  RuleDefinition, RuleDetection, RuleMode, RuleValidationIssue, RuleValidationResult, RuleProvenance,
  PatternDetection, AstDetection, AbsenceDetection, ForbiddenImportDetection,
} from './rules/definition';
export { runDeclarativeRule } from './rules/declarative';
export {
  loadRulePack, loadRulePacks, loadRepositoryRulePacks, linkRulePacks, exportRulePack,
} from './rules/loader';
export type { LoadedRulePack, RulePackMeta, LoadRulePacksResult } from './rules/loader';
export {
  runRuleSet, listRules, describeBuiltin, describeDeclarative, missingRequiredPacks, isExcluded,
} from './rules/registry';
export type { RuleDescriptor, RuleExecutionRecord, RuleRunResult, RuleStatus } from './rules/registry';

// Review platform — verification discovery and planning.
export { discoverCommands, targetedCommand } from './testplan/discover';
export { buildVerificationPlan, buildReproductionPlan } from './testplan/plan';
export type {
  DiscoveredCommand, VerificationPlan, VerificationPlanItem, DiscoveryInput, PlanInput,
} from './testplan/types';

// Review platform — evaluation.
export * from './evaluation/types';
export { matchCase, computeMetrics, scopeStatement, emptyCaseResult, overlap } from './evaluation/metrics';
export { loadDataset, runEvaluation } from './evaluation/runner';
export type { EvaluationOptions } from './evaluation/runner';
