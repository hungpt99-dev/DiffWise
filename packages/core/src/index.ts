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
export { loadDocuments, analyseDocumentation, docsToFindings, extractReferences, makeDocPatch } from './analysis/docAnalysis';
export { groupChanges } from './analysis/grouping';
export { assessRisk } from './analysis/risk';
export { buildAgentContext, makeAgentEvent, emptyAgentContext } from './agent/agentContext';
export { JsonReviewStore, SqliteReviewStore, openStore, listReviewFiles } from './store/store';
export type { ReviewStore, ReviewIndexEntry } from './store/store';
export { buildContextPack, redactSecrets } from './context/contextPack';
export type { ContextPack } from './context/contextPack';
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
