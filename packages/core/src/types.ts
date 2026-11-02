/**
 * DiffWise core domain model.
 *
 * Everything in this file is transport-safe: it is serialised into the report
 * that the VS Code webview and the MCP server consume, so it must stay free of
 * Node-only types and of provider-specific shapes.
 */

import type { FindingVerification } from './verification/types';
import type { ApprovalStatus, ReviewDecision, ReviewPipelineInfo, ReviewState } from './review/types';
import type { EffectivePolicySnapshot } from './policy/types';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export type Confidence = 'verified' | 'high' | 'medium' | 'low';

export type FindingCategory =
  | 'correctness'
  | 'security'
  | 'performance'
  | 'reliability'
  | 'concurrency'
  | 'database'
  | 'api-contract'
  | 'maintainability'
  | 'architecture'
  | 'tests'
  | 'documentation'
  | 'error-handling'
  | 'resources'
  | 'configuration';

export const CATEGORY_LABEL: Record<FindingCategory, string> = {
  correctness: 'Correctness',
  security: 'Security',
  performance: 'Performance',
  reliability: 'Reliability',
  concurrency: 'Concurrency',
  database: 'Database & transactions',
  'api-contract': 'API compatibility',
  maintainability: 'Maintainability',
  architecture: 'Architecture',
  tests: 'Test coverage',
  documentation: 'Documentation',
  'error-handling': 'Error handling',
  resources: 'Resource management',
  configuration: 'Configuration & deployment',
};

/**
 * `problem`   – demonstrated defect with deterministic evidence
 * `risk`      – concrete hazard that depends on runtime conditions
 * `recommendation` – improvement, not a defect
 * `question`  – needs human verification before it can be classified
 */
export type FindingKind = 'problem' | 'risk' | 'recommendation' | 'question';

export type EvidenceKind = 'diff' | 'code' | 'doc' | 'graph' | 'test' | 'agent' | 'command';

export interface Evidence {
  kind: EvidenceKind;
  file?: string;
  line?: number;
  endLine?: number;
  /** Exact excerpt taken from the repository. Never model-authored prose. */
  snippet?: string;
  note: string;
  /** How this evidence was obtained. `human` and `runtime` are never produced by a model. */
  source: 'deterministic' | 'ai' | 'git' | 'test-run' | 'agent-record' | 'document' | 'human' | 'runtime';
}

export interface Finding {
  id: string;
  title: string;
  description: string;
  severity: Severity;
  category: FindingCategory;
  kind: FindingKind;
  confidence: Confidence;
  file: string;
  range: LineRange;
  evidence: Evidence[];
  whyItMatters: string;
  consequences: string[];
  reproduction?: string;
  recommendation: string;
  ruleId: string;
  source: 'deterministic' | 'ai';
  tags: string[];
  /** Set when the finding came from the model and passed evidence validation. */
  validated?: boolean;
  /** Reviewer that produced it, when it came from a specialised reviewer. */
  reviewerId?: string;
  /** Model that produced an AI finding, after task routing. */
  model?: string;
  /**
   * The model's own short explanation of why this is a defect (bounded).
   * Distinct from `whyItMatters`, which states the consequence.
   */
  reasoning?: string;
  /** Ids of requirements (Jira/PR/issue) this finding relates to. */
  requirements?: string[];
  /** Rule pack provenance, e.g. `security/java-spring@1.2.0`. */
  rulePack?: string;
  /** Independent verification verdict. Absent only for legacy v2 reports. */
  verification?: FindingVerification;
  /** Original severity before verification adjusted it, when it changed. */
  severityAssessed?: Severity;
}

export interface LineRange {
  start: number;
  end: number;
}

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffLine {
  kind: 'add' | 'del' | 'context';
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Raw `@@ ... @@` header, including any trailing function context. */
  header: string;
  lines: DiffLine[];
}

export interface FileChange {
  /** Repo-relative, POSIX separators. */
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: Hunk[];
  /** Unified diff for this file only (without the `diff --git` preamble removed). */
  patch: string;
  language: Language;
  /** True when the file was untracked and materialised from the working tree. */
  untracked?: boolean;
}

export type Language =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'jsx'
  | 'python'
  | 'java'
  | 'kotlin'
  | 'go'
  | 'rust'
  | 'csharp'
  | 'ruby'
  | 'php'
  | 'sql'
  | 'json'
  | 'yaml'
  | 'markdown'
  | 'other';

export interface ChangedSymbol {
  id: string;
  name: string;
  kind: 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum' | 'variable' | 'unknown';
  file: string;
  range: LineRange;
  container?: string;
  exported: boolean;
  change: 'added' | 'removed' | 'modified';
  /** Changed lines inside the symbol, in the analysed (new) file coordinates. */
  changeRanges: LineRange[];
  signature: string;
  signatureChanged: boolean;
  /** Number of references found elsewhere in the repository. */
  referenceCount: number;
  /** Up to three files that reference this symbol (evidence for API findings). */
  referenceExamples?: string[];
}

export type EdgeKind = 'import' | 'call' | 'extends' | 'implements' | 'type-ref';

export interface DependencyEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  file: string;
  line: number;
  resolution: 'verified' | 'inferred';
}

export interface Component {
  id: string;
  name: string;
  kind: 'module' | 'file';
  path?: string;
  files: string[];
  changed: boolean;
}

export interface GraphAnalysis {
  /** File-level dependency edges (imports + inferred calls) across the repository. */
  edges: DependencyEdge[];
  /** Reverse edges: file -> files that import it. */
  importers: Record<string, string[]>;
  changedFiles: string[];
  directlyImpacted: string[];
  indirectlyImpacted: string[];
  /** Impacted node ids with the distance from a changed file (1 = direct). */
  impactDepth: Record<string, number>;
  cycles: string[][];
  newCoupling: Array<{ from: string; to: string; line: number }>;
  removedCoupling: Array<{ from: string; to: string }>;
  boundaryChanges: Array<{ file: string; reason: string }>;
  modules: Component[];
  fileCount: number;
  edgeCount: number;
}

export interface DocumentationFile {
  path: string;
  kind: 'readme' | 'adr' | 'markdown' | 'openapi' | 'asyncapi' | 'doc';
  title?: string;
  /** Identifiers (env vars, symbols, routes, commands) referenced by the document. */
  references: DocReference[];
  /** ISO date from front-matter `last_reviewed`/`updated`, when present. */
  lastReviewed?: string;
  /** Configured category, when the document came from a managed source. */
  category?: DocumentCategory;
  /** Lower is stronger; used to bound retrieval. */
  priority?: number;
}

export type DocumentCategory =
  | 'readme'
  | 'architecture'
  | 'adr'
  | 'openapi'
  | 'asyncapi'
  | 'protobuf'
  | 'sql'
  | 'business'
  | 'technical'
  | 'standards'
  | 'contract'
  | 'other';

/** A documentation source a project has connected to the review. */
export interface DocumentationSource {
  /** Repository-relative file or glob, e.g. `docs/**`. */
  path: string;
  category?: DocumentCategory;
  /** Lower is stronger. Defaults to the category's built-in priority. */
  priority?: number;
  enabled?: boolean;
  /** Modules or services this source describes. */
  modules?: string[];
}

export interface DocumentationSection {
  id: string;
  docPath: string;
  heading: string;
  level: number;
  startLine: number;
  endLine: number;
  text: string;
  contentHash: string;
  references: string[];
  category: DocumentCategory;
}

export interface DocumentationIndexEntry {
  path: string;
  category: DocumentCategory;
  priority: number;
  contentHash: string;
  bytes: number;
  title: string;
  sections: DocumentationSection[];
  modules?: string[];
  /** Set when another document has identical content. */
  duplicateOf?: string;
  indexedAt: string;
}

export interface DocumentationIndex {
  version: 1;
  generatedAt: string;
  sources: DocumentationSource[];
  entries: DocumentationIndexEntry[];
  stats: {
    documents: number;
    sections: number;
    bytes: number;
    duplicates: number;
    reused?: number;
    added?: number;
    changed?: number;
    removed?: number;
  };
}

/** The bounded slice of documentation a review actually consulted. */
export interface DocRetrieval {
  generatedAt: string;
  query: { files: string[]; symbols: string[]; terms: string[]; categories?: DocumentCategory[] };
  sections: Array<{
    document: string;
    heading: string;
    startLine: number;
    endLine: number;
    category: DocumentCategory;
    text: string;
    score: number;
    why: string;
    truncated: boolean;
  }>;
  consideredSections: number;
  skipped: string[];
  truncated: boolean;
  durationMs: number;
}

export interface DocReference {
  value: string;
  kind: 'symbol' | 'env' | 'route' | 'command' | 'file' | 'field';
  line: number;
}

export interface DocumentationFinding {
  id: string;
  document: string;
  status: 'outdated' | 'missing' | 'conflict' | 'review';
  title: string;
  description: string;
  reason: string;
  codeEvidence: Evidence[];
  docEvidence: Evidence[];
  suggestedUpdate: string;
  patch?: DocPatch;
  confidence: Confidence;
  severity: Severity;
}

export interface DocPatch {
  document: string;
  diff: string;
  applies: boolean;
  reason?: string;
}

export interface TestFile {
  path: string;
  framework: 'vitest' | 'jest' | 'mocha' | 'pytest' | 'junit' | 'go-test' | 'unknown';
  /** Source files this test appears to cover, resolved by path and by name. */
  targets: string[];
  symbols: string[];
  testCount: number;
}

export interface TestAnalysis {
  files: TestFile[];
  /** Changed source files with no covering test file. */
  uncoveredChanges: string[];
  /** Changed symbols never referenced by any test file. */
  uncoveredSymbols: Array<{ file: string; symbol: string }>;
  deletedTests: string[];
  suggestions: Array<{ title: string; file: string; scenarios: string[]; rationale: string }>;
  execution?: TestExecution;
}

export interface TestExecution {
  command: string;
  startedAt: string;
  durationMs: number;
  exitCode: number | null;
  /** `not-run` is recorded whenever the command was skipped or refused. */
  status: 'passed' | 'failed' | 'not-run' | 'timed-out';
  outputTail: string;
  ranBy: 'user-command' | 'verification-after-fix';
  relatedTestsExecuted: boolean;
  /** Verification level this command belongs to (v3). */
  level?: 'static' | 'typecheck' | 'lint' | 'build' | 'unit' | 'integration' | 'contract' | 'e2e' | 'security' | 'custom';
  /** Where the command came from. A model-suggested command is never executed. */
  commandSource?: 'config' | 'policy' | 'approval' | 'discovered';
  /** Files or suites the run was scoped to (targeted verification). */
  targets?: string[];
}

export interface ChangeGroup {
  id: string;
  title: string;
  purpose: string;
  module: string;
  files: string[];
  symbols: string[];
  changeTypes: Array<'added' | 'removed' | 'modified'>;
  additions: number;
  deletions: number;
  /** How the purpose was derived, so readers can judge it. */
  purposeBasis: 'symbol-names' | 'diff-content' | 'agent-intent' | 'commit-message';
  evidence: Evidence[];
}

export interface RiskFactor {
  id: string;
  label: string;
  /** Contribution in points (can be negative for mitigating factors). */
  points: number;
  maxPoints: number;
  explanation: string;
  evidence: Evidence[];
}

export interface RiskAssessment {
  /** 0-100, sum of clamped factor contributions. Always shown with the factors. */
  score: number;
  level: 'low' | 'moderate' | 'high' | 'severe';
  summary: string;
  factors: RiskFactor[];
  /** Deliberately conservative: methods used and their limits. */
  method: string;
}

export interface AnalysisStage {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  detail?: string;
  error?: string;
  /** Structured counts, e.g. { files: 12 } */
  metrics?: Record<string, number | string>;
}

export interface ReviewTarget {
  mode: 'working' | 'staged' | 'branch' | 'commits' | 'files';
  base?: string;
  head?: string;
  paths?: string[];
  label: string;
}

export interface RepositoryInfo {
  root: string;
  name: string;
  branch: string;
  headCommit: string;
  headSubject: string;
  remoteUrl?: string;
  /** Languages detected by file extension, ordered by file count. */
  languages: Array<{ language: Language; files: number }>;
  packageManager?: string;
  frameworkHints: string[];
  fileCount: number;
}

export interface ArchitectureInfo {
  graph: GraphAnalysis;
  /** Repository-level conventions the change is compared against. */
  conventions: Convention[];
  violations: Finding[];
  /** System-level change impact with per-relationship provenance (additive). */
  impact?: ImpactAnalysis;
}

export type ImpactDimension =
  | 'code'
  | 'module'
  | 'service'
  | 'api'
  | 'database'
  | 'event'
  | 'configuration'
  | 'testing'
  | 'documentation';

/**
 * `static` is a resolved parser fact, `configured` comes from policy or a
 * factory, `documentation` from a document, `mcp` from an external server, and
 * `historical`/`ai` are never presented as a proven dependency.
 */
export type ImpactProvenance = 'static' | 'configured' | 'documentation' | 'mcp' | 'historical' | 'ai';

export type ImpactRelation =
  | 'CALLS' | 'IMPORTS' | 'IMPLEMENTS' | 'EXTENDS' | 'DEPENDS_ON' | 'EXPOSES'
  | 'CONSUMES' | 'PRODUCES' | 'READS' | 'WRITES' | 'TESTS' | 'DOCUMENTS'
  | 'CONFIGURES' | 'BREAKS' | 'CHANGES' | 'ALTERS';

export interface ImpactItem {
  id: string;
  dimension: ImpactDimension;
  label: string;
  detail: string;
  /** True when a changed file itself carries the relationship. */
  direct: boolean;
  relation: ImpactRelation;
  confidence: Confidence;
  provenance: ImpactProvenance;
  file?: string;
  line?: number;
  symbol?: string;
  module?: string;
  service?: string;
  evidence: Evidence[];
}

export interface ImpactAnalysis {
  generatedAt: string;
  dimensions: Record<ImpactDimension, { items: number; direct: number }>;
  items: ImpactItem[];
  summary: string;
  coverage: {
    filesAnalysed: number;
    filesChanged: number;
    languages: string[];
    unresolved: number;
    /** Always present: the report never claims complete impact analysis. */
    note: string;
  };
  breaking: { api: number; database: number; event: number };
}

export interface Convention {
  id: string;
  statement: string;
  /** Number of files that follow it — evidence, not a rule invented by an LLM. */
  supportingFiles: number;
  totalFiles: number;
  examples: string[];
}

export interface ProviderStatus {
  configured: boolean;
  providerId: string;
  model?: string;
  /** `not-configured`, `ok`, `error`, `disabled` */
  state: 'not-configured' | 'ok' | 'error' | 'disabled';
  message?: string;
  capabilities?: ProviderCapabilities;
}

export interface ProviderCapabilities {
  chat: boolean;
  jsonMode: boolean;
  streaming: boolean;
  maxContextTokens?: number;
}

export interface ReportSummary {
  changedFiles: number;
  changedSymbols: number;
  affectedComponents: number;
  findingsBySeverity: Record<Severity, number>;
  findingsByCategory: Partial<Record<FindingCategory, number>>;
  documentationFindings: number;
  testsExecuted: boolean;
  aiUsed: boolean;
  /** Explicit, non-negotiable completeness signal for the UI. */
  completeness: 'complete' | 'partial' | 'failed';
  completenessNote?: string;
}

export interface AgentEvent {
  id: string;
  type:
    | 'task_intent'
    | 'plan'
    | 'decision'
    | 'alternative'
    | 'constraint'
    | 'activity'
    | 'verification'
    | 'unresolved_issue';
  title: string;
  detail: string;
  createdAt: string;
  actor?: string;
  /** Files the record refers to. */
  files?: string[];
  status?: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface AgentContext {
  events: AgentEvent[];
  intents: AgentEvent[];
  decisions: AgentEvent[];
  alternatives: AgentEvent[];
  constraints: AgentEvent[];
  activities: AgentEvent[];
  verifications: AgentEvent[];
  unresolved: AgentEvent[];
  /** Deterministic comparison of stated intent with the actual diff. */
  intentAlignment: IntentAlignment[];
}

export interface IntentAlignment {
  intent: AgentEvent;
  touchedFiles: string[];
  unplannedFiles: string[];
  plannedButUnchanged: string[];
  verdict: 'aligned' | 'partially-aligned' | 'divergent' | 'not-verifiable';
  note: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  citations?: Citation[];
  /** Set when the assistant answer could not be grounded. */
  error?: string;
}

export interface Citation {
  file: string;
  line?: number;
  endLine?: number;
  valid: boolean;
  note?: string;
}

export interface FixSolution {
  id: string;
  findingId: string;
  label: string;
  approach: string;
  description: string;
  filesAffected: string[];
  advantages: string[];
  disadvantages: string[];
  performance: string;
  sideEffects: string[];
  complexity: 'low' | 'medium' | 'high';
  testing: string[];
  compatibility: string;
  patch?: FixPatch;
  source: 'ai' | 'deterministic-guidance' | 'developer-patch';
}

export interface FixPatch {
  diff: string;
  files: string[];
  /** Dry-run result from the in-process applier. */
  validation: {
    applies: boolean;
    reason?: string;
    /** Set when the applier had to search for the context (fuzz). */
    fuzz?: number;
  };
  destructive: boolean;
}

export interface AppliedFix {
  id: string;
  reviewId: string;
  findingId: string;
  solutionId: string;
  appliedAt: string;
  files: string[];
  diff: string;
  backupDir: string;
  revertedAt?: string;
  verification?: TestExecution;
}

/**
 * Canonical report schema version.
 *
 * 3 — adds the reviewer pipeline (`review`), per-finding verification,
 *     human decisions and approvals, and the effective policy snapshot.
 * 2 — adds `execution` and `verification` records, and `FIX_ALTERNATIVES` on
 *     findings. Reports written by 0.1.x (version 1) are migrated on load by
 *     `migrateReport`, so the CLI, the web report and MCP always see one shape.
 */
export const REPORT_SCHEMA_VERSION = 3;

export interface ExecutionMetadata {
  /** Producing tool, e.g. `diffwise-cli`. */
  tool: string;
  toolVersion: string;
  command: string;
  cwd: string;
  nodeVersion: string;
  platform: string;
  /** Number of files the analyser actually read from disk. */
  indexedFiles: number;
}

/** One real execution of the configured verification command. */
export interface VerificationRecord {
  id: string;
  at: string;
  /** Finding that motivated the run, when the run was scoped to one. */
  findingId?: string;
  execution: TestExecution;
  /** How the run was authorised: explicit CLI/UI approval, or CI. */
  approvedBy: 'cli' | 'web' | 'ci';
}

export interface ReviewReport {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  id: string;
  createdAt: string;
  durationMs: number;
  target: ReviewTarget;
  repository: RepositoryInfo;
  summary: ReportSummary;
  risk: RiskAssessment;
  stages: AnalysisStage[];
  changes: FileChange[];
  changeGroups: ChangeGroup[];
  symbols: ChangedSymbol[];
  architecture: ArchitectureInfo;
  documentation: {
    files: DocumentationFile[];
    findings: DocumentationFinding[];
    /** Index statistics for the documents this review considered (additive). */
    index?: {
      documents: number;
      sections: number;
      bytes: number;
      duplicates: number;
      sources: number;
      generatedAt: string;
      categories?: Partial<Record<DocumentCategory, number>>;
    };
    /** The bounded sections retrieved for this change, with attribution. */
    retrieval?: DocRetrieval;
  };
  findings: Finding[];
  /** Findings that were verified but withheld by policy, retained for audit. */
  withheldFindings?: Finding[];
  tests: TestAnalysis;
  agent: AgentContext;
  fixes: FixSolution[];
  appliedFixes: AppliedFix[];
  provider: ProviderStatus;
  /** Project knowledge distilled from docs + agent records, used by chat. */
  knowledge: KnowledgeItem[];
  settings: AnalysisSettingsSnapshot;
  /** How this report was produced. Always present in schemaVersion 2+. */
  execution: ExecutionMetadata;
  /** Real verification-command runs, in order. Empty when none ran. */
  verification: VerificationRecord[];
  /** Reviewer selection, runs and AI verification aggregate. Always present in v3+. */
  review?: ReviewPipelineInfo;
  /** Human decisions recorded against this review, append-only. */
  decisions?: ReviewDecision[];
  /** Computed approval requirement and whether humans satisfied it. */
  approvals?: ApprovalStatus;
  /** Review state machine. AI can never set APPROVED. */
  state?: ReviewState;
  /** Effective review policy with per-field provenance. */
  policy?: EffectivePolicySnapshot;
  /** Requirements imported from Jira/PR/issue sources, with timestamps. */
  requirements?: RequirementRecord[];
  /** External knowledge sources consulted for this review. */
  contextSources?: ContextSourceRecord[];
  /** Everything the model was allowed to see, for auditability. */
  ai?: {
    model: string;
    provider: string;
    requests: number;
    promptTokens: number;
    completionTokens: number;
    failures: string[];
    redactions: number;
    evidenceRejected: number;
    /** Input tokens the provider billed from its own prompt cache. */
    cachedPromptTokens?: number;
    /** Hidden reasoning tokens, when the provider reports them. */
    reasoningTokens?: number;
    /** Requests served from DiffWise's content-addressed cache. */
    cacheHits?: number;
    cacheMisses?: number;
    /** Prompt tokens that a cache hit avoided sending. */
    tokensSavedByCache?: number;
    /** Usage attributed per task (review, verify, fix, chat). */
    byTask?: Array<{
      task: string;
      provider: string;
      model: string;
      requests: number;
      promptTokens: number;
      completionTokens: number;
      cachedPromptTokens: number;
      reasoningTokens: number;
      cacheHits: number;
      cacheMisses: number;
      tokensSavedByCache: number;
      retries: number;
      failures: number;
      latencyMs: number;
      source: 'provider' | 'estimated' | 'mixed';
    }>;
    /** Cost is always an estimate from a configured list price, never an invoice. */
    estimatedCostUsd?: number;
    costBasis?: 'list-price' | 'unknown';
    costCaveat?: string;
    /** Whether token counts came from the provider or from the estimator. */
    usageSource?: 'provider' | 'estimated' | 'mixed';
  };
}

export interface KnowledgeItem {
  id: string;
  title: string;
  kind: 'doc' | 'decision' | 'convention' | 'intent';
  path?: string;
  text: string;
}

/**
 * A requirement imported from an external system or a document.
 *
 * `trusted` is always false: imported content is data, never instructions.
 */
export interface RequirementRecord {
  id: string;
  source: 'jira' | 'github-issue' | 'gitlab-issue' | 'pr-description' | 'document' | 'confluence' | 'agent-intent' | 'mcp';
  title: string;
  body: string;
  url?: string;
  status?: string;
  fetchedAt: string;
  /** Whether this change appears to satisfy the requirement, and on what evidence. */
  coverage?: {
    verdict: 'covered' | 'partial' | 'missing' | 'unknown';
    evidence: Evidence[];
    note: string;
  };
  trusted: false;
}

/** Provenance for every context source the pipeline consulted. */
export interface ContextSourceRecord {
  id: string;
  kind: 'git' | 'document' | 'requirement' | 'ci' | 'agent-record' | 'graph' | 'test' | 'mcp';
  label: string;
  origin: string;
  fetchedAt: string;
  items: number;
  status: 'fresh' | 'stale' | 'unavailable' | 'skipped';
  detail?: string;
}

export interface AnalysisSettingsSnapshot {
  maxFiles: number;
  maxFileBytes: number;
  ignoreGlobs: string[];
  aiEnabled: boolean;
  sendRepositoryContent: boolean;
  providerId: string;
  model?: string;
  verificationCommand?: string;
}

export interface AnalysisSettings {
  maxFiles: number;
  maxFileBytes: number;
  maxEvidenceSnippets: number;
  ignoreGlobs: string[];
  aiEnabled: boolean;
  sendRepositoryContent: boolean;
  providerId: string;
  model?: string;
  verificationCommand?: string;
}

export const DEFAULT_ANALYSIS_SETTINGS: AnalysisSettings = {
  maxFiles: 200,
  maxFileBytes: 400000,
  maxEvidenceSnippets: 40,
  ignoreGlobs: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/*.min.js', '**/package-lock.json', '**/.diffwise/**'],
  aiEnabled: true,
  sendRepositoryContent: false,
  providerId: 'openai-compatible',
};
