import { describe, expect, it } from 'vitest';
import {
  computeState, evaluateApproval, isSuppressed, normalizePolicyLayer, requiredApproval, resolvePolicy,
  type Finding, type PolicyLayerInput, type ReviewDecision, type ReviewPolicy,
} from '../src';

const repo = (value: unknown): PolicyLayerInput => ({ kind: 'repository', source: '.diffwise/policy.json', appliesTo: '**', value });
const org = (value: unknown): PolicyLayerInput => ({ kind: 'organization', source: 'org-policy.json', appliesTo: '**', value });
const dir = (appliesTo: string, value: unknown): PolicyLayerInput => ({ kind: 'directory', source: `policies/${appliesTo}.json`, appliesTo, value });

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'DW-1', title: 't', description: 'd', severity: 'high', category: 'security', kind: 'problem',
    confidence: 'high', file: 'src/a.ts', range: { start: 1, end: 1 }, evidence: [], whyItMatters: 'w',
    consequences: [], recommendation: 'r', ruleId: 'x', source: 'deterministic', tags: [],
    ...overrides,
  };
}

function decision(overrides: Partial<ReviewDecision> = {}): ReviewDecision {
  return {
    id: 'D1', reviewId: 'R1', action: 'approve-review', actor: 'hung', actorKind: 'human',
    rationale: 'looks correct', at: '2026-10-01T10:00:00.000Z', ...overrides,
  };
}

describe('policy precedence', () => {
  it('applies defaults when no layer is present', () => {
    const effective = resolvePolicy([]);
    expect(effective.policy.reviewers.maxReviewers).toBe(3);
    expect(effective.provenance['reviewers.maxReviewers']).toBe('default');
  });

  it('applies organization → repository → directory in order', () => {
    const effective = resolvePolicy([
      org({ qualityGate: { failOn: 'critical' }, reviewers: { maxReviewers: 5 } }),
      repo({ qualityGate: { failOn: 'medium' } }),
      dir('src/payments/**', { reviewers: { maxReviewers: 2 } }),
    ], ['src/payments/refund.ts']);
    expect(effective.policy.qualityGate.failOn).toBe('medium');
    expect(effective.policy.reviewers.maxReviewers).toBe(2);
    expect(effective.provenance['qualityGate.failOn']).toBe('.diffwise/policy.json');
    expect(effective.provenance['reviewers.maxReviewers']).toBe('policies/src/payments/**.json');
  });

  it('skips a directory layer that matches no changed file', () => {
    const effective = resolvePolicy([dir('services/billing/**', { reviewers: { maxReviewers: 1 } })], ['src/app.ts']);
    expect(effective.policy.reviewers.maxReviewers).toBe(3);
    const layer = effective.layers.find((l) => l.kind === 'directory');
    expect(layer?.loaded).toBe(false);
    expect(layer?.error).toMatch(/no changed file/);
  });

  it('appends array fields across layers rather than replacing them', () => {
    const effective = resolvePolicy([
      org({ reviewers: { disabled: ['performance'] } }),
      repo({ reviewers: { disabled: ['database'] } }),
    ]);
    expect(effective.policy.reviewers.disabled).toEqual(['performance', 'database']);
  });

  it('rejects an invalid regex in a forbidden pattern instead of ignoring it', () => {
    const effective = resolvePolicy([repo({ security: { forbiddenPatterns: [{ id: 'x', pattern: '([unclosed', message: 'no' }] } })]);
    expect(effective.policy.security.forbiddenPatterns).toHaveLength(0);
    expect(effective.warnings.join(' ')).toMatch(/not a valid regular expression/);
  });

  it('warns about unknown fields rather than silently dropping them', () => {
    const { warnings } = normalizePolicyLayer({ reviewerz: { maxReviewers: 1 } }, 'typo.json');
    expect(warnings.join(' ')).toMatch(/reviewerz is not a recognised field/);
  });

  it('ignores an expired suppression and says so', () => {
    const effective = resolvePolicy([repo({
      rules: {
        suppress: [{
          ruleId: 'security.sql-injection', reason: 'legacy module', approvedBy: 'hung',
          expiresAt: '2020-01-01T00:00:00.000Z',
        }],
      },
    })]);
    expect(effective.policy.rules.suppress).toHaveLength(0);
    expect(effective.warnings.join(' ')).toMatch(/expired on 2020-01-01/);
  });

  it('keeps an unexpired suppression and matches it by glob', () => {
    const effective = resolvePolicy([repo({
      rules: {
        suppress: [{
          ruleId: 'security.sql-injection', reason: 'legacy module', approvedBy: 'hung',
          expiresAt: '2099-01-01T00:00:00.000Z', files: ['legacy/**'],
        }],
      },
    })]);
    expect(isSuppressed(effective.policy, 'security.sql-injection', 'legacy/db.ts')).not.toBeNull();
    expect(isSuppressed(effective.policy, 'security.sql-injection', 'src/db.ts')).toBeNull();
  });

  it('cannot be configured to waive a human approval for severe risk', () => {
    const effective = resolvePolicy([repo({ approvals: { requiredApprovals: { severe: 0 } } })]);
    expect(effective.policy.approvals.requiredApprovals.severe).toBe(1);
    expect(effective.warnings.join(' ')).toMatch(/always requires a human approval/);
  });

  it('cannot be configured to make verification commands run without approval', () => {
    const effective = resolvePolicy([repo({ verification: { requireApproval: false } })]);
    expect(effective.policy.verification.requireApproval).toBe(true);
  });
});

describe('approval policy', () => {
  const policy: ReviewPolicy = resolvePolicy([]).policy;
  const risk = (level: 'low' | 'moderate' | 'high' | 'severe', score = 10): { level: typeof level; score: number; factors: never[]; summary: string; method: string } => ({
    level, score, factors: [], summary: '', method: '',
  });

  it('maps risk to a recommended approval count and roles', () => {
    const requirement = requiredApproval({
      risk: risk('severe', 90), policy, changes: [{ path: 'src/auth/login.ts' }], findings: [],
    });
    expect(requirement.requiredApprovals).toBe(2);
    expect(requirement.requiredRoles).toContain('security');
    expect(requirement.policyLine).toMatch(/Recommendation only/);
  });

  it('adds an owner role from policy ownerPaths', () => {
    const withOwner: ReviewPolicy = {
      ...policy,
      approvals: { ...policy.approvals, ownerPaths: [{ glob: 'src/payments/**', role: 'billing-owner', reason: 'payments need their owner' }] },
    };
    const requirement = requiredApproval({ risk: risk('moderate'), policy: withOwner, changes: [{ path: 'src/payments/refund.ts' }], findings: [] });
    expect(requirement.requiredRoles).toContain('billing-owner');
    expect(requirement.basis.join(' ')).toContain('payments need their owner');
  });

  it('never lets an AI approval satisfy a human requirement', () => {
    const status = evaluateApproval({
      risk: risk('high'), policy, changes: [{ path: 'src/a.ts' }], findings: [],
      decisions: [decision({ actorKind: 'ai', actor: 'gpt' }), decision({ actorKind: 'ai', actor: 'claude', id: 'D2' })],
    });
    expect(status.satisfied).toBe(false);
    expect(status.shortfall.join(' ')).toMatch(/non-human approval/);
    expect(status.approvers).toHaveLength(0);
  });

  it('is satisfied by the required number of distinct human approvals', () => {
    const status = evaluateApproval({
      risk: risk('high'), policy, changes: [{ path: 'src/a.ts' }], findings: [],
      decisions: [decision({ id: 'D1', actor: 'ana' }), decision({ id: 'D2', actor: 'bob' })],
    });
    expect(status.approvers).toEqual(['ana', 'bob']);
    expect(status.satisfied).toBe(true);
  });

  it('requires the policy roles, not just any two approvals', () => {
    const withSecurity: ReviewPolicy = {
      ...policy,
      approvals: { ...policy.approvals, requiredRoles: { severe: ['security'] } },
    };
    const status = evaluateApproval({
      risk: risk('severe'), policy: withSecurity, changes: [{ path: 'src/a.ts' }], findings: [],
      decisions: [decision({ id: 'D1', actor: 'ana' }), decision({ id: 'D2', actor: 'bob' })],
    });
    expect(status.satisfied).toBe(false);
    expect(status.shortfall.join(' ')).toMatch(/no security review/);
  });
});

describe('review state machine', () => {
  const policy = resolvePolicy([]).policy;
  const satisfy = (satisfied: boolean) => evaluateApproval({
    risk: { level: 'low', score: 1, factors: [], summary: '', method: '' }, policy, changes: [], findings: [],
    decisions: satisfied ? [decision()] : [],
  });
  const approvals = (satisfied: boolean) => ({
    approvals: satisfy(satisfied),
    decisions: satisfied ? [decision()] : [],
  });

  it('is PENDING before any human decision', () => {
    expect(computeState({ findings: [], policy, ...approvals(false) })).toBe('PENDING');
  });

  it('moves to CHANGES_REQUESTED when a human requests changes', () => {
    const state = computeState({
      findings: [], policy, approvals: approvals(true),
      decisions: [decision({ action: 'request-changes', rationale: 'needs a test' })],
    });
    expect(state).toBe('CHANGES_REQUESTED');
  });

  it('is BLOCKED when a human blocks the review', () => {
    const state = computeState({
      findings: [], policy, decisions: [decision({ action: 'block', rationale: 'security review failed' })],
    });
    expect(state).toBe('BLOCKED');
  });

  it('is APPROVED only when approvals are satisfied and nothing blocking remains', () => {
    expect(computeState({ findings: [], policy, ...approvals(true) })).toBe('APPROVED');
    expect(computeState({
      findings: [finding({ severity: 'critical', verification: { status: 'CONFIRMED' } as never })],
      policy, ...approvals(true),
    })).toBe('CHANGES_REQUESTED');
  });

  it('ignores rejected findings when deciding whether the review is blocked', () => {
    expect(computeState({
      findings: [finding({ severity: 'critical', verification: { status: 'REJECTED' } as never })],
      policy, ...approvals(true),
    })).toBe('APPROVED');
  });

  it('marks a superseded review as SUPERSEDED regardless of approvals', () => {
    expect(computeState({ findings: [], policy, ...approvals(true), superseded: true })).toBe('SUPERSEDED');
  });
});
