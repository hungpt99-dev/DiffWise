/**
 * Usage accounting.
 *
 * Every model call in a review is attributed to a task (review, verify, fix,
 * chat). The report then answers questions the old single aggregate could not:
 * which stage spent the tokens, how many requests were retried, and how much
 * the cache avoided.
 *
 * Token counts come from the provider when it reports them. When it does not,
 * they are estimates and `source` says so — the two are never mixed under one
 * label.
 */
import { computeCost, resolvePrice, type CostEstimate, type PriceTable } from './pricing';

export type AiTask = 'review' | 'verify' | 'fix' | 'chat' | 'summarize' | 'untagged';

export interface TaskUsageRecord {
  task: AiTask;
  provider: string;
  model: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  /** Tokens the provider charged as cached input, when reported. */
  cachedPromptTokens: number;
  /** Reasoning tokens, when the provider reports them separately. */
  reasoningTokens: number;
  cacheHits: number;
  cacheMisses: number;
  /** Prompt tokens a content-addressed cache avoided re-sending. */
  tokensSavedByCache: number;
  retries: number;
  failures: number;
  latencyMs: number;
  /** 'provider' when the provider returned counts, 'estimated' otherwise. */
  source: 'provider' | 'estimated' | 'mixed';
}

export interface UsageSummary {
  totals: {
    requests: number;
    promptTokens: number;
    completionTokens: number;
    cachedPromptTokens: number;
    reasoningTokens: number;
    cacheHits: number;
    cacheMisses: number;
    tokensSavedByCache: number;
    retries: number;
    failures: number;
    latencyMs: number;
    source: 'provider' | 'estimated' | 'mixed';
  };
  byTask: TaskUsageRecord[];
  cost?: CostEstimate;
  /** 'unknown' when no price is configured — never a fabricated zero. */
  costBasis: 'list-price' | 'unknown';
  caveat: string;
}

export interface UsageEntry {
  task: AiTask;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number;
  reasoningTokens?: number;
  cacheHit?: boolean;
  tokensSavedByCache?: number;
  retry?: boolean;
  failure?: boolean;
  latencyMs?: number;
  /** Whether the token counts came from the provider or from the estimator. */
  source?: 'provider' | 'estimated';
}

function empty(task: AiTask, provider: string, model: string, source: TaskUsageRecord['source'] = 'provider'): TaskUsageRecord {
  return {
    task, provider, model, requests: 0, promptTokens: 0, completionTokens: 0,
    cachedPromptTokens: 0, reasoningTokens: 0, cacheHits: 0, cacheMisses: 0,
    tokensSavedByCache: 0, retries: 0, failures: 0, latencyMs: 0, source,
  };
}

function mergeSource(a: TaskUsageRecord['source'], b: TaskUsageRecord['source']): TaskUsageRecord['source'] {
  return a === b ? a : 'mixed';
}

export class UsageMeter {
  private readonly tasks = new Map<string, TaskUsageRecord>();

  record(entry: UsageEntry): void {
    const key = `${entry.task}::${entry.provider}::${entry.model}`;
    const record = this.tasks.get(key) ?? empty(entry.task, entry.provider, entry.model, entry.source ?? 'provider');
    record.requests += 1;
    record.promptTokens += Math.max(0, entry.promptTokens);
    record.completionTokens += Math.max(0, entry.completionTokens);
    record.cachedPromptTokens += Math.max(0, entry.cachedPromptTokens ?? 0);
    record.reasoningTokens += Math.max(0, entry.reasoningTokens ?? 0);
    if (entry.cacheHit) record.cacheHits += 1;
    else record.cacheMisses += 1;
    record.tokensSavedByCache += Math.max(0, entry.tokensSavedByCache ?? 0);
    if (entry.retry) record.retries += 1;
    if (entry.failure) record.failures += 1;
    record.latencyMs += Math.max(0, entry.latencyMs ?? 0);
    // Only merge once the record has taken its first entry's source; otherwise a
    // record created as 'provider' turns 'estimated' into a bogus 'mixed'.
    record.source = record.requests === 1 ? (entry.source ?? 'provider') : mergeSource(record.source, entry.source ?? 'provider');
    this.tasks.set(key, record);
  }

  reset(): void {
    this.tasks.clear();
  }

  records(): TaskUsageRecord[] {
    return [...this.tasks.values()].sort((a, b) => b.promptTokens - a.promptTokens);
  }

  summary(priceTable?: PriceTable): UsageSummary {
    const byTask = this.records();
    const totals = byTask.reduce((acc, r) => ({
      requests: acc.requests + r.requests,
      promptTokens: acc.promptTokens + r.promptTokens,
      completionTokens: acc.completionTokens + r.completionTokens,
      cachedPromptTokens: acc.cachedPromptTokens + r.cachedPromptTokens,
      reasoningTokens: acc.reasoningTokens + r.reasoningTokens,
      cacheHits: acc.cacheHits + r.cacheHits,
      cacheMisses: acc.cacheMisses + r.cacheMisses,
      tokensSavedByCache: acc.tokensSavedByCache + r.tokensSavedByCache,
      retries: acc.retries + r.retries,
      failures: acc.failures + r.failures,
      latencyMs: acc.latencyMs + r.latencyMs,
      source: acc.source as TaskUsageRecord['source'],
    }), {
      requests: 0, promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0, reasoningTokens: 0,
      cacheHits: 0, cacheMisses: 0, tokensSavedByCache: 0, retries: 0, failures: 0, latencyMs: 0,
      source: 'provider' as TaskUsageRecord['source'],
    });

    // The run's source is 'provider' only when every task reported provider
    // counts; a single estimated task makes the total 'mixed'.
    const sources = new Set(byTask.map((r) => r.source));
    totals.source = sources.size === 0 ? 'provider' : sources.size === 1 ? [...sources][0]! : 'mixed';

    const model = byTask[0]?.model;
    const price = model ? resolvePrice(model, priceTable) : undefined;
    const cost = price
      ? computeCost({ prompt: totals.promptTokens, completion: totals.completionTokens, cachedPrompt: totals.cachedPromptTokens }, price)
      : undefined;

    return {
      totals,
      byTask,
      ...(cost ? { cost } : {}),
      costBasis: price ? 'list-price' : 'unknown',
      caveat: price
        ? 'Cost is a list-price estimate computed from token usage; it is not an invoice.'
        : 'No price is configured for this model, so no cost is reported. Token counts are still measured.',
    };
  }
}
