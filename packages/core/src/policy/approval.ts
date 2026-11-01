/**
 * Risk-based approval policy.
 *
 * The output is a *recommendation and a gate*, never an authorisation to merge:
 * DiffWise cannot merge, and an AI actor can never satisfy a human approval
 * requirement. Branch protection and organisation policy remain authoritative.
 */
import type { Finding, ReviewReport, Severity } from '../types';
import { SEVERITY_ORDER } from '../types';
import type { ApprovalRequirement, ApprovalStatus, ReviewDecision, ReviewState } from '../review/types';
import type { ReviewPolicy } from './types';
import { matchesAnyGlob } from '../util/glob';

export interface ApprovalInput {
  risk: ReviewReport['risk'];
  policy: ReviewPolicy;
  changes: Array<{ path: string }>;
  findings: Finding[];
  decisions?: ReviewDecision[];
}

const ROLE_ORDER = ['security', 'owner', 'staff', 'maintainer'];

/** Compute what this change needs, and why. */
export function requiredApproval(input: ApprovalInput): ApprovalRequirement {
  const level = input.risk.level;
  const counts = input.policy.approvals.requiredApprovals;
  const roles = new Set<string>(input.policy.approvals.requiredRoles[level] ?? []);
  const basis: string[] = [`risk level ${level} (score ${input.risk.score}/100) requires ${counts[level]} approval(s)`];

  for (const owner of input.policy.approvals.ownerPaths) {
    if (input.changes.some((c) => matchesAnyGlob(c.path, [owner.glob]))) {
      roles.add(owner.role);
      basis.push(owner.reason);
    }
  }
  for (const factor of input.risk.factors) {
    if (factor.id === 'security-surface' && factor.points > 0) {
      roles.add('security');
      basis.push(`security-sensitive code changed (${factor.explanation})`);
    }
  }

  const sortedRoles = [...roles].sort((a, b) => {
    const ia = ROLE_ORDER.indexOf(a);
    const ib = ROLE_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const policyLine = level === 'low'
    ? `Low risk — ${counts.low === 0 ? 'repository policy allows a self-review' : `${counts.low} approval(s)`}; DiffWise makes no authorisation decision.`
    : `${level[0]?.toUpperCase()}${level.slice(1)} risk — ${counts[level]} human approval(s)${sortedRoles.length ? ` including ${sortedRoles.join(' + ')}` : ''}. Recommendation only; branch protection governs the merge.`;

  return {
    riskLevel: level,
    requiredApprovals: counts[level],
    requiredRoles: sortedRoles,
    policyLine,
    basis,
  };
}

/** Findings that block a review from being approved. */
export function blockingFindings(findings: Finding[], policy: ReviewPolicy): Finding[] {
  const threshold = SEVERITY_ORDER[policy.security.blockingSeverity];
  return findings.filter((f) => {
    if (f.kind === 'recommendation' || f.kind === 'question') return false;
    if (f.verification && (f.verification.status === 'REJECTED' || f.verification.status === 'DISPUTED')) return false;
    return SEVERITY_ORDER[f.severity] <= threshold;
  });
}

export function evaluateApproval(input: ApprovalInput): ApprovalStatus {
  const requirement = requiredApproval(input);
  const decisions = input.decisions ?? [];
  const humanDecisions = decisions.filter((d) => d.actorKind === 'human');
  const approvals = humanDecisions.filter((d) => d.action === 'approve-review');
  const approvers = [...new Set(approvals.map((d) => d.actor))];
  const shortfall: string[] = [];

  if (approvers.length < requirement.requiredApprovals) {
    shortfall.push(`${approvers.length}/${requirement.requiredApprovals} human approval(s) recorded`);
  }
  for (const role of requirement.requiredRoles) {
    const covered = approvals.some((d) => d.role === role);
    if (!covered) shortfall.push(`no ${role} review recorded`);
  }
  if (humanDecisions.some((d) => d.action === 'request-changes')) shortfall.push('changes were requested');
  if (humanDecisions.some((d) => d.action === 'block')) shortfall.push('the review is blocked by a human decision');

  const nonHumanApprovals = decisions.filter((d) => d.actorKind !== 'human' && d.action === 'approve-review');
  if (nonHumanApprovals.length > 0) {
    shortfall.push(`${nonHumanApprovals.length} non-human approval(s) ignored: AI and CI cannot satisfy a human approval requirement`);
  }

  return {
    requirement,
    approvals,
    approvers,
    satisfied: shortfall.length === 0,
    shortfall,
  };
}

export interface StateInput {
  findings: Finding[];
  policy: ReviewPolicy;
  decisions?: ReviewDecision[];
  approvals?: ApprovalStatus;
  /** Set when a newer review supersedes this one. */
  superseded?: boolean;
  /** True when a review pipeline stage failed. */
  incomplete?: boolean;
}

/**
 * Derive the review state. AI can move a review to CHANGES_REQUESTED (it can
 * raise a blocking finding) but never to APPROVED — only human decisions do.
 */
export function computeState(input: StateInput): ReviewState {
  if (input.superseded) return 'SUPERSEDED';
  const decisions = input.decisions ?? [];
  const human = decisions.filter((d) => d.actorKind === 'human');
  if (human.some((d) => d.action === 'block')) return 'BLOCKED';
  if (human.some((d) => d.action === 'request-changes')) return 'CHANGES_REQUESTED';
  // Nothing human has happened yet, whatever the approval policy says.
  if (human.length === 0) return 'PENDING';
  if (!input.approvals?.satisfied) return 'IN_REVIEW';
  if (blockingFindings(input.findings, input.policy).length > 0) return 'CHANGES_REQUESTED';
  return 'APPROVED';
}

/** Severity a reviewer must care about, for display ordering in the UI. */
export function severityBlocks(severity: Severity, policy: ReviewPolicy): boolean {
  return SEVERITY_ORDER[severity] <= SEVERITY_ORDER[policy.security.blockingSeverity];
}
