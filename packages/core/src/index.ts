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
export { parsePatch, applyPatch, applyPatchToContents, validatePatch, revertPatch, PatchError, isSafeRelativePath } from './fixes/patch';
export type { PatchFile, ApplyResult } from './fixes/patch';
export { detectLanguage, isTestFile, isDocumentationFile, isMigrationFile, isRouteFile, moduleOf, baseName } from './analysis/languages';
export { matchesAnyGlob, globToRegExp } from './util/glob';
export { stableId, similarity, splitLines, truncate } from './util/text';
