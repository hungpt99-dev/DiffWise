/**
 * Platform hooks.
 *
 * The deterministic pipeline owns sequencing, stage status and the report shape.
 * The AI package supplies reviewer and verifier implementations through these
 * hooks, so `core` never imports a provider and the pipeline stays runnable with
 * no AI at all.
 *
 * A hook that throws degrades its stage; it never silently disappears.
 */
import type { Finding } from '../types';
import type { ReviewPolicy } from '../policy/types';
import type { ReviewPipelineInfo, ReviewerRun, ReviewPlan, TokenUsage } from './types';
import type { VerificationStatus } from '../verification/types';

export interface ReviewerHookInput {
  /** The deterministic report built so far. Reviewers may read all of it. */
  report: import('../types').ReviewReport;
  /** Repository files (changed files already refreshed to their new content). */
  repoFiles: Map<string, string>;
  /** New content of changed files only. */
  changedContents: Map<string, string>;
  /** Previous content of changed files (null for added files). */
  oldContents: Map<string, string | null>;
  /** Added line numbers per file, in new-file coordinates. */
  addedLines: Map<string, Set<number>>;
  policy?: ReviewPolicy;
  signal?: AbortSignal;
  log(message: string): void;
}

export interface ReviewerHookResult {
  findings: Finding[];
  runs: ReviewerRun[];
  plan?: ReviewPlan;
  tokens: TokenUsage;
  durationMs: number;
  cancelled: boolean;
  proposed?: number;
  evidenceRejected?: number;
  skippedReason?: string;
}

export interface VerifyHookInput extends ReviewerHookInput {
  /** Findings after correlation/deduplication. */
  findings: Finding[];
}

export interface VerifyHookResult {
  /** Findings with `verification` attached; may be filtered by policy. */
  findings: Finding[];
  /** Findings withheld from the published list, kept for audit rather than deleted. */
  withheld?: Finding[];
  summary: ReviewPipelineInfo['verification'];
  /** Per-finding verdicts, used for the stage detail line. */
  verdicts: Array<{ findingId: string; status: VerificationStatus }>;
  durationMs: number;
}

export interface ReviewPlatformHooks {
  runReviewers?(input: ReviewerHookInput): Promise<ReviewerHookResult>;
  verify?(input: VerifyHookInput): Promise<VerifyHookResult>;
}

export function emptyVerificationSummary(performed = false): ReviewPipelineInfo['verification'] {
  return {
    performed,
    policy: 'default/v1',
    confirmed: 0,
    likely: 0,
    unverified: 0,
    rejected: 0,
    disputed: 0,
    corroborated: 0,
    reproducible: 0,
    opinions: 0,
    groups: 0,
    deferred: 0,
  };
}
