/**
 * DiffWise application services — the layer every interface shares.
 */
export {
  DiffWiseService, ServiceError, TOOL_NAME, TOOL_VERSION, EmptyReviewError, finalizeFindings,
} from './service';
export type { ServiceOptions, ReviewRunOptions, ReviewRunResult } from './service';
export {
  loadConfig, saveConfig, normalizeConfig, applyEnvOverrides, analysisSettingsFrom, resolveProvider,
  DEFAULT_CONFIG, CONFIG_FILE, CONFIG_SCHEMA_VERSION,
} from './config';
export type { DiffWiseConfig, LoadedConfig, ProviderConfigFile, QualityGateSeverity, ResolvedProvider } from './config';
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
