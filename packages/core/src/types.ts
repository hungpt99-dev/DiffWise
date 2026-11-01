/**
 * DiffWise core domain model.
 *
 * Everything in this file is transport-safe: it is serialised into the report
 * that the VS Code webview and the MCP server consume, so it must stay free of
 * Node-only types and of provider-specific shapes.
 */

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
  /** How this evidence was obtained. */
  source: 'deterministic' | 'ai' | 'git' | 'test-run' | 'agent-record' | 'document';
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
 * 2 — adds `execution` and `verification` records, and `FIX_ALTERNATIVES` on
 *     findings. Reports written by 0.1.x (version 1) are migrated on load by
 *     `migrateReport`, so the CLI, the web report and MCP always see one shape.
 */
export const REPORT_SCHEMA_VERSION = 2;

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
  };
  findings: Finding[];
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
  };
}

export interface KnowledgeItem {
  id: string;
  title: string;
  kind: 'doc' | 'decision' | 'convention' | 'intent';
  path?: string;
  text: string;
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
