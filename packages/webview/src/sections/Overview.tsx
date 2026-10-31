import type { ReviewReport } from '@diffwise/core';
import { Banner, Chip, Field, FileRef, RiskMeter, SectionHeader, SeverityBadge, Stat, duration, short, timeAgo } from '../ui';
import type { SectionId } from '../protocol';

export function Overview({ report, onSection, onOpen, onRerun, running }: {
  report: ReviewReport;
  onSection: (id: SectionId) => void;
  onOpen: (file: string, line?: number) => void;
  onRerun?: () => void;
  running?: boolean;
}) {
  const { summary, risk, stages } = report;
  const top = [...report.findings]
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .slice(0, 5);
  const aiStage = stages.find((s) => s.id === 'ai');
  const failed = stages.filter((s) => s.status === 'failed');

  return (
    <div className="stack">
      <SectionHeader
        eyebrow={`Review ${report.id}`}
        title="Engineering overview"
        description={`${report.target.label} · ${timeAgo(report.createdAt)} · analysis took ${duration(report.durationMs)}`}
      />

      {summary.completeness !== 'complete' && (
        <Banner level={summary.completeness === 'failed' ? 'error' : 'warn'} title={summary.completeness === 'failed' ? 'Analysis failed' : 'Partial analysis'}>
          {short(summary.completenessNote ?? 'One or more stages did not complete. Findings below describe only what was analysed.', 420)}
          {failed.length > 0 && <ul className="tight">{failed.map((s) => <li key={s.id}><strong>{s.label}</strong>: {short(s.error ?? 'failed', 240)}</li>)}</ul>}
        </Banner>
      )}

      <div className="grid grid-4">
        <Stat label="Changed files" value={summary.changedFiles} hint={`${report.symbols.length} changed symbols`} />
        <Stat label="Affected components" value={summary.affectedComponents} hint="reachable through imports" />
        <Stat label="Findings" value={report.findings.length} hint={`${summary.findingsBySeverity.critical} critical · ${summary.findingsBySeverity.high} high`} tone={summary.findingsBySeverity.critical ? 'bad' : summary.findingsBySeverity.high ? 'warn' : 'good'} />
        <Stat label="Documentation" value={summary.documentationFindings} hint="inconsistencies found" tone={summary.documentationFindings ? 'warn' : 'good'} />
      </div>

      <div className="grid grid-2">
        <section className="card">
          <div className="card-head">
            <h2>Risk assessment</h2>
            <Chip tone={risk.level === 'low' ? 'good' : risk.level === 'moderate' ? 'warn' : 'bad'}>{risk.level}</Chip>
          </div>
          <RiskMeter score={risk.score} level={risk.level} />
          <p className="lede">{risk.summary}</p>
          <div className="factor-list">
            {risk.factors.map((f) => (
              <div className="factor" key={f.id}>
                <div className="factor-head">
                  <span className="factor-label">{f.label}</span>
                  <span className={`factor-points ${f.points > 0 ? 'pos' : f.points < 0 ? 'neg' : ''}`}>{f.points > 0 ? '+' : ''}{f.points}</span>
                </div>
                <div className="factor-bar"><div style={{ width: `${Math.min(100, Math.abs(f.points) / Math.max(1, f.maxPoints) * 100)}%` }} className={f.points < 0 ? 'neg' : ''} /></div>
                <div className="factor-explain">{f.explanation}</div>
              </div>
            ))}
          </div>
          <p className="method">{risk.method}</p>
        </section>

        <section className="card">
          <div className="card-head"><h2>Analysis completeness</h2><Chip tone={summary.completeness === 'complete' ? 'good' : summary.completeness === 'partial' ? 'warn' : 'bad'}>{summary.completeness}</Chip></div>
          <div className="stage-list">
            {stages.map((s) => (
              <div className="stage" key={s.id}>
                <span className={`stage-dot stage-${s.status}`} aria-hidden="true" />
                <span className="stage-label">{s.label}</span>
                <span className="stage-status">{s.status}{s.durationMs !== undefined ? ` · ${duration(s.durationMs)}` : ''}</span>
                {s.error && <span className="stage-error" title={s.error}>{short(s.error, 120)}</span>}
              </div>
            ))}
          </div>
          <div className="divider" />
          <Field label="AI provider" value={report.provider.configured ? `${report.provider.providerId}${report.provider.model ? ` · ${report.provider.model}` : ''}` : 'Not configured'} />
          <Field label="AI stage" value={aiStage ? `${aiStage.status}${aiStage.detail ? ` — ${aiStage.detail}` : ''}` : 'not run'} />
          {report.ai && (
            <Field label="Model usage" value={`${report.ai.requests} request(s) · ${report.ai.promptTokens + report.ai.completionTokens} tokens · ${report.ai.evidenceRejected} claim(s) rejected · ${report.ai.redactions} secret(s) redacted`} />
          )}
          <Field label="Evidence discipline" value="Every finding below cites a file, a line and repository text. Model claims that failed validation were discarded before reaching this report." />
        </section>
      </div>

      <div className="grid grid-2">
        <section className="card">
          <div className="card-head"><h2>Priority findings</h2><button className="link" onClick={() => onSection('review')}>Open code review →</button></div>
          {top.length === 0 ? <p className="muted">No findings were raised for this change.</p> : (
            <div className="mini-findings">
              {top.map((f) => (
                <button key={f.id} className="mini-finding" onClick={() => onSection('review')}>
                  <SeverityBadge severity={f.severity} compact />
                  <span className="mini-title">{f.title}</span>
                  <span className="mini-file">{f.file}:{f.range.start}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-head"><h2>What changed</h2><button className="link" onClick={() => onSection('changes')}>Explore changes →</button></div>
          <div className="change-summary">
            {report.changeGroups.slice(0, 4).map((g) => (
              <div className="group-row" key={g.id}>
                <div>
                  <div className="group-title">{g.title}</div>
                  <div className="group-purpose">{g.purpose}</div>
                </div>
                <div className="group-meta"><span className="add">+{g.additions}</span><span className="del">−{g.deletions}</span><span className="muted">{g.files.length} file(s)</span></div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-head"><h2>Recommended next actions</h2></div>
        <ul className="actions-list">
          {summary.findingsBySeverity.critical > 0 && <li><strong>Resolve {summary.findingsBySeverity.critical} critical finding(s) before merging.</strong> They are exploitable or data-destroying as written.</li>}
          {report.tests.uncoveredChanges.length > 0 && <li><strong>Add coverage for {report.tests.uncoveredChanges.length} changed file(s).</strong> No test resolves to them today.</li>}
          {report.documentation.findings.length > 0 && <li><strong>Update documentation.</strong> {report.documentation.findings.length} document(s) contradict or omit the new behaviour.</li>}
          {report.agent.unresolved.length > 0 && <li><strong>Close {report.agent.unresolved.length} recorded unresolved issue(s).</strong> The coding agent explicitly left them open.</li>}
          {report.fixes.length > 0 && <li><strong>Review {report.fixes.length} proposed fix option(s).</strong> Each patch was machine-validated against the working tree.</li>}
          {report.findings.length === 0 && <li>No blocking findings. Review the change summary and the evidence for the remaining informational notes.</li>}
        </ul>
        <div className="quick-links">
          <button className="btn ghost" onClick={() => onSection('architecture')}>Architecture impact</button>
          <button className="btn ghost" onClick={() => onSection('documentation')}>Documentation drift</button>
          <button className="btn ghost" onClick={() => onSection('discussion')}>Discuss this report</button>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2>Changed files</h2><span className="muted">{report.changes.length} file(s)</span></div>
        <div className="file-list">
          {report.changes.map((c) => (
            <div className="file-row" key={c.path}>
              <span className={`status status-${c.status}`}>{c.status}</span>
              <FileRef file={c.path} onOpen={onOpen} />
              <span className="file-stats"><span className="add">+{c.additions}</span><span className="del">−{c.deletions}</span></span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function severityRank(s: string): number {
  return { critical: 0, high: 1, medium: 2, low: 3, info: 4 }[s] ?? 5;
}
