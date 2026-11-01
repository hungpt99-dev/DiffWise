/**
 * Verification engine — the verdict policy.
 *
 * Two phases, because independent verifiers are asynchronous:
 *
 *   prepareVerification()   deterministic: normalize, group, run checks
 *   finalizeVerification()  policy: combine checks + verifier opinions
 *
 * The promotion table is deliberately conservative and explicit. The invariant
 * that matters most:
 *
 *   A finding is CONFIRMED only when a non-model evidence class supports it
 *   (human confirmation, a real test/runtime result, or a structural fact that
 *   demonstrates the defect) AND no evidence check contradicts it.
 *
 * Any number of agreeing models lands at LIKELY at best. Agreement is recorded
 * in `verifiers` and in the report, but it is corroboration, not proof.
 */
import type { Confidence, Evidence, Severity } from '../types';
import { SEVERITY_ORDER } from '../types';
import { locateQuote } from '../util/text';
import { groupCandidates, normalizeCandidate, type FindingGroup, type NormalizedFinding } from './normalize';
import { runDeterministicChecks } from './checks';
import {
  DEFAULT_VERIFICATION_POLICY,
  type EvidenceClass,
  type FindingVerification,
  type VerificationCandidate,
  type VerificationCheck,
  type VerificationContext,
  type VerificationPolicy,
  type VerificationStatus,
  type VerifierOpinion,
} from './types';

export interface PreparedVerification {
  group: FindingGroup;
  checks: VerificationCheck[];
}

export interface VerificationOutcome {
  group: FindingGroup;
  verification: FindingVerification;
  /** The canonical finding, with the verification attached by the caller. */
  findingId: string;
  published: boolean;
  /** Why it was not published, when it was not. */
  hiddenReason?: string;
}

/** Map producer evidence onto the five evidence classes. */
export function classifyEvidence(evidence: Evidence): EvidenceClass {
  switch (evidence.source) {
    case 'test-run': return 'test';
    case 'ai': return 'model';
    case 'agent-record': return 'model';
    case 'human': return 'human';
    default: return 'static';
  }
}

/**
 * Validate verifier opinions. An opinion whose cited evidence does not exist is
 * discarded: a verifier that hallucinates a quote has not verified anything.
 */
export function screenOpinions(opinions: VerifierOpinion[], files: Map<string, string>): VerifierOpinion[] {
  return opinions.map((opinion) => {
    if (opinion.kind === 'deterministic') return opinion;
    const checked = opinion.evidence.filter((e) => {
      if (!e.file) return false;
      const content = files.get(e.file);
      if (content === undefined) return false;
      if (!e.snippet) return false;
      return locateQuote(content, e.snippet) !== null;
    });
    if (opinion.evidence.length > 0 && checked.length === 0) {
      return { ...opinion, discarded: 'none of the cited evidence exists in the repository', evidence: [] };
    }
    return { ...opinion, evidence: checked };
  });
}

/** Phase 1: deterministic preparation. */
export function prepareVerification(
  candidates: VerificationCandidate[],
  ctx: VerificationContext,
  options: { lineSlack?: number; similarityThreshold?: number } = {},
): PreparedVerification[] {
  const normalized: NormalizedFinding[] = candidates.map(normalizeCandidate);
  const groups = groupCandidates(normalized, options);
  return groups.map((group) => ({ group, checks: runDeterministicChecks(group, ctx) }));
}

/** Checks that establish a precondition rather than evidence of the defect. */
const NON_EVIDENTIAL = new Set(['file.exists', 'range.exists', 'range.in-change', 'tests.covering-file', 'test.execution', 'human.confirmation']);

function countEvidenceClasses(group: FindingGroup, checks: VerificationCheck[], opinions: VerifierOpinion[]): Record<EvidenceClass, number> {
  const counts: Record<EvidenceClass, number> = { static: 0, model: 0, test: 0, runtime: 0, human: 0 };
  for (const e of group.evidence) counts[classifyEvidence(e)] += 1;
  for (const check of checks) {
    if (check.outcome !== 'supports') continue;
    if (NON_EVIDENTIAL.has(check.id)) continue;
    if (check.kind === 'evidence') counts.static += check.evidence?.length ?? 1;
    if (check.kind === 'structural') counts.static += 1;
  }
  for (const opinion of opinions) {
    if (opinion.discarded) continue;
    if (opinion.kind === 'ai') counts.model += 1;
    if (opinion.kind === 'human') counts.human += opinion.evidence.length || 1;
    if (opinion.kind === 'deterministic') counts.static += 1;
  }
  for (const check of checks) {
    if (check.id === 'test.execution' && check.outcome === 'supports') counts.test += 1;
    if (check.id === 'human.confirmation' && check.outcome === 'supports') counts.human += 1;
  }
  return counts;
}

interface VerdictDecision {
  status: VerificationStatus;
  method: string;
  notes: string[];
}

function decideVerdict(
  group: FindingGroup,
  checks: VerificationCheck[],
  opinions: VerifierOpinion[],
  policy: VerificationPolicy,
): VerdictDecision {
  const notes: string[] = [];
  const evidenceChecks = checks.filter((c) => c.kind === 'evidence');
  const structural = checks.filter((c) => c.kind === 'structural');
  const heuristics = checks.filter((c) => c.kind === 'heuristic');

  const contradicts = checks.filter((c) => c.outcome === 'contradicts');
  // Preconditions (file exists, line exists, line is in the diff) are not
  // evidence of the defect and cannot support a verdict on their own.
  const supports = checks.filter((c) => c.outcome === 'supports' && !NON_EVIDENTIAL.has(c.id));

  const hardContradiction = contradicts.find((c) =>
    c.id === 'file.exists' || c.id === 'range.exists' || c.id === 'evidence.quotes' || c.id === 'human.confirmation');
  const aiOpinions = opinions.filter((o) => o.kind === 'ai' && !o.discarded);
  const confirmedOpinions = aiOpinions.filter((o) => o.verdict === 'confirmed' || o.verdict === 'likely');
  const rejectedOpinions = aiOpinions.filter((o) => o.verdict === 'rejected');

  if (group.corroborated) {
    notes.push('A deterministic rule and a reviewer independently described this defect; that is corroboration, not proof.');
  }
  for (const opinion of opinions.filter((o) => o.discarded)) {
    notes.push(`Verifier ${opinion.verifierId} opinion discarded: ${opinion.discarded}.`);
  }

  // 1. Hard contradiction: the finding's own evidence does not exist, the file
  //    is absent, or a human explicitly rejected it.
  if (hardContradiction) {
    return {
      status: 'REJECTED',
      method: `Rejected by ${hardContradiction.id}: ${hardContradiction.detail}`,
      notes: [...notes, ...contradicts.map((c) => `${c.id}: ${c.detail}`)],
    };
  }

  const humanSupport = evidenceChecks.find((c) => c.id === 'human.confirmation' && c.outcome === 'supports');
  const testSupport = evidenceChecks.find((c) => c.id === 'test.execution' && c.outcome === 'supports');
  const quotesSupport = evidenceChecks.find((c) => c.id === 'evidence.quotes' && c.outcome === 'supports');
  const structuralSupport = structural.find((c) => c.outcome === 'supports');

  // 2. Human confirmation is the strongest class.
  if (humanSupport) {
    return { status: 'CONFIRMED', method: `Confirmed by a human reviewer: ${humanSupport.detail}`, notes };
  }

  // 3. A real execution that reproduces the defect.
  if (testSupport) {
    return { status: 'CONFIRMED', method: `Confirmed by a recorded test execution: ${testSupport.detail}`, notes };
  }

  // 4. Static demonstration: quoted evidence resolves AND a structural fact
  //    demonstrates the defect. Conditional hazards (`kind: risk`) stay LIKELY
  //    because they depend on runtime state that static analysis cannot settle.
  if (quotesSupport && structuralSupport) {
    if (group.canonical.finding.kind === 'problem') {
      return {
        status: 'CONFIRMED',
        method: `Static demonstration: ${quotesSupport.detail} and ${structuralSupport.detail}`,
        notes,
      };
    }
    return {
      status: 'LIKELY',
      method: `Conditional hazard supported by static evidence (${structuralSupport.detail}); its trigger depends on runtime state.`,
      notes,
    };
  }

  // 5. Model verifiers rejected it while nothing deterministic supports it.
  if (rejectedOpinions.length > 0 && confirmedOpinions.length === 0 && supports.length === 0) {
    const first = rejectedOpinions[0] as VerifierOpinion;
    return {
      status: 'REJECTED',
      method: `Rejected by independent verification: ${first.verifierId} — ${first.reasoning.slice(0, 240)}`,
      notes,
    };
  }

  // 6. Verifiers disagree with each other, or with a supporting check.
  const verifierDisagreement = rejectedOpinions.length > 0 && confirmedOpinions.length > 0;
  const checkDisagreement = supports.length > 0 && contradicts.length > 0;
  if (verifierDisagreement || checkDisagreement) {
    const parts: string[] = [];
    if (verifierDisagreement) parts.push(`${confirmedOpinions.length} verifier(s) supported and ${rejectedOpinions.length} rejected the finding`);
    if (checkDisagreement) parts.push(`${supports.length} check(s) supported and ${contradicts.length} contradicted it`);
    return {
      status: 'DISPUTED',
      method: `Verifiers disagree: ${parts.join('; ')}. The disagreement is preserved rather than averaged away.`,
      notes: [
        ...notes,
        ...opinions.filter((o) => !o.discarded).map((o) => `${o.verifierId} (${o.kind}) → ${o.verdict}: ${o.reasoning.slice(0, 200)}`),
      ],
    };
  }

  // 7. Quoted evidence resolves but no structural demonstration.
  if (quotesSupport) {
    const heuristicSupport = heuristics.find((c) => c.outcome === 'supports');
    return {
      status: 'LIKELY',
      method: heuristicSupport
        ? `Evidence resolves and a heuristic supports it (${heuristicSupport.id}): ${heuristicSupport.detail}`
        : `Evidence resolves (${quotesSupport.detail}) but no structural demonstration was found.`,
      notes,
    };
  }

  // 8. Only model interpretation, or only a heuristic.
  if (confirmedOpinions.length > 0) {
    return {
      status: 'LIKELY',
      method: `${confirmedOpinions.length} independent verifier(s) supported this finding, but no deterministic or human evidence class does. Model agreement alone cannot confirm a finding.`,
      notes,
    };
  }
  if (supports.length > 0) {
    return {
      status: 'LIKELY',
      method: `Supported only by ${supports.map((c) => `${c.id} (${c.kind})`).join(', ')}; not enough to confirm.`,
      notes,
    };
  }

  return {
    status: 'UNVERIFIED',
    method: 'No verification was performed for this finding: no evidence check resolved and no verifier ran.',
    notes,
  };
}

function recalculateConfidence(status: VerificationStatus, classes: Record<EvidenceClass, number>): Confidence {
  switch (status) {
    case 'CONFIRMED':
      return 'verified';
    case 'LIKELY':
      return classes.test + classes.human + classes.static >= 2 ? 'high' : 'medium';
    case 'DISPUTED':
    case 'UNVERIFIED':
    case 'REJECTED':
    default:
      return 'low';
  }
}

const SEVERITY_CAP: Partial<Record<VerificationStatus, Severity>> = {
  LIKELY: 'high',
  UNVERIFIED: 'medium',
  DISPUTED: 'medium',
  REJECTED: 'low',
};

function adjustSeverity(original: Severity, status: VerificationStatus, policy: VerificationPolicy): FindingVerification['severity'] {
  if (!policy.adjustSeverity) return { original, effective: original, reason: 'Severity adjustment disabled by policy.' };
  const cap = SEVERITY_CAP[status];
  if (!cap) return { original, effective: original, reason: 'Confirmed findings keep their assessed severity.' };
  // SEVERITY_ORDER: lower rank = more severe. A cap is the most severe level the
  // verification status can support.
  if (SEVERITY_ORDER[original] === SEVERITY_ORDER[cap]) {
    return { original, effective: original, reason: `Severity is at the ${cap} cap for ${status}.` };
  }
  if (SEVERITY_ORDER[original] > SEVERITY_ORDER[cap]) {
    return { original, effective: original, reason: `Severity retained: ${original} is already less severe than the ${cap} cap for ${status}.` };
  }
  return {
    original,
    effective: cap,
    reason: `Capped at ${cap}: a ${original} claim cannot be raised above ${cap} while its status is ${status} (model interpretation is not proof).`,
  };
}

/** Phase 2: policy and consensus. */
export function finalizeVerification(
  prepared: PreparedVerification[],
  ctx: VerificationContext,
  options: { policy?: Partial<VerificationPolicy>; opinionsByGroup?: Map<string, VerifierOpinion[]> } = {},
): VerificationOutcome[] {
  const policy: VerificationPolicy = { ...DEFAULT_VERIFICATION_POLICY, ...options.policy };
  const at = (ctx.now ?? new Date()).toISOString();

  return prepared.map(({ group, checks }) => {
    const rawOpinions = options.opinionsByGroup?.get(group.key) ?? [];
    const opinions = screenOpinions(rawOpinions, ctx.files);
    const decision = decideVerdict(group, checks, opinions, policy);
    const evidenceClasses = countEvidenceClasses(group, checks, opinions);
    const confidence = recalculateConfidence(decision.status, evidenceClasses);
    const severity = adjustSeverity(group.severity, decision.status, policy);

    const reproducible = decision.status !== 'CONFIRMED'
      && decision.status !== 'REJECTED'
      && !checks.some((c) => c.id === 'test.execution' && c.outcome !== 'inconclusive');

    const verification: FindingVerification = {
      status: decision.status,
      method: decision.method,
      policy: 'default/v1',
      checks,
      verifiers: opinions,
      evidenceClasses,
      confidence,
      severity,
      history: [{ at, status: decision.status, trigger: 'review', note: decision.method }],
      notes: decision.notes,
      reproducible,
    };

    const published = passesMinimum(decision.status, policy.minimumStatus) || !policy.hideRejected;
    return {
      group,
      verification,
      findingId: group.canonical.finding.id,
      published,
      ...(published ? {} : { hiddenReason: `status ${decision.status} is below the published minimum ${policy.minimumStatus}` }),
    };
  });
}

const STATUS_RANK: Record<VerificationStatus, number> = {
  CONFIRMED: 0,
  LIKELY: 1,
  DISPUTED: 2,
  UNVERIFIED: 3,
  REJECTED: 4,
};

export function passesMinimum(status: VerificationStatus, minimum: VerificationPolicy['minimumStatus']): boolean {
  return STATUS_RANK[status] <= STATUS_RANK[minimum];
}

/** Aggregate counts for the report summary. */
export function verificationSummary(outcomes: VerificationOutcome[]): {
  byStatus: Record<VerificationStatus, number>;
  confirmed: number;
  likely: number;
  unverified: number;
  rejected: number;
  disputed: number;
  corroborated: number;
  reproducible: number;
} {
  const byStatus: Record<VerificationStatus, number> = { CONFIRMED: 0, LIKELY: 0, UNVERIFIED: 0, REJECTED: 0, DISPUTED: 0 };
  for (const outcome of outcomes) byStatus[outcome.verification.status] += 1;
  return {
    byStatus,
    confirmed: byStatus.CONFIRMED,
    likely: byStatus.LIKELY,
    unverified: byStatus.UNVERIFIED,
    rejected: byStatus.REJECTED,
    disputed: byStatus.DISPUTED,
    corroborated: outcomes.filter((o) => o.group.corroborated).length,
    reproducible: outcomes.filter((o) => o.verification.reproducible).length,
  };
}
