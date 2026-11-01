import type { ReviewReport } from '@diffwise/core';
import { Chip, EmptyState, Field, SectionHeader, Stat, duration } from '../ui';

/**
 * Pipeline section.
 *
 * Shows exactly what ran, what did not, how long it took and how much it
 * produced. A stage that failed is never rendered as completed, and a stage that
 * was skipped says why — the report must not imply work it did not do.
 */

const STATUS_TONE: Record<string, 'neutral' | 'accent' | 'good' | 'warn' | 'bad'> = {
  completed: 'good',
  running: 'accent',
  pending: 'neutral',
  skipped: 'neutral',
  failed: 'bad',
  cancelled: 'warn',
};

function StatusChip({ status }: { status: string }) {
  return <Chip tone={STATUS_TONE[status] ?? 'neutral'}>{status}</Chip>;
}

function metricLine(metrics?: Record<string, number | string>): string {
  if (!metrics) return '';
  const entries = Object.entries(metrics).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => `${k} ${v}`).join(' · ');
}

export function Pipeline({ report }: { report: ReviewReport }) {
  const review = report.review;
  const stages = report.stages ?? [];
  const failed = stages.filter((s) => s.status === 'failed');
  const reviewers = review?.reviewerRuns ?? [];
  const ruleRuns = review?.ruleRuns ?? [];
  const verification = review?.verification;

  const totalMs = stages.reduce((n, s) => n + (s.durationMs ?? 0), 0);

  return (
    <div className="section">
      <SectionHeader
        eyebrow="Pipeline"
        title="What the review actually ran"
        description="Every stage records its own status, duration and output. Nothing here is inferred from the presence of code."
      />

      <div className="stats">
        <Stat label="Stages" value={stages.length === 0 ? '—' : `${stages.filter((s) => s.status === 'completed').length}/${stages.length}`} hint="completed" />
        <Stat label="Stage time" value={duration(totalMs)} hint="sum of recorded durations" />
        <Stat label="Rules run" value={ruleRuns.filter((r) => r.status === 'ran').length} hint={`${ruleRuns.length} considered`} />
        <Stat label="Reviewers" value={reviewers.filter((r) => r.status === 'completed').length} hint={`${(review?.plan.reviewers ?? []).length} selected`} />
        <Stat label="Verified" value={`${verification?.confirmed ?? 0} confirmed`} hint={`${verification?.likely ?? 0} likely · ${verification?.rejected ?? 0} rejected`} />
        <Stat label="Completeness" value={report.summary?.completeness ?? 'unknown'} tone={report.summary?.completeness === 'complete' ? 'good' : 'warn'} />
      </div>

      {failed.length > 0 && (
        <div className="banner banner-error">
          <strong>{failed.length} stage(s) failed.</strong> The report is marked {report.summary.completeness}; findings may be incomplete.
          <ul>
            {failed.map((s) => <li key={s.id}>{s.label}: {s.error ?? 'unknown error'}</li>)}
          </ul>
        </div>
      )}

      <h3 className="dw-subhead">Stages</h3>
      <ol className="pipeline-stages">
        {stages.map((stage) => (
          <li key={stage.id} className={`pipeline-stage pipeline-stage-${stage.status}`}>
            <div className="pipeline-stage-head">
              <span className="pipeline-stage-name">{stage.label}</span>
              <StatusChip status={stage.status} />
              <span className="pipeline-stage-time">{stage.durationMs !== undefined ? duration(stage.durationMs) : '—'}</span>
            </div>
            {stage.detail && <div className="pipeline-stage-detail">{stage.detail}</div>}
            {stage.error && <div className="problem-text">{stage.error}</div>}
            {stage.metrics && <div className="pipeline-stage-metrics">{metricLine(stage.metrics)}</div>}
          </li>
        ))}
      </ol>

      {reviewers.length > 0 && (
        <>
          <h3 className="dw-subhead">Reviewers</h3>
          <p className="muted">{review?.plan.reviewers.length ?? 0} of {reviewers.length} reviewers ran (cap {review?.plan.maxReviewers}).
            {' '}Selection is deterministic: a reviewer runs when the change contains a signal it can act on.</p>
          <table className="dw-table">
            <thead>
              <tr><th>Reviewer</th><th>Status</th><th>Findings</th><th>Rejected</th><th>Tokens</th><th>Time</th><th>Why</th></tr>
            </thead>
            <tbody>
              {reviewers.map((run) => (
                <tr key={run.reviewerId}>
                  <td>{run.name}</td>
                  <td><StatusChip status={run.status} /></td>
                  <td>{run.accepted}{run.proposed !== run.accepted ? ` / ${run.proposed} proposed` : ''}</td>
                  <td>{run.evidenceRejected}</td>
                  <td>{run.tokens.prompt + run.tokens.completion || '—'}</td>
                  <td>{run.durationMs !== undefined ? duration(run.durationMs) : '—'}</td>
                  <td className="muted">
                    {run.error ? <span className="problem-text">{run.error}</span> : null}
                    {run.skippedReason ? run.skippedReason : (run.selectedBecause[0] ?? '—')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {ruleRuns.length > 0 && (
        <>
          <h3 className="dw-subhead">Deterministic rules</h3>
          <p className="muted">
            {ruleRuns.filter((r) => r.status === 'ran').length} ran ·{' '}
            {ruleRuns.filter((r) => r.status === 'disabled').length} disabled ·{' '}
            {ruleRuns.filter((r) => r.status === 'skipped').length} skipped ·{' '}
            {ruleRuns.filter((r) => r.status === 'failed').length} failed
          </p>
          <table className="dw-table">
            <thead><tr><th>Rule</th><th>Pack</th><th>Status</th><th>Findings</th><th>Time</th><th>Note</th></tr></thead>
            <tbody>
              {ruleRuns.slice(0, 60).map((run) => (
                <tr key={run.id}>
                  <td><code>{run.id}</code></td>
                  <td>{run.pack}</td>
                  <td><StatusChip status={run.status} /></td>
                  <td>{run.findings}</td>
                  <td>{duration(run.durationMs)}</td>
                  <td className="muted">{run.error ?? run.reason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {ruleRuns.length > 60 && <p className="muted">… {ruleRuns.length - 60} more</p>}
        </>
      )}

      {!review && (
        <EmptyState
          title="This report predates the reviewer pipeline"
          body="It was produced before schema v3, so there is no reviewer or verification record to show. Run a new review to get the full pipeline."
        />
      )}

      <h3 className="dw-subhead">Execution</h3>
      {report.execution ? (
        <div className="dw-fields">
          <Field label="Tool" value={`${report.execution.tool} ${report.execution.toolVersion}`} />
          <Field label="Command" value={report.execution.command} mono />
          <Field label="Node" value={report.execution.nodeVersion} />
          <Field label="Platform" value={report.execution.platform} />
          <Field label="Files indexed" value={report.execution.indexedFiles} />
          <Field label="Report schema" value={`v${report.schemaVersion}`} />
        </div>
      ) : (
        <p className="muted">This report does not record its execution metadata (it predates schema v2).</p>
      )}
    </div>
  );
}
