/**
 * Review orchestration contracts.
 *
 * These types are the stable surface between the deterministic core, the AI
 * agents and every interface. `core` owns them so that the AI package can be
 * replaced, disabled or absent without any interface changing shape.
 */

import type { FindingCategory, Language, Severity } from '../types';

/** The eight specialised reviewers the platform defines. */
export type ReviewerId =
  | 'correctness'
  | 'security'
  | 'concurrency'
  | 'database'
  | 'architecture'
  | 'performance'
  | 'tests'
  | 'business-logic';

export const REVIEWER_IDS: readonly ReviewerId[] = [
  'correctness',
  'security',
  'concurrency',
  'database',
  'architecture',
  'performance',
  'tests',
  'business-logic',
];

/**
 * The context a reviewer is allowed to see. Scoping is deliberate: a reviewer
 * that receives the whole repository produces vague findings.
 */
export interface ReviewerScope {
  /** Reviewer never sees more than this many characters of context. */
  maxContextChars: number;
  /** Cap on changed files included in the prompt. */
  maxFiles: number;
  /** Include repository files outside the diff (callers, related modules). */
  includeRelated: boolean;
  /** Include the recorded agent intent/decisions. */
  includeIntent: boolean;
  /** Include deterministic findings so the reviewer can corroborate or refute. */
  includeDeterministic: boolean;
}

export interface ReviewerBudget {
  maxTokens: number;
  maxFindings: number;
  timeoutMs: number;
  scope: ReviewerScope;
}

export interface ReviewerCapabilities {
  /** Categories this reviewer is expected to produce. Used for coverage checks. */
  produces: FindingCategory[];
  languages: Language[] | 'any';
  frameworks?: string[];
  /** The reviewer needs the repository index (callers, tests), not just the diff. */
  needsRepositoryIndex: boolean;
  /** Works with deterministic evidence only (no model call). */
  deterministicOnly?: boolean;
}

export interface ReviewerSpec {
  id: ReviewerId;
  name: string;
  version: string;
  description: string;
  /** The questions this reviewer asks. Shown by `diffwise reviewers explain`. */
  focus: string[];
  /** Failure modes this reviewer must not produce (keeps prompts honest). */
  avoid: string[];
  capabilities: ReviewerCapabilities;
  budget: ReviewerBudget;
  /** A finding without evidence is discarded; this is not configurable. */
  requiresEvidence: true;
  /** Default enabled state; policy may override. */
  defaultEnabled: boolean;
  /**
   * A pinned reviewer is always selected when it is enabled. Only correctness
   * is pinned: a review that skips it is not a code review.
   */
  pinned?: boolean;
}

export type ReviewerStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';

export interface TokenUsage {
  prompt: number;
  completion: number;
}

export interface ReviewerRun {
  reviewerId: ReviewerId;
  name: string;
  status: ReviewerStatus;
  /** Why this reviewer was invoked. One line per signal. */
  selectedBecause: string[];
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  /** Findings the reviewer returned before evidence validation. */
  proposed: number;
  /** Findings that survived evidence validation. */
  accepted: number;
  /** Proposals discarded because their evidence did not exist. */
  evidenceRejected: number;
  tokens: TokenUsage;
  model?: string;
  provider?: string;
  error?: string;
  skippedReason?: string;
}

export interface ReviewerSelectionDecision {
  reviewerId: ReviewerId;
  selected: boolean;
  /** Higher is more relevant; the cap keeps the most relevant reviewers. */
  score: number;
  reasons: string[];
}

export interface ReviewPlan {
  reviewers: ReviewerId[];
  decisions: ReviewerSelectionDecision[];
  /** Every reviewer was considered but not all were run. */
  considered: ReviewerId[];
  maxReviewers: number;
  /** Model routing: which provider/model the reviewers use. */
  route: { provider: string; model: string };
  /** True when the cap dropped at least one applicable reviewer. */
  truncated: boolean;
}

/** A reviewer implementation supplied by the AI package (or a test double). */
export interface ReviewerAgentInput {
  spec: ReviewerSpec;
  plan: ReviewPlan;
  /** Bounded, already-scoped prompt context assembled by the caller. */
  scope: ReviewerScopeInput;
  signal?: AbortSignal;
}

export interface ReviewerScopeInput {
  /** Unified diff text (bounded). */
  diff: string;
  /** Changed file contents keyed by repo-relative path (bounded). */
  files: Array<{ path: string; language: Language; content: string }>;
  /** Related repository files (callers, depended-on modules). */
  related: Array<{ path: string; reason: string; content: string }>;
  /** Deterministic findings the reviewer may corroborate or refute. */
  deterministicFindings: Array<{ id: string; title: string; category: FindingCategory; severity: Severity; file: string; range: { start: number; end: number } }>;
  /** Recorded agent intent, verbatim but fenced as untrusted. */
  intent?: string;
  /** Requirements imported from integrations (Jira/PR/issue). */
  requirements?: Array<{ id: string; title: string; body: string; source: string }>;
  /** Domain knowledge from an installed reviewer skill. */
  skill?: { id: string; version: string; instructions: string };
}

export interface ReviewerAgentResult {
  /** Raw proposals. The orchestrator validates evidence before accepting them. */
  proposals: ReviewerProposal[];
  tokens: TokenUsage;
  model?: string;
  provider?: string;
  warning?: string;
}

/**
 * A proposal as the model returned it. It is not a `Finding` until evidence
 * validation and verification have run.
 */
export interface ReviewerProposal {
  title: string;
  description: string;
  severity: Severity;
  category: FindingCategory;
  kind: 'problem' | 'risk' | 'recommendation' | 'question';
  confidence: 'verified' | 'high' | 'medium' | 'low';
  file: string;
  startLine: number;
  endLine?: number;
  /** Quotes the model claims exist in the file. Validated, never trusted. */
  evidence: Array<{ file?: string; quote: string; note?: string }>;
  whyItMatters?: string;
  /** The model's own short account of what in the code makes this a defect. */
  reasoning?: string;
  consequences?: string[];
  reproduction?: string;
  recommendation: string;
  tags?: string[];
  requirements?: string[];
}

export interface ReviewerAgent {
  readonly spec: ReviewerSpec;
  run(input: ReviewerAgentInput): Promise<ReviewerAgentResult>;
}

export interface OrchestratorOptions {
  agents: ReviewerAgent[];
  plan: ReviewPlan;
  /** Bounded concurrency. Never equals the reviewer count by accident. */
  concurrency?: number;
  /**
   * Overrides each reviewer's timeout. Reasoning models can spend more than the
   * two-minute default thinking before they emit anything.
   */
  timeoutMs?: number;
  signal?: AbortSignal;
  onUpdate?(runs: ReviewerRun[]): void;
  /** Builds the scoped input for one reviewer. */
  scope(spec: ReviewerSpec): ReviewerScopeInput;
  /** Validates one proposal against the repository. */
  accept(spec: ReviewerSpec, proposal: ReviewerProposal): { ok: boolean; reason?: string };
}

export interface OrchestratorResult {
  runs: ReviewerRun[];
  proposals: Array<{ reviewerId: ReviewerId; proposal: ReviewerProposal }>;
  rejected: Array<{ reviewerId: ReviewerId; title: string; reason: string }>;
  tokens: TokenUsage;
  cancelled: boolean;
  /** Wall-clock duration of the reviewer stage. */
  durationMs: number;
}

/** Review-level state machine. AI advice never sets these; humans do. */
export type ReviewState = 'PENDING' | 'IN_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED' | 'BLOCKED' | 'SUPERSEDED';

export interface ReviewDecision {
  id: string;
  reviewId: string;
  findingId?: string;
  action:
    | 'accept'
    | 'reject'
    | 'false-positive'
    | 'request-evidence'
    | 'approve-fix'
    | 'reject-fix'
    | 'approve-review'
    | 'request-changes'
    | 'block';
  actor: string;
  /** Only `human` decisions satisfy an approval requirement. */
  actorKind: 'human' | 'ai' | 'ci';
  /** Reviewer role, matched against policy `requiredRoles`. */
  role?: string;
  /** Free-text rationale. Required for reject/false-positive/block. */
  rationale: string;
  at: string;
  /** What the AI suggested at the time, kept separate from the human decision. */
  aiRecommendation?: string;
}

export interface ApprovalRequirement {
  riskLevel: 'low' | 'moderate' | 'high' | 'severe';
  /** Minimum distinct human approvals. */
  requiredApprovals: number;
  /** Roles that must be among the approvers. */
  requiredRoles: string[];
  /** Human-readable policy line quoted in the report. */
  policyLine: string;
  /** Reasons this requirement applies, with the rule that produced them. */
  basis: string[];
}

export interface ApprovalStatus {
  requirement: ApprovalRequirement;
  approvals: ReviewDecision[];
  /** Distinct actors whose decision was `approve-review`. */
  approvers: string[];
  satisfied: boolean;
  /** Never true for AI actors: AI cannot satisfy a human approval. */
  shortfall: string[];
}

/** Everything the report needs to show about the reviewer stage. */
export type AiReviewState = 'complete' | 'partial' | 'unavailable' | 'disabled' | 'failed';

export interface AiReviewStatus {
  status: AiReviewState;
  /** True when config enabled AI *and* a provider was resolved. */
  requested: boolean;
  /** True when config says a review without AI must not be presented as complete. */
  required: boolean;
  reviewers: { planned: number; completed: number; failed: number; skipped: number };
  verification: { opinions: number; groups: number; deferred: number };
  /** Model actually used per AI task, after routing. */
  models?: { review?: string; verify?: string; fix?: string; chat?: string };
  /** Why the status is not `complete`. */
  reason?: string;
}

export interface ReviewPipelineInfo {
  /** Which reviewers ran and why. */
  plan: ReviewPlan;
  reviewerRuns: ReviewerRun[];
  /** Reviewer stage wall-clock time and token totals. */
  totals: { durationMs: number; tokens: TokenUsage; proposed: number; accepted: number; evidenceRejected: number };
  /** Set when the whole AI stage was skipped, with the reason. */
  skippedReason?: string;
  /**
   * AI review state, computed once by the pipeline and read by every interface.
   *
   * This exists because "did the AI half of the review actually run?" must not be
   * reconstructed from three other fields. `complete` means the AI stage ran to
   * its end; anything else says why, and `required` says whether the caller
   * asked for that to be a failure.
   */
  ai?: AiReviewStatus;
  cancelled: boolean;
  /** Per-rule execution records, including rules that were disabled or failed. */
  ruleRuns?: Array<{
    id: string;
    name: string;
    pack: string;
    mode: string;
    status: string;
    findings: number;
    durationMs: number;
    error?: string;
    reason?: string;
  }>;
  /** Verification aggregate, filled by the verification stage. */
  verification: {
    performed: boolean;
    policy: string;
    confirmed: number;
    likely: number;
    unverified: number;
    rejected: number;
    disputed: number;
    corroborated: number;
    reproducible: number;
    durationMs?: number;
    /** Independent AI opinions obtained, when verification used a provider. */
    opinions?: number;
    /** Findings that received any verdict. */
    groups?: number;
    /** Groups that were eligible but skipped because the call budget ran out. */
    deferred?: number;
  };
}
