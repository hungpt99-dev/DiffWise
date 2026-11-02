/**
 * DiffWise application services — the layer every interface shares.
 */
export {
  DiffWiseService, ServiceError, TOOL_NAME, TOOL_VERSION, EmptyReviewError, finalizeFindings,
} from './service';
export type { ServiceOptions, ReviewRunOptions, ReviewRunResult } from './service';
export {
  analysisSettingsFrom, loadConfig, saveConfig, normalizeConfig, applyEnvOverrides, resolveProvider,
  DEFAULT_CONFIG, CONFIG_FILE, CONFIG_SCHEMA_VERSION, ROUTE_TASKS,
} from './config';
export type {
  DiffWiseConfig, LoadedConfig, ProviderConfigFile, QualityGateSeverity, ResolvedProvider, RouteTask, ProviderRouteConfig,
} from './config';
export { findRepoRoot, loadReportFiles, openRepoStore, resolveInside, storeDir, fileSignatures, WorkspaceError } from './repo';
export { runVerificationCommand } from './verify';
export type { VerificationOptions } from './verify';
export {
  applyFix, previewFix, rollbackFix, staleFiles, listJournals,
} from './fix';
export type { ApplyFixOptions, ApplyFixResult, FixPreview, TransactionJournal, TransactionEntry } from './fix';
export { buildStandaloneHtml, writeStandaloneHtml } from './html';
export type { HtmlExportOptions, StaticPayload } from './html';
export { loadWebAssets, CSP, embedJson, MissingWebAssetsError } from './assets';
export type { WebAssets } from './assets';
export { startReportServer, uiSettingsFor, waitForServer, describeListenError } from './server';
export type { ServerOptions, RunningServer } from './server';
export { runDoctor } from './doctor';
export type { DoctorCheck, DoctorOptions, DoctorResult, CheckStatus } from './doctor';
export {
  buildPlatform, defaultPlatform, attachVerification, publishFindings, verifyDeterministically,
  summariseProblems, DEFAULT_POLICY, reviewerSpec, verificationSummary,
} from './orchestrate';
export type { Platform, PlatformBuildInput } from './orchestrate';
export { loadPolicyFiles, readPolicyHistory, recordPolicyHistory } from './policyFile';
export type { LoadedPolicyFiles, PolicyFileProblem, PolicyHistoryEntry } from './policyFile';
export {
  loadWorkspaceState, createOrUpdateRule, deleteRule, setRuleEnabled, testRuleAgainstRepository,
  importRules, exportRules, saveDocumentationSources, listMcpStatus, listMcpTools, testMcpServer,
  upsertMcpServer, removeMcpServer, setMcpEnabled, callMcpTool, saveProviderProfile,
  removeProviderProfile, setProviderRouting, readWorkspaceFile,
} from './workspace';
export type { WorkspaceState, ProviderSummary } from './workspace';
export {
  McpClient, McpManager, loadMcpConfig, saveMcpConfig, normalizeMcpConfig, expandEnv, emptyPermissions,
  MCP_CONFIG_FILE, MCP_CONFIG_VERSION,
} from './mcp';
export type {
  McpConfig, McpServerConfig, McpPermissions, McpServerStatus, McpToolInfo, McpResourceInfo, McpCallResult, McpContextResult,
} from './mcp';
