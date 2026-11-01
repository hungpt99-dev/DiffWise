/**
 * Review policy model and precedence resolution.
 *
 * Precedence is org → repository → directory → file. The effective policy is
 * always accompanied by per-field provenance, because a review that enforces a
 * rule must be able to say which layer asked for it.
 */
import type { ReviewPipelineInfo } from '../review/types';
import type { ReviewerId } from '../review/types';
import type { Severity } from '../types';

export const POLICY_SCHEMA_VERSION = 1;

export type PolicyLayerKind = 'organization' | 'repository' | 'directory' | 'file';

export interface SuppressionRule {
  /** Rule id, or `*` for a whole pack. */
  ruleId: string;
  /** Glob of files the suppression applies to. */
  files?: string[];
  reason: string;
  /** ISO date. An expired suppression is ignored and reported. */
  expiresAt: string;
  /** Who approved the suppression. */
  approvedBy: string;
}

export interface ForbiddenPattern {
  id: string;
  /** Regular expression source; validated when the policy loads. */
  pattern: string;
  files?: string[];
  message: string;
  severity: Severity;
}

export type VerificationLevel = 'static' | 'typecheck' | 'lint' | 'build' | 'unit' | 'integration' | 'contract' | 'e2e' | 'security' | 'custom';

export interface VerificationCommandSpec {
  /** Stable id used by `diffwise verify --command <id>`. */
  id: string;
  label: string;
  level: VerificationLevel;
  /** Shell command. From policy, never from a model. */
  command: string;
  timeoutMs: number;
  /** Run this level automatically after a fix when the caller approved it. */
  runAfterFix: boolean;
  /** Command touches the network or a real database; it cannot be sandboxed. */
  requiresNetwork: boolean;
  /** Environment variables that must be present, by name only. */
  requiresEnv?: string[];
}

export interface ApprovalPolicy {
  /** Minimum distinct human approvals required per risk level. */
  requiredApprovals: Record<'low' | 'moderate' | 'high' | 'severe', number>;
  /** Roles that must be represented per risk level. */
  requiredRoles: Partial<Record<'low' | 'moderate' | 'high' | 'severe', string[]>>;
  /** Paths that force an owner review regardless of score. */
  ownerPaths: Array<{ glob: string; role: string; reason: string }>;
}

export interface ReviewPolicy {
  schemaVersion: number;

  rulePacks: {
    /** Packs that must be installed; a missing required pack is a policy error. */
    require: string[];
    /** Packs disabled by this layer. */
    disable: string[];
  };

  rules: {
    enable: Record<string, boolean>;
    severityOverride: Record<string, Severity>;
    suppress: SuppressionRule[];
    /** Minimum severity a rule must produce to be reported. */
    minSeverity: Severity;
  };

  reviewers: {
    enabled: ReviewerId[];
    disabled: ReviewerId[];
    maxReviewers: number;
    fullSweep: boolean;
    /** Reviewer skills (domain knowledge) active for this layer. */
    skills: string[];
  };

  verification: {
    minimumStatus: 'CONFIRMED' | 'LIKELY' | 'UNVERIFIED';
    aiVerification: boolean;
    independentVerifiers: number;
    commands: VerificationCommandSpec[];
    /** Commands never run without an explicit approval flag. */
    requireApproval: boolean;
    sandbox: 'none' | 'docker' | 'nsjail' | 'custom';
    defaultTimeoutMs: number;
  };

  risk: {
    /** Additive weights keyed by factor id; a layer may re-weight, not re-invent. */
    weights: Record<string, number>;
    thresholds: { moderate: number; high: number; severe: number };
  };

  approvals: ApprovalPolicy;

  security: {
    forbiddenPatterns: ForbiddenPattern[];
    /** Any finding at or above this severity blocks the quality gate. */
    blockingSeverity: Severity;
  };

  qualityGate: { failOn: Severity | 'none' };

  documentation: {
    requireUpdatedDocs: boolean;
    requiredPaths: string[];
  };

  tests: {
    requireCoverageFor: string[];
    /** Verification command ids that must pass before APPROVED. */
    requiredCommands: string[];
  };

  exclude: { globs: string[] };

  integrations: {
    /** Provider names enabled for this layer: github, gitlab, jira, confluence, ci. */
    enabled: string[];
  };
}

export const DEFAULT_POLICY: ReviewPolicy = {
  schemaVersion: POLICY_SCHEMA_VERSION,
  rulePacks: { require: [], disable: [] },
  rules: { enable: {}, severityOverride: {}, suppress: [], minSeverity: 'info' },
  reviewers: { enabled: [], disabled: [], maxReviewers: 3, fullSweep: false, skills: [] },
  verification: {
    minimumStatus: 'UNVERIFIED',
    aiVerification: true,
    independentVerifiers: 2,
    commands: [],
    requireApproval: true,
    sandbox: 'none',
    defaultTimeoutMs: 300_000,
  },
  risk: { weights: {}, thresholds: { moderate: 30, high: 55, severe: 80 } },
  approvals: {
    requiredApprovals: { low: 0, moderate: 1, high: 2, severe: 2 },
    requiredRoles: { high: [], severe: ['security', 'owner'] },
    ownerPaths: [],
  },
  security: { forbiddenPatterns: [], blockingSeverity: 'high' },
  qualityGate: { failOn: 'high' },
  documentation: { requireUpdatedDocs: false, requiredPaths: [] },
  tests: { requireCoverageFor: [], requiredCommands: [] },
  exclude: { globs: [] },
  integrations: { enabled: [] },
};

export interface PolicyLayerInput {
  kind: PolicyLayerKind;
  /** Human-readable source, e.g. `.diffwise/policy.json`. */
  source: string;
  /** What the layer applies to: `*`, `src/**`, `src/payments/**`. */
  appliesTo: string;
  /** Raw parsed object; validated by the resolver. */
  value: unknown;
}

export interface PolicyLayerState {
  kind: PolicyLayerKind;
  source: string;
  appliesTo: string;
  loaded: boolean;
  /** Which paths this layer actually contributed. */
  contributed: string[];
  error?: string;
}

export interface EffectivePolicy {
  policy: ReviewPolicy;
  /** Dotted path → source that supplied it. */
  provenance: Record<string, string>;
  layers: PolicyLayerState[];
  warnings: string[];
}

export interface EffectivePolicySnapshot {
  schemaVersion: number;
  policy: ReviewPolicy;
  provenance: Record<string, string>;
  layers: Array<{ kind: PolicyLayerKind; source: string; appliesTo: string; loaded: boolean; error?: string }>;
  warnings: string[];
}

export type ReportExtras = {
  review?: ReviewPipelineInfo;
};
