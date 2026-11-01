import { describe, expect, it } from 'vitest';
import {
  finalizeVerification, prepareVerification, screenOpinions, verificationSummary,
  type VerificationCandidate, type VerificationContext, type VerifierOpinion,
} from '../src';

const FILE = `export function refund(orderId: string, amount: number) {
  const sql = "UPDATE orders SET refunded = " + amount + " WHERE id = '" + orderId + "'";
  return db.query(sql);
}
`;

function context(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return {
    files: new Map([['src/refund.ts', FILE]]),
    addedLines: new Map([['src/refund.ts', new Set([1, 2, 3, 4, 5])]]),
    changedFiles: new Set(['src/refund.ts']),
    executions: [],
    ...overrides,
  };
}

function candidate(overrides: Partial<VerificationCandidate['finding']> = {}, producer = 'rule:security.sql-injection'): VerificationCandidate {
  return {
    producer,
    finding: {
      id: 'DW-1',
      title: 'SQL injection in refund query',
      description: 'The refund statement is built by concatenating orderId and amount into the SQL text, so a caller controls the query.',
      severity: 'critical',
      category: 'security',
      kind: 'problem',
      confidence: 'medium',
      file: 'src/refund.ts',
      range: { start: 2, end: 3 },
      evidence: [{
        kind: 'code',
        file: 'src/refund.ts',
        line: 2,
        snippet: 'const sql = "UPDATE orders SET refunded = " + amount',
        note: 'Query built by concatenation.',
        source: 'deterministic',
      }],
      recommendation: 'Use a parameterised query instead of string concatenation.',
      ruleId: 'security.sql-injection',
      source: 'deterministic',
      ...overrides,
    },
  };
}

function opinion(verdict: VerifierOpinion['verdict'], overrides: Partial<VerifierOpinion> = {}): VerifierOpinion {
  return {
    verifierId: 'ai-verifier-1',
    kind: 'ai',
    verdict,
    confidence: 'high',
    reasoning: 'The statement concatenates request data into SQL.',
    evidence: [{
      kind: 'code',
      file: 'src/refund.ts',
      snippet: 'const sql = "UPDATE orders SET refunded = " + amount',
      note: 'concatenation',
      source: 'ai',
    }],
    ...overrides,
  };
}

describe('finding verification — evidence grouping', () => {
  it('merges a rule finding and a reviewer finding that describe the same defect', () => {
    const prepared = prepareVerification([
      candidate(),
      candidate({ id: 'AI-9', source: 'ai', title: 'Refund SQL is concatenated', snippetless: undefined } as never, 'reviewer:security'),
    ], context());
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.group.members).toHaveLength(2);
    expect(prepared[0]?.group.corroborated).toBe(true);
  });

  it('keeps findings on different categories separate even when lines overlap', () => {
    const prepared = prepareVerification([
      candidate(),
      candidate({ id: 'DW-2', category: 'performance', title: 'Refund issues one query per call', ruleId: 'performance.n+1', source: 'deterministic' }, 'rule:performance.n+1'),
    ], context());
    expect(prepared).toHaveLength(2);
  });
});

describe('finding verification — verdict policy', () => {
  it('confirms a finding demonstrated by static evidence with no model involved', () => {
    const ctx = context();
    const outcomes = finalizeVerification(prepareVerification([candidate()], ctx), ctx);
    const verification = outcomes[0]?.verification;
    expect(verification?.status).toBe('CONFIRMED');
    expect(verification?.evidenceClasses.static).toBeGreaterThan(0);
    expect(verification?.confidence).toBe('verified');
  });

  it('never confirms a finding on model agreement alone', () => {
    const ctx = context({ addedLines: new Map([['src/refund.ts', new Set<number>()]]) });
    // A finding about a line the diff did not add, with no structural check:
    // two agreeing verifiers must still not produce CONFIRMED.
    const weak = candidate({ range: { start: 5, end: 5 }, evidence: [], category: 'concurrency' }, 'reviewer:concurrency');
    weak.finding.description = 'Two concurrent refunds could both succeed for the same order identifier.';
    const prepared = prepareVerification([weak], ctx);
    const opinions = new Map([[prepared[0]!.group.key, [opinion('confirmed'), opinion('confirmed', { verifierId: 'ai-verifier-2' })]]]);
    const outcomes = finalizeVerification(prepared, ctx, { opinionsByGroup: opinions });
    expect(outcomes[0]?.verification.status).toBe('LIKELY');
    expect(outcomes[0]?.verification.method).toContain('Model agreement alone cannot confirm');
    expect(outcomes[0]?.verification.evidenceClasses.model).toBe(2);
  });

  it('rejects a finding whose quoted evidence does not exist', () => {
    const prepared = prepareVerification([
      candidate({
        evidence: [{
          kind: 'code', file: 'src/refund.ts', line: 2,
          snippet: 'const sql = `UPDATE orders SET refunded = ${amount}`;',
          note: 'fabricated', source: 'ai',
        }],
        source: 'ai',
      }),
    ], context());
    const outcomes = finalizeVerification(prepared, context());
    expect(outcomes[0]?.verification.status).toBe('REJECTED');
    expect(outcomes[0]?.verification.method).toMatch(/evidence\.quotes|file\.exists/);
  });

  it('rejects a finding about a file that is not in the review', () => {
    const prepared = prepareVerification([candidate({ file: 'src/missing.ts' })], context());
    const outcomes = finalizeVerification(prepared, context());
    expect(outcomes[0]?.verification.status).toBe('REJECTED');
    expect(outcomes[0]?.verification.checks.some((c) => c.id === 'file.exists' && c.outcome === 'contradicts')).toBe(true);
  });

  it('preserves disagreement as DISPUTED instead of averaging it', () => {
    const ctx = context({ addedLines: new Map([['src/refund.ts', new Set<number>()]]) });
    const weak = candidate({ range: { start: 4, end: 4 }, evidence: [], category: 'concurrency' }, 'reviewer:concurrency');
    weak.finding.description = 'Two concurrent refunds could both succeed for the same order identifier.';
    const prepared = prepareVerification([weak], ctx);
    const opinions = new Map([[prepared[0]!.group.key, [opinion('confirmed'), opinion('rejected', { verifierId: 'ai-verifier-2' })]]]);
    const outcomes = finalizeVerification(prepared, ctx, { opinionsByGroup: opinions });
    expect(outcomes[0]?.verification.status).toBe('DISPUTED');
    expect(outcomes[0]?.verification.verifiers).toHaveLength(2);
  });

  it('caps severity when a critical claim is only model-supported', () => {
    const ctx = context({ addedLines: new Map([['src/refund.ts', new Set<number>()]]) });
    const weak = candidate({ range: { start: 4, end: 4 }, evidence: [], category: 'concurrency' });
    weak.finding.description = 'Two concurrent refunds could both succeed for the same order identifier.';
    const prepared = prepareVerification([weak], ctx);
    const outcomes = finalizeVerification(prepared, ctx);
    expect(outcomes[0]?.verification.severity.effective).toBe('medium');
    expect(outcomes[0]?.verification.severity.reason).toMatch(/Capped at medium/);
  });

  it('discards a verifier opinion whose evidence is fabricated', () => {
    const opinions = screenOpinions([opinion('rejected', {
      evidence: [{ kind: 'code', file: 'src/refund.ts', snippet: 'const NOT_IN_FILE = true;', note: 'invented', source: 'ai' }],
    })], context().files);
    expect(opinions[0]?.discarded).toMatch(/none of the cited evidence/);
    expect(opinions[0]?.evidence).toHaveLength(0);
  });

  it('records a human decision as confirmation even when models disagree', () => {
    const ctx = context({
      humanDecisions: [{ findingId: 'DW-1', action: 'accept', actor: 'hung', at: '2026-10-01T10:00:00.000Z', rationale: 'reproduced in staging' }],
    });
    const prepared = prepareVerification([candidate()], ctx);
    const opinions = new Map([[prepared[0]!.group.key, [opinion('rejected')]]]);
    const outcomes = finalizeVerification(prepared, ctx, { opinionsByGroup: opinions });
    expect(outcomes[0]?.verification.status).toBe('CONFIRMED');
    expect(outcomes[0]?.verification.method).toMatch(/human/i);
  });

  it('confirms on a recorded failing test execution', () => {
    const ctx = context({
      executions: [{ id: 'v1', findingId: 'DW-1', command: 'npx vitest run refund', status: 'failed', exitCode: 1, at: '2026-10-01T10:00:00.000Z' }],
    });
    const prepared = prepareVerification([candidate({ evidence: [] })], ctx);
    const outcomes = finalizeVerification(prepared, ctx);
    expect(outcomes[0]?.verification.status).toBe('CONFIRMED');
    expect(outcomes[0]?.verification.evidenceClasses.test).toBeGreaterThan(0);
  });

  it('summarises statuses and reproducible findings', () => {
    const ctx = context();
    const outcomes = finalizeVerification(prepareVerification([candidate()], ctx), ctx);
    const summary = verificationSummary(outcomes);
    expect(summary.confirmed).toBe(1);
    expect(summary.byStatus.CONFIRMED).toBe(1);
  });
});
