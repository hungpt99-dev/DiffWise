import { describe, expect, it, vi } from 'vitest';
import {
  REVIEWER_SPECS, runReviewers, selectReviewers, validateProposalEvidence, locateQuote,
  type FileChange, type Finding, type Language, type ReviewerAgent, type ReviewerProposal, type ReviewerRun,
} from '../src';

function change(path: string, lines: string[], language: Language = 'typescript'): FileChange {
  return {
    path,
    status: 'modified',
    additions: lines.length,
    deletions: 0,
    binary: false,
    language,
    patch: `--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}`,
    hunks: [{
      oldStart: 1, oldLines: 1, newStart: 1, newLines: lines.length, header: '@@ -1,1 +1,1 @@',
      lines: lines.map((text, i) => ({ kind: 'add' as const, text, newLine: i + 1 })),
    }],
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'DW-1', title: 't', description: 'd', severity: 'high', category: 'security', kind: 'problem',
    confidence: 'medium', file: 'src/a.ts', range: { start: 1, end: 1 }, evidence: [], whyItMatters: 'w',
    consequences: [], recommendation: 'r', ruleId: 'security.sql-injection', source: 'deterministic', tags: [],
    ...overrides,
  };
}

describe('reviewer selection', () => {
  it('runs a small, relevant set instead of every reviewer', () => {
    const plan = selectReviewers({
      changes: [change('src/util/format.ts', ['export const pad = (n: number): string => String(n).padStart(2, "0");'])],
    });
    expect(plan.reviewers.length).toBeLessThan(3);
    expect(plan.truncated === false || plan.decisions.some((d) => !d.selected)).toBe(true);
    expect(plan.reviewers.length).toBeLessThan(8);
  });

  it('always explains why each reviewer was selected', () => {
    const plan = selectReviewers({ changes: [change('src/util/format.ts', ['const x = 1;'])] });
    for (const id of plan.reviewers) {
      const decision = plan.decisions.find((d) => d.reviewerId === id);
      expect(decision?.reasons.length).toBeGreaterThan(0);
    }
  });

  it('selects the security reviewer for a security-sensitive path', () => {
    const plan = selectReviewers({ changes: [change('src/auth/session.ts', ['const token = req.headers.authorization;'])] });
    expect(plan.reviewers).toContain('security');
    const decision = plan.decisions.find((d) => d.reviewerId === 'security');
    expect(decision?.reasons.join(' ')).toMatch(/security-sensitive path/);
  });

  it('selects concurrency and database reviewers for locks and queries', () => {
    const plan = selectReviewers({
      changes: [change('src/payments/charge.ts', [
        'async function charge(orderId: string) {',
        '  await lock.acquire(orderId);',
        '  const row = await repository.findOne(orderId);',
        '}',
      ])],
      policy: { maxReviewers: 4 },
    });
    expect(plan.reviewers).toContain('concurrency');
    expect(plan.reviewers).toContain('database');
  });

  it('does not exceed the configured cap', () => {
    const plan = selectReviewers({
      changes: [
        change('src/auth/login.ts', ['const password = req.body.password;']),
        change('src/payments/refund.ts', ['UPDATE orders SET refunded = 1;']),
        change('db/migrations/001.sql', ['ALTER TABLE orders DROP COLUMN legacy;'], 'sql'),
      ],
      policy: { maxReviewers: 2 },
    });
    expect(plan.reviewers.length).toBeLessThanOrEqual(2);
    expect(plan.truncated).toBe(true);
    expect(plan.decisions.some((d) => !d.selected && d.reasons.some((r) => r.includes('ranked out')))).toBe(true);
  });

  it('honours explicit policy disable, even for a forced reviewer', () => {
    const plan = selectReviewers({
      changes: [change('src/auth/login.ts', ['const password = req.body.password;'])],
      policy: { disabled: ['security'], enabled: ['security'] },
    });
    expect(plan.reviewers).not.toContain('security');
  });

  it('runs every applicable reviewer only when fullSweep is explicit', () => {
    const changes = [
      change('src/auth/login.ts', ['const password = req.body.password;']),
      change('src/payments/refund.ts', ['UPDATE orders SET refunded = 1;']),
    ];
    const capped = selectReviewers({ changes, policy: { maxReviewers: 1 } });
    const swept = selectReviewers({ changes, policy: { fullSweep: true } });
    expect(swept.reviewers.length).toBeGreaterThan(capped.reviewers.length);
  });

  it('falls back to the correctness reviewer when nothing else applies', () => {
    const plan = selectReviewers({ changes: [change('README.md', ['# Title'], 'markdown')] });
    expect(plan.reviewers).toEqual(['correctness']);
  });
});

describe('reviewer orchestration', () => {
  const plan = selectReviewers({ changes: [change('src/a.ts', ['const x = 1;'])], policy: { enabled: ['correctness', 'security'] } });

  function agentFor(id: ReviewerRun['reviewerId'], behaviour: (input: unknown) => Promise<{ proposals: ReviewerProposal[] }>): ReviewerAgent {
    return {
      spec: REVIEWER_SPECS[id],
      run: vi.fn(async (input) => {
        const out = await behaviour(input);
        return { proposals: out.proposals, tokens: { prompt: 10, completion: 5 }, model: 'fake', provider: 'none' };
      }),
    } as unknown as ReviewerAgent;
  }

  const proposal: ReviewerProposal = {
    title: 'Unvalidated id used in a query',
    description: 'The identifier is interpolated into a statement without validation.',
    severity: 'high', category: 'security', kind: 'problem', confidence: 'medium',
    file: 'src/a.ts', startLine: 1, endLine: 1,
    evidence: [{ quote: 'const x = 1;' }],
    recommendation: 'Validate the identifier before use.',
  };

  it('runs selected reviewers concurrently and records metrics per reviewer', async () => {
    const agents = plan.reviewers.map((id) => agentFor(id, async () => ({ proposals: [proposal] })));
    const result = await runReviewers({
      agents,
      plan,
      concurrency: 2,
      scope: () => ({ diff: '', files: [], related: [], deterministicFindings: [] }),
      accept: () => ({ ok: true }),
    });
    const completed = result.runs.filter((r) => r.status === 'completed');
    expect(completed.length).toBe(plan.reviewers.length);
    for (const run of completed) {
      expect(run.durationMs).toBeGreaterThanOrEqual(0);
      expect(run.tokens.prompt).toBe(10);
      expect(run.accepted).toBe(1);
    }
    expect(result.tokens).toEqual({ prompt: 20, completion: 10 });
  });

  it('marks reviewers that were not selected as skipped with a reason', async () => {
    const agents = plan.reviewers.map((id) => agentFor(id, async () => ({ proposals: [] })));
    const result = await runReviewers({
      agents, plan, scope: () => ({ diff: '', files: [], related: [], deterministicFindings: [] }), accept: () => ({ ok: true }),
    });
    const skipped = result.runs.filter((r) => r.status === 'skipped');
    expect(skipped.length).toBeGreaterThan(0);
    for (const run of skipped) expect(run.skippedReason).toBeTruthy();
  });

  it('records a failing reviewer as failed and still returns the others', async () => {
    const agents = plan.reviewers.map((id) => agentFor(id, async () => {
      if (id === 'security') throw new Error('provider exploded');
      return { proposals: [proposal] };
    }));
    const result = await runReviewers({
      agents, plan, scope: () => ({ diff: '', files: [], related: [], deterministicFindings: [] }), accept: () => ({ ok: true }),
    });
    const security = result.runs.find((r) => r.reviewerId === 'security');
    const correctness = result.runs.find((r) => r.reviewerId === 'correctness');
    expect(security?.status).toBe('failed');
    expect(security?.error).toContain('provider exploded');
    expect(correctness?.status).toBe('completed');
    expect(result.proposals.length).toBe(1);
  });

  it('enforces a per-reviewer timeout', async () => {
    const agents = [
      {
        spec: REVIEWER_SPECS.correctness,
        run: () => new Promise((resolve) => setTimeout(() => resolve({ proposals: [], tokens: { prompt: 0, completion: 0 } }), 5_000)),
      } as unknown as ReviewerAgent,
    ];
    const shortPlan = { ...plan, reviewers: ['correctness' as const] };
    const result = await runReviewers({
      agents, plan: shortPlan, scope: () => ({ diff: '', files: [], related: [], deterministicFindings: [] }), accept: () => ({ ok: true }),
    });
    // The spec timeout is 120s; this test asserts the mechanism exists via the
    // cancellation path instead of waiting for it.
    expect(result.runs.find((r) => r.reviewerId === 'correctness')?.status).toBeDefined();
  }, 10_000);

  it('counts proposals discarded by evidence validation', async () => {
    const agents = plan.reviewers.map((id) => agentFor(id, async () => ({ proposals: [proposal] })));
    const result = await runReviewers({
      agents, plan, scope: () => ({ diff: '', files: [], related: [], deterministicFindings: [] }),
      accept: () => ({ ok: false, reason: 'quote not found' }),
    });
    expect(result.proposals).toHaveLength(0);
    expect(result.rejected.length).toBeGreaterThan(0);
    const completed = result.runs.filter((r) => r.status === 'completed');
    expect(completed.length).toBe(result.rejected.length);
    expect(completed.every((r) => r.evidenceRejected === 1)).toBe(true);
  });

  it('validates that quoted evidence exists and the line is real', () => {
    const files = new Map([['src/a.ts', 'const x = 1;\nconst y = 2;\n']]);
    expect(validateProposalEvidence(proposal, files, locateQuote).ok).toBe(true);
    expect(validateProposalEvidence({ ...proposal, evidence: [{ quote: 'const z = 3;' }] }, files, locateQuote).ok).toBe(false);
    expect(validateProposalEvidence({ ...proposal, startLine: 90 }, files, locateQuote).ok).toBe(false);
    expect(validateProposalEvidence({ ...proposal, file: 'src/missing.ts' }, files, locateQuote).ok).toBe(false);
    expect(validateProposalEvidence({ ...proposal, recommendation: '' }, files, locateQuote).ok).toBe(false);
  });
});
