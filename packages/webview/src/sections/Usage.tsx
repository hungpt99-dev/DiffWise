import type { ReviewReport } from '@diffwise/core';
import { Chip, cx } from '../ui';

/**
 * AI usage and cost.
 *
 * The point of this panel is to make spend and waste visible without pretending
 * to know more than the provider reported:
 *
 *  - token counts say whether they came from the provider or from the estimator;
 *  - a cost is shown only when a price is configured, otherwise the absence is
 *    stated rather than rendered as $0.00;
 *  - the per-task split answers "what did verification cost?".
 */
type AiUsage = NonNullable<ReviewReport['ai']>;

const TASK_LABEL: Record<string, string> = {
  review: 'Review',
  verify: 'Verification',
  fix: 'Fix generation',
  chat: 'Discussion',
  summarize: 'Summary',
  untagged: 'Untagged',
};

/** Latency with an explicit unit; "5m" alone is ambiguous in a table cell. */
function lag(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function AiUsagePanel({ ai }: { ai: AiUsage }) {
  const totalTokens = ai.promptTokens + ai.completionTokens;
  const tasks = ai.byTask ?? [];
  const source = ai.usageSource ?? 'provider';
  const cacheHits = ai.cacheHits ?? 0;
  const cacheMisses = ai.cacheMisses ?? 0;
  const cacheRequests = cacheHits + cacheMisses;
  const hitRate = cacheRequests > 0 ? cacheHits / cacheRequests : 0;

  return (
    <section className="card usage-card" aria-label="AI usage and cost">
      <div className="card-head">
        <h2>AI usage</h2>
        <Chip tone={source === 'provider' ? 'good' : 'warn'}>
          {source === 'provider' ? 'provider-reported' : source === 'estimated' ? 'estimated' : 'mixed'}
        </Chip>
      </div>

      {totalTokens === 0 && ai.requests > 0 && cacheHits > 0 && (
        // A fully cached run bills nothing. Saying "0 tokens" without the reason
        // reads like a broken meter.
        <p className="method">
          Every request in this run was served from the answer cache — no tokens were billed.
          {ai.tokensSavedByCache ? ` ${ai.tokensSavedByCache.toLocaleString('en-US')} tokens avoided.` : ''}
        </p>
      )}

      <div className="usage-totals">
        <div className="usage-stat">
          <div className="usage-value">{ai.requests}</div>
          <div className="usage-label">requests</div>
        </div>
        <div className="usage-stat">
          <div className="usage-value">{compact(totalTokens)}</div>
          <div className="usage-label">tokens total</div>
        </div>
        <div className="usage-stat">
          <div className="usage-value">{compact(ai.promptTokens)}</div>
          <div className="usage-label">input</div>
        </div>
        <div className="usage-stat">
          <div className="usage-value">{compact(ai.completionTokens)}</div>
          <div className="usage-label">output</div>
        </div>
        <div className="usage-stat">
          <div className="usage-value">
            {ai.estimatedCostUsd !== undefined ? `$${ai.estimatedCostUsd.toFixed(4)}` : '—'}
          </div>
          <div className="usage-label">{ai.estimatedCostUsd !== undefined ? 'charged (est.)' : 'cost unknown'}</div>
        </div>
      </div>

      {tasks.length > 0 && (
        <table className="usage-table">
          <thead>
            <tr>
              <th scope="col">Task</th>
              <th scope="col" className="num">Req</th>
              <th scope="col" className="num">Input</th>
              <th scope="col" className="num">Output</th>
              <th scope="col" className="num">Latency</th>
              <th scope="col" className="num" title="cache hits / requests">Cache</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={`${task.task}-${task.model}`}>
                <td className="usage-task">{TASK_LABEL[task.task] ?? task.task}<span className="usage-model">{task.model}</span></td>
                <td className="num">{task.requests}</td>
                <td className="num">{compact(task.promptTokens)}</td>
                <td className="num">{compact(task.completionTokens)}</td>
                <td className="num">{lag(task.latencyMs)}</td>
                <td className="num">{task.cacheHits > 0 ? `${task.cacheHits}/${task.requests}` : `0/${task.requests}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <ul className="usage-notes">
        {cacheRequests > 0 && (
          <li className={cx('usage-note', hitRate > 0 && 'good')}>
            DiffWise cache {cacheHits}/{cacheRequests} hit ({(hitRate * 100).toFixed(0)}%)
            {ai.tokensSavedByCache ? ` · ${compact(ai.tokensSavedByCache)} input tokens avoided` : ''}
          </li>
        )}
        {ai.cachedPromptTokens
          ? <li className="usage-note">{compact(ai.cachedPromptTokens)} input tokens billed at the provider's own cached rate (provider-side prompt cache, separate from DiffWise's cache)</li>
          : null}
        {ai.reasoningTokens ? <li className="usage-note">{compact(ai.reasoningTokens)} reasoning tokens</li> : null}
        {ai.evidenceRejected > 0 && <li className="usage-note">{ai.evidenceRejected} model claim(s) rejected by evidence validation</li>}
        {ai.redactions > 0 && <li className="usage-note">{ai.redactions} secret(s) redacted before sending</li>}
        <li className="usage-note muted">{ai.costCaveat ?? 'No price is configured for this model, so no cost is reported.'}</li>
      </ul>
    </section>
  );
}
