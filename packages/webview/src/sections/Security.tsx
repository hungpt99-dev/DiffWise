import { useMemo, useState } from 'react';
import type { Finding, ReviewReport } from '@diffwise/core';
import { Banner, Chip, EmptyState, EvidenceList, FileRef, SeverityBadge, SectionHeader, Tabs } from '../ui';

const CATEGORIES = ['security', 'concurrency', 'database', 'reliability', 'error-handling', 'resources', 'configuration'] as const;

export function Security({ report, onOpen, onDiscuss }: { report: ReviewReport; onOpen: (file: string, line?: number) => void; onDiscuss: (id: string) => void }) {
  const [tab, setTab] = useState<'security' | 'reliability'>('security');
  const [activeId, setActiveId] = useState<string | undefined>();
  const security = useMemo(() => report.findings.filter((f) => ['security', 'configuration', 'resources'].includes(f.category)), [report.findings]);
  const reliability = useMemo(() => report.findings.filter((f) => ['reliability', 'concurrency', 'database', 'error-handling'].includes(f.category)), [report.findings]);
  const list = tab === 'security' ? security : reliability;
  const active = list.find((f) => f.id === activeId) ?? list[0];
  const severity = (s: string) => ({ critical: 0, high: 1, medium: 2, low: 3, info: 4 }[s] ?? 5);

  return (
    <div className="stack">
      <SectionHeader
        eyebrow="Security and reliability"
        title="What could go wrong"
        description="Security findings, failure scenarios, concurrency hazards, transaction risks and reliability gaps in this change. Each one is tied to repository evidence."
      />

      <div className="grid grid-4">
        <div className="mini-stat"><strong>{security.filter((f) => f.severity === 'critical').length}</strong><span>critical security</span></div>
        <div className="mini-stat"><strong>{security.length}</strong><span>security & config findings</span></div>
        <div className="mini-stat"><strong>{reliability.filter((f) => ['concurrency', 'database'].includes(f.category)).length}</strong><span>state integrity risks</span></div>
        <div className="mini-stat"><strong>{reliability.length}</strong><span>reliability findings</span></div>
      </div>

      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'security', label: 'Security & configuration', count: security.length }, { id: 'reliability', label: 'Failure & consistency', count: reliability.length }]} />

      {list.length === 0 ? (
        <EmptyState title={tab === 'security' ? 'No security finding in this change' : 'No reliability finding in this change'} body="This means the deterministic checks and the model found nothing in this dimension for the analysed files. It is not a full security audit." />
      ) : (
        <div className="split">
          <div className="list-pane">
            {[...list].sort((a, b) => severity(a.severity) - severity(b.severity)).map((f) => (
              <button key={f.id} className={`finding-row ${f.id === active?.id ? 'finding-row-active' : ''}`} onClick={() => setActiveId(f.id)}>
                <div className="finding-row-top"><SeverityBadge severity={f.severity} compact /><span className="finding-title">{f.title}</span></div>
                <div className="finding-meta"><span className={`cat cat-${f.category}`}>{f.category}</span><span className="mono small">{f.file}:{f.range.start}</span></div>
              </button>
            ))}
          </div>
          <div className="detail-pane">
            {active && <Scenario finding={active} report={report} onOpen={onOpen} onDiscuss={onDiscuss} />}
          </div>
        </div>
      )}

      <section className="card">
        <div className="card-head"><h2>Failure scenarios</h2><span className="muted small">derived from findings, not generated prose</span></div>
        {reliability.length === 0 ? <p className="muted">No failure scenario was identified.</p> : (
          <div className="scenario-grid">
            {reliability.slice(0, 6).map((f) => (
              <div className="scenario-card" key={f.id}>
                <div className="scenario-head"><SeverityBadge severity={f.severity} compact /><span>{f.category}</span></div>
                <div className="scenario-title">{f.title}</div>
                <ul className="tight">{f.consequences.slice(0, 3).map((c, i) => <li key={i}>{c}</li>)}</ul>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head"><h2>Data handling posture</h2></div>
        <div className="meta-row">
          <span><strong>AI enabled</strong> {report.settings.aiEnabled ? 'yes' : 'no'}</span>
          <span><strong>Repository content sent</strong> {report.settings.sendRepositoryContent ? 'yes (with consent)' : 'diff only'}</span>
          <span><strong>Secrets redacted</strong> {report.ai?.redactions ?? 0}</span>
          <span><strong>Provider</strong> {report.provider.providerId}{report.provider.model ? ` · ${report.provider.model}` : ''}</span>
        </div>
        <p className="muted small">DiffWise runs deterministic analysis locally. Only the change diff is sent by default; full related files are sent only when "send repository content" is enabled. Every payload is screened for credential patterns first.</p>
      </section>
    </div>
  );
}

function Scenario({ finding, report, onOpen, onDiscuss }: { finding: Finding; report: ReviewReport; onOpen: (f: string, l?: number) => void; onDiscuss: (id: string) => void }) {
  const relatedTests = report.tests.files.filter((t) => t.targets.includes(finding.file));
  return (
    <div className="card">
      <div className="finding-head"><SeverityBadge severity={finding.severity} /><h2>{finding.title}</h2></div>
      <div className="finding-sub">
        <span className={`cat cat-${finding.category}`}>{finding.category}</span>
        <span className={`kind kind-${finding.kind}`}>{finding.kind}</span>
        <span className="muted small">confidence {finding.confidence}</span>
      </div>
      <div className="finding-location"><FileRef file={finding.file} line={finding.range.start} onOpen={onOpen} /></div>
      <p className="lede">{finding.description}</p>
      <h4 className="subhead">Consequence</h4>
      <p>{finding.whyItMatters}</p>
      {finding.consequences.length > 0 && <ul className="tight">{finding.consequences.map((c, i) => <li key={i}>{c}</li>)}</ul>}
      {finding.reproduction && <><h4 className="subhead">Reproduction</h4><p className="mono small">{finding.reproduction}</p></>}
      <h4 className="subhead">Mitigation</h4>
      <p>{finding.recommendation}</p>
      <h4 className="subhead">Evidence</h4>
      <EvidenceList finding={finding} onOpen={onOpen} />
      <div className="meta-row">
        <span><strong>Tests covering this file</strong> {relatedTests.length ? relatedTests.map((t) => t.path).join(', ') : 'none'}</span>
      </div>
      <div className="finding-actions"><button className="btn ghost" onClick={() => onDiscuss(finding.id)}>Discuss this finding</button></div>
    </div>
  );
}
