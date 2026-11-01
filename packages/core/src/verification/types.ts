/**
 * Finding verification contracts.
 *
 * The single most important rule in this file: **agreement between models is
 * not proof**. Every verdict records which *class* of evidence supported it, and
 * the engine refuses to promote a finding to CONFIRMED on model interpretation
 * alone — no matter how many reviewers agreed.
 */
import type { Confidence, Evidence, Severity } from '../types';

export type VerificationStatus = 'CONFIRMED' | 'LIKELY' | 'UNVERIFIED' | 'REJECTED' | 'DISPUTED';

export const VERIFICATION_STATUSES: readonly VerificationStatus[] = ['CONFIRMED', 'LIKELY', 'UNVERIFIED', 'REJECTED', 'DISPUTED'];

/**
 * The five evidence classes the platform distinguishes. A finding's strength is
 * a function of which classes support it, not of how many agents produced it.
 */
export type EvidenceClass = 'static' | 'model' | 'test' | 'runtime' | 'human';

export const EVIDENCE_CLASS_LABEL: Record<EvidenceClass, string> = {
  static: 'Static evidence',
  model: 'Model interpretation',
  test: 'Test evidence',
  runtime: 'Runtime evidence',
  human: 'Human confirmation',
};

export type CheckKind = 'evidence' | 'structural' | 'heuristic';

export type CheckOutcome = 'supports' | 'contradicts' | 'inconclusive';

export interface VerificationCheck {
  id: string;
  /** What was checked, in one sentence, in terms of the repository. */
  description: string;
  kind: CheckKind;
  outcome: CheckOutcome;
  detail: string;
  evidence?: Evidence[];
}

export type VerifierVerdict = 'confirmed' | 'likely' | 'uncertain' | 'rejected';

export interface VerifierOpinion {
  verifierId: string;
  kind: 'deterministic' | 'ai' | 'human';
  verdict: VerifierVerdict;
  confidence: Confidence;
  reasoning: string;
  /** Evidence the verifier cited. Discarded if it does not exist. */
  evidence: Evidence[];
  model?: string;
  provider?: string;
  /** Set when the opinion was discarded and why. */
  discarded?: string;
}

export interface SeverityAdjustment {
  original: Severity;
  effective: Severity;
  reason: string;
}

export interface VerificationHistoryEntry {
  at: string;
  status: VerificationStatus;
  /** What triggered the re-verification. */
  trigger: 'review' | 're-verify' | 'test-run' | 'human-decision' | 'fix-applied';
  note?: string;
}

export interface FindingVerification {
  status: VerificationStatus;
  /** One line: how the verdict was reached. Quoted in the report. */
  method: string;
  /** Invariant name of the policy that produced this verdict. */
  policy: string;
  checks: VerificationCheck[];
  verifiers: VerifierOpinion[];
  evidenceClasses: Record<EvidenceClass, number>;
  /** Recalculated from the checks, not inherited from the producer. */
  confidence: Confidence;
  severity: SeverityAdjustment;
  history: VerificationHistoryEntry[];
  /** Everything a reviewer needs to judge the verdict. */
  notes: string[];
  /** True when the verdict could change with a test run. */
  reproducible: boolean;
}

export interface VerificationPolicy {
  /**
   * Minimum status a finding must reach to be published in the report.
   * `UNVERIFIED` publishes everything, which the report clearly labels.
   */
  minimumStatus: Extract<VerificationStatus, 'CONFIRMED' | 'LIKELY' | 'UNVERIFIED'>;
  /** Run independent AI verifiers at all. */
  aiVerification: boolean;
  /** How many independent verifier agents run per finding group. */
  independentVerifiers: number;
  /** Categories where a conditional hazard can reach CONFIRMED without a demonstration. */
  demonstrableCategories: string[];
  /** Drop findings the verifier rejected instead of publishing them as REJECTED. */
  hideRejected: boolean;
  /** Recompute severity from evidence strength. */
  adjustSeverity: boolean;
}

export const DEFAULT_VERIFICATION_POLICY: VerificationPolicy = {
  minimumStatus: 'UNVERIFIED',
  aiVerification: true,
  independentVerifiers: 2,
  demonstrableCategories: ['security', 'concurrency', 'database', 'api-contract', 'tests', 'architecture', 'performance'],
  hideRejected: false,
  adjustSeverity: true,
};

/** Inputs the engine needs; all deterministic and repository-backed. */
export interface VerificationContext {
  /** New content of every file the review may reference. */
  files: Map<string, string>;
  /**
   * Old content of changed files. A finding about removed code quotes text that
   * only exists in the previous revision, so evidence is checked against both.
   */
  oldFiles?: Map<string, string | null>;
  /** Lines that the diff actually added, keyed by file (new-file coordinates). */
  addedLines: Map<string, Set<number>>;
  /** Files changed by this review. */
  changedFiles: Set<string>;
  /** Real test/runtime executions recorded for this review. */
  executions: Array<{ id: string; findingId?: string; command: string; status: string; exitCode: number | null; at: string }>;
  /** Human decisions already recorded against findings. */
  humanDecisions?: Array<{ findingId: string; action: string; actor: string; at: string; rationale: string }>;
  now?: Date;
}

export interface VerificationCandidate {
  /** Producer id: `rule:<ruleId>` or `reviewer:<reviewerId>`. */
  producer: string;
  finding: {
    id: string;
    title: string;
    description: string;
    severity: Severity;
    category: string;
    kind: string;
    confidence: Confidence;
    file: string;
    range: { start: number; end: number };
    evidence: Evidence[];
    recommendation: string;
    ruleId?: string;
    source: 'deterministic' | 'ai';
    tags?: string[];
  };
}
