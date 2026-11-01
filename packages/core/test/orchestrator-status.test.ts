import { describe, expect, it } from 'vitest';
import {
  REVIEWER_SPECS, runReviewers, selectReviewers, type FileChange, type Language, type ReviewerAgent,
} from '../src';

function change(path: string, lines: string[], language: Language = 'typescript'): FileChange {
  return {
    path, status: 'modified', additions: lines.length, deletions: 0, binary: false, language,
    patch: `@@ -1,1 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}`,
    hunks: [{
      oldStart: 1, oldLines: 1, newStart: 1, newLines: lines.length, header: '@@ -1,1 +1,1 @@',
      lines: lines.map((text, i) => ({ kind: 'add' as const, text, newLine: i + 1 })),
    }],
  };
}

describe('reviewer run status', () => {
  const plan = selectReviewers({ changes: [change('src/auth/session.ts', ['const token = req.headers.authorization;'])] });

  it('does not report a reviewer that produced nothing and warned as completed', async () => {
    // Regression: a provider abort was recorded as `completed` with an error,
    // which inflated the "reviewers: N/M" line and hid a lost reviewer.
    const agents = plan.reviewers.map((id) => ({
      spec: REVIEWER_SPECS[id],
      run: async () => ({ proposals: [], tokens: { prompt: 10, completion: 0 }, warning: 'provider error: This operation was aborted' }),
    })) as unknown as ReviewerAgent[];

    const result = await runReviewers({
      agents, plan, scope: () => ({ diff: '', files: [], related: [], deterministicFindings: [] }), accept: () => ({ ok: true }),
    });

    for (const run of result.runs.filter((r) => r.status !== 'skipped')) {
      expect(run.status).toBe('failed');
      expect(run.error).toContain('aborted');
    }
  });

  it('keeps a reviewer completed when it produced findings and one part degraded', async () => {
    const agents = plan.reviewers.map((id) => ({
      spec: REVIEWER_SPECS[id],
      run: async () => ({
        proposals: [{
          title: 'Session token is trusted without verification',
          description: 'The handler reads the authorization header and never verifies the signature before use.',
          severity: 'high', category: 'security', kind: 'problem', confidence: 'high',
          file: 'src/auth/session.ts', startLine: 1,
          evidence: [{ file: 'src/auth/session.ts', line: 1, quote: 'const token = req.headers.authorization;' }],
          recommendation: 'Verify the token signature before trusting its claims.',
        }],
        tokens: { prompt: 10, completion: 5 },
        warning: 'one retry was needed',
      }),
    })) as unknown as ReviewerAgent[];

    const result = await runReviewers({
      agents, plan, scope: () => ({ diff: '', files: [], related: [], deterministicFindings: [] }), accept: () => ({ ok: true }),
    });
    const active = result.runs.filter((r) => r.status !== 'skipped');
    expect(active.every((r) => r.status === 'completed')).toBe(true);
  });

  it('honours an explicit timeout override', async () => {
    const agents = [{
      spec: REVIEWER_SPECS.correctness,
      run: () => new Promise((resolve) => setTimeout(() => resolve({ proposals: [], tokens: { prompt: 0, completion: 0 } }), 2_000)),
    }] as unknown as ReviewerAgent[];
    const started = Date.now();
    const result = await runReviewers({
      agents,
      plan: { ...plan, reviewers: ['correctness'] },
      timeoutMs: 50,
      scope: () => ({ diff: '', files: [], related: [], deterministicFindings: [] }),
      accept: () => ({ ok: true }),
    });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(result.runs.find((r) => r.reviewerId === 'correctness')?.status).toBe('failed');
  });
});
