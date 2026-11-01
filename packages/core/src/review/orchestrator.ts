/**
 * Reviewer orchestration.
 *
 * Runs the selected reviewers concurrently under a bounded pool, enforces a
 * per-reviewer timeout and token budget, validates every proposal's evidence
 * before it becomes a finding, and records timing/token metrics per reviewer.
 *
 * A reviewer that failed is never reported as completed. A reviewer that was
 * not selected is reported as skipped with the reason, so the report can show
 * what was deliberately not run.
 */
import type { OrchestratorOptions, OrchestratorResult, ReviewerAgent, ReviewerId, ReviewerProposal, ReviewerRun, ReviewerSpec, TokenUsage } from './types';
import { REVIEWER_IDS } from './types';
import { REVIEWER_SPECS } from './registry';

export const DEFAULT_REVIEWER_CONCURRENCY = 3;

function emptyRun(spec: ReviewerSpec, reasons: string[]): ReviewerRun {
  return {
    reviewerId: spec.id,
    name: spec.name,
    status: 'pending',
    selectedBecause: reasons,
    proposed: 0,
    accepted: 0,
    evidenceRejected: 0,
    tokens: { prompt: 0, completion: 0 },
  };
}

class TimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`reviewer timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new TimeoutError(ms));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { prompt: a.prompt + b.prompt, completion: a.completion + b.completion };
}

/**
 * Execute the plan. Reviewers are independent, so they run concurrently; the
 * pool bound is what keeps a large plan from opening eight provider streams.
 */
export async function runReviewers(options: OrchestratorOptions): Promise<OrchestratorResult> {
  const startedAt = Date.now();
  const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_REVIEWER_CONCURRENCY, options.plan.reviewers.length || 1));
  const planById = new Map(options.plan.decisions.map((d) => [d.reviewerId, d]));
  const agentById = new Map<ReviewerId, ReviewerAgent>(options.agents.map((a) => [a.spec.id, a]));

  const runs: ReviewerRun[] = REVIEWER_IDS.map((id) => {
    const spec = REVIEWER_SPECS[id];
    const decision = planById.get(id);
    const run = emptyRun(spec, decision?.reasons ?? []);
    if (!options.plan.reviewers.includes(id)) {
      run.status = 'skipped';
      run.skippedReason = decision?.selected
        ? 'not in the executed plan'
        : (decision?.reasons[decision.reasons.length - 1] ?? 'not selected for this change');
    } else if (!agentById.has(id)) {
      run.status = 'skipped';
      run.skippedReason = 'no agent implementation registered for this reviewer';
    }
    return run;
  });

  const proposals: OrchestratorResult['proposals'] = [];
  const rejected: OrchestratorResult['rejected'] = [];
  let tokens: TokenUsage = { prompt: 0, completion: 0 };
  let cancelled = false;
  const emit = (): void => options.onUpdate?.(runs.map((r) => ({ ...r, selectedBecause: [...r.selectedBecause] })));

  const queue = [...options.plan.reviewers];
  const controller = new AbortController();
  const onAbort = (): void => {
    cancelled = true;
    controller.abort();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  emit();

  const executeOne = async (reviewerId: ReviewerId): Promise<void> => {
    const run = runs.find((r) => r.reviewerId === reviewerId);
    const agent = agentById.get(reviewerId);
    const spec = REVIEWER_SPECS[reviewerId];
    if (!run || !agent) return;
    if (cancelled) {
      run.status = 'cancelled';
      run.skippedReason = 'review cancelled';
      emit();
      return;
    }
    run.status = 'running';
    run.startedAt = new Date().toISOString();
    emit();
    try {
      const scope = options.scope(spec);
      const result = await withTimeout(
        agent.run({ spec, plan: options.plan, scope, signal: controller.signal }),
        spec.budget.timeoutMs,
        () => controller.abort(),
      );
      run.tokens = result.tokens;
      if (result.model) run.model = result.model;
      if (result.provider) run.provider = result.provider;
      if (result.warning) run.error = result.warning;
      const capped = result.proposals.slice(0, spec.budget.maxFindings);
      run.proposed = result.proposals.length;

      for (const proposal of capped) {
        const verdict = options.accept(spec, proposal);
        if (verdict.ok) {
          proposals.push({ reviewerId, proposal });
          run.accepted += 1;
        } else {
          run.evidenceRejected += 1;
          rejected.push({ reviewerId, title: proposal.title.slice(0, 120), reason: verdict.reason ?? 'evidence rejected' });
        }
      }
      if (result.warning) {
        // Produced output but something degraded: never "completed" without the error.
        run.status = 'completed';
      } else {
        run.status = 'completed';
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (cancelled || (err instanceof Error && err.name === 'AbortError')) {
        run.status = 'cancelled';
        run.error = 'review cancelled';
      } else if (err instanceof TimeoutError) {
        run.status = 'failed';
        run.error = message;
      } else {
        run.status = 'failed';
        run.error = message;
      }
    } finally {
      run.finishedAt = new Date().toISOString();
      run.durationMs = run.startedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : 0;
      tokens = addTokens(tokens, run.tokens);
      emit();
    }
  };

  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      await executeOne(next);
    }
  });
  await Promise.all(workers);
  options.signal?.removeEventListener('abort', onAbort);

  if (cancelled) {
    for (const run of runs) {
      if (run.status === 'pending') {
        run.status = 'cancelled';
        run.skippedReason = 'review cancelled before this reviewer started';
      }
    }
    emit();
  }

  return { runs, proposals, rejected, tokens, cancelled, durationMs: Date.now() - startedAt };
}

/**
 * Structural validation applied to every proposal before it is accepted.
 * This is the deterministic half of verification: it never reasons about
 * intent, only about whether the quoted text exists.
 */
export function validateProposalEvidence(
  proposal: ReviewerProposal,
  files: Map<string, string>,
  locate: (content: string, quote: string) => number | null,
): { ok: boolean; reason?: string } {
  const file = proposal.file.replace(/^\.\//, '');
  const content = files.get(file);
  if (!file) return { ok: false, reason: 'proposal has no file' };
  if (content === undefined) return { ok: false, reason: `file "${file}" is not part of this review` };
  if (!proposal.title || proposal.title.trim().length < 8) return { ok: false, reason: 'title too short to be actionable' };
  if (!proposal.recommendation || proposal.recommendation.trim().length < 8) return { ok: false, reason: 'no actionable recommendation' };
  if (!proposal.description || proposal.description.trim().length < 20) return { ok: false, reason: 'description too short to be reviewable' };
  if (!Array.isArray(proposal.evidence) || proposal.evidence.length === 0) return { ok: false, reason: 'no evidence quoted' };
  const lineCount = content.split(/\r?\n/).length;
  if (!Number.isFinite(proposal.startLine) || proposal.startLine < 1) return { ok: false, reason: 'invalid start line' };
  if (proposal.startLine > lineCount) return { ok: false, reason: `line ${proposal.startLine} is past the end of ${file} (${lineCount} lines)` };
  let located = 0;
  for (const item of proposal.evidence.slice(0, 4)) {
    const eFile = (item.file ?? file).replace(/^\.\//, '');
    const eContent = files.get(eFile);
    if (eContent === undefined) continue;
    if (typeof item.quote !== 'string' || item.quote.trim().length < 3) continue;
    if (locate(eContent, item.quote) !== null) located += 1;
  }
  if (located === 0) return { ok: false, reason: 'none of the quoted evidence exists in the repository' };
  return { ok: true };
}
