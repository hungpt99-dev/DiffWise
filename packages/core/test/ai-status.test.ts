import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ANALYSIS_SETTINGS, runReview } from '@diffwise/core';
import type { ReviewerHookResult, ReviewReport } from '@diffwise/core';

/**
 * The AI review status is the contract that stops a deterministic-only run from
 * being presented as a completed AI review. These tests pin every state.
 */
const repoRoot = resolve(__dirname, '../../..');
let demo: string;
const target = { mode: 'branch' as const, base: 'main', head: 'feature/partial-refunds', label: 'main...feature/partial-refunds' };

beforeAll(async () => {
  demo = await mkdtemp(join(tmpdir(), 'diffwise-ai-status-'));
  execFileSync(process.execPath, [join(repoRoot, 'demo/build-demo-repo.mjs'), '--target', demo], {
    cwd: repoRoot,
    stdio: 'pipe',
  });
}, 120_000);

afterAll(async () => {
  if (demo) await rm(demo, { recursive: true, force: true });
});

const run = (options: {
  aiEnabled: boolean;
  aiRequired?: boolean;
  hooks?: Parameters<typeof runReview>[0]['hooks'];
}): Promise<ReviewReport> => runReview({
  root: demo,
  target,
  settings: { ...DEFAULT_ANALYSIS_SETTINGS, aiEnabled: options.aiEnabled },
  persist: false,
  ...(options.aiRequired ? { aiRequired: true } : {}),
  ...(options.hooks ? { hooks: options.hooks } : {}),
});

function reviewerResult(statuses: Array<'completed' | 'failed'>): ReviewerHookResult {
  const runs = statuses.map((status, i) => ({
    reviewerId: i === 0 ? 'security' : 'concurrency',
    status,
    durationMs: 5,
    tokens: { prompt: 10, completion: 2 },
    proposed: 0,
    accepted: 0,
    model: 'test-model',
    ...(status === 'failed' ? { error: 'provider error: connection reset' } : {}),
  }));
  return {
    findings: [],
    runs,
    plan: {
      reviewers: runs.map((r) => r.reviewerId),
      decisions: [{ reviewerId: 'security', selected: true, reason: 'security_rules' }],
      considered: [],
      maxReviewers: 4,
      route: { provider: 'test', model: 'test-model' },
      truncated: false,
    } as unknown as ReviewerHookResult['plan'],
    tokens: { prompt: 10, completion: 2 },
    durationMs: 5,
    cancelled: false,
  };
}

describe('AI review status', () => {
  it('reports a review with no provider as unavailable, and still completes deterministically', async () => {
    const report = await run({ aiEnabled: true });
    expect(report.review?.ai?.status).toBe('unavailable');
    expect(report.review?.ai?.requested).toBe(false);
    // Not requested means the deterministic review is legitimately complete…
    expect(report.summary.completeness).toBe('complete');
    // …but it says so, rather than passing for an AI review.
    expect(String(report.summary.completenessNote ?? '')).toMatch(/AI review unavailable/);
    expect(report.summary.aiUsed).toBe(false);
  });

  it('distinguishes disabled from unavailable', async () => {
    const report = await run({ aiEnabled: false });
    expect(report.review?.ai?.status).toBe('disabled');
    expect(report.review?.ai?.reason).toMatch(/ai\.enabled=false/);
  });

  it('reports failed when every requested reviewer produced nothing', async () => {
    const report = await run({
      aiEnabled: true,
      hooks: { runReviewers: async () => reviewerResult(['failed', 'failed']) },
    });
    expect(report.review?.ai?.status).toBe('failed');
    expect(report.review?.ai?.requested).toBe(true);
    expect(report.review?.ai?.reviewers.failed).toBe(2);
    expect(report.summary.completeness).toBe('partial');
    expect(String(report.summary.completenessNote ?? '')).toMatch(/AI review failed/);
  });

  it('reports partial when one reviewer was lost and the rest completed', async () => {
    const report = await run({
      aiEnabled: true,
      hooks: { runReviewers: async () => reviewerResult(['completed', 'failed']) },
    });
    expect(report.review?.ai?.status).toBe('partial');
    expect(report.review?.ai?.reviewers).toMatchObject({ completed: 1, failed: 1 });
    expect(report.summary.completeness).toBe('partial');
    expect(String(report.summary.completenessNote ?? '')).toMatch(/AI review partial/);
    expect(String(report.summary.completenessNote ?? '')).toMatch(/connection reset/);
    expect(report.review?.ai?.models?.review).toBe('test-model');
  });

  it('reports complete when the AI stage ran to its end', async () => {
    const report = await run({
      aiEnabled: true,
      hooks: { runReviewers: async () => reviewerResult(['completed']) },
    });
    expect(report.review?.ai?.status).toBe('complete');
    expect(report.summary.completeness).toBe('complete');
    expect(report.summary.aiUsed).toBe(true);
  });

  it('treats a required-but-absent AI stage as incomplete', async () => {
    // The AI-first contract: a team can require AI without a key present, and
    // the review must not claim completeness on the strength of rules alone.
    const report = await run({ aiEnabled: true, aiRequired: true });
    expect(report.review?.ai?.status).toBe('unavailable');
    expect(report.review?.ai?.required).toBe(true);
    expect(report.summary.completeness).toBe('partial');
  });
});
