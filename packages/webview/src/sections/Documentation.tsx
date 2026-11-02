import { useState } from 'react';
import type { ReviewReport } from '@diffwise/core';
import { Chip, DiffView, EmptyState, EvidenceList, Field, FileRef, SectionHeader, Tabs } from '../ui';

export function Documentation({ report, onOpen }: { report: ReviewReport; onOpen: (file: string, line?: number) => void }) {
  const findings = report.documentation.findings;
  const [activeId, setActiveId] = useState(findings[0]?.id);
  const [filter, setFilter] = useState<'all' | 'outdated' | 'conflict' | 'missing' | 'review'>('all');
  const filtered = findings.filter((f) => filter === 'all' || f.status === filter);
  const active = findings.find((f) => f.id === activeId) ?? filtered[0];
  const counts = {
    outdated: findings.filter((f) => f.status === 'outdated').length,
    conflict: findings.filter((f) => f.status === 'conflict').length,
    missing: findings.filter((f) => f.status === 'missing').length,
    review: findings.filter((f) => f.status === 'review').length,
  };

  return (
    <div className="stack">
      <SectionHeader
        eyebrow="Documentation intelligence"
        title="Documents that no longer describe the code"
        description="Documentation is treated as an analysis target. Every finding resolves a documented reference (symbol, path, command, route) against the repository after the change."
        actions={<div className="counts">
          <span className="count count-high">{counts.conflict}<em>conflict</em></span>
          <span className="count count-medium">{counts.outdated}<em>outdated</em></span>
          <span className="count count-low">{counts.missing}<em>missing</em></span>
          <span className="count count-info">{counts.review}<em>review</em></span>
        </div>}
      />

      {(report.documentation.index || report.documentation.retrieval) && (
        <section className="card">
          <div className="card-head">
            <h2>Indexed documentation</h2>
            {report.documentation.index && <Chip tone="neutral">{report.documentation.index.documents} document(s) · {report.documentation.index.sections} section(s)</Chip>}
          </div>
          {report.documentation.index && (
            <div className="stats-strip">
              <Field label="Documents" value={report.documentation.index.documents} />
              <Field label="Sections" value={report.documentation.index.sections} />
              <Field label="Sources" value={report.documentation.index.sources} />
              <Field label="Duplicates" value={report.documentation.index.duplicates} />
            </div>
          )}
          {report.documentation.retrieval && (
            <>
              <p className="muted small">Retrieved {report.documentation.retrieval.sections.length} of {report.documentation.retrieval.consideredSections} matching section(s) for this change, within {report.documentation.retrieval.query.files.length} changed file(s).</p>
              {report.documentation.retrieval.sections.map((section) => (
                <div className="impact-item" key={`${section.document}:${section.startLine}`}>
                  <div className="impact-head">
                    <Chip tone="neutral">{section.category}</Chip>
                    <strong>{section.heading}</strong>
                    <FileRef file={section.document} line={section.startLine} onOpen={onOpen} inline />
                  </div>
                  <div className="muted small">{section.why}{section.truncated ? ' · excerpt truncated' : ''}</div>
                </div>
              ))}
            </>
          )}
        </section>
      )}

      {findings.length === 0 ? (
        <EmptyState title="Documentation is consistent with this change" body="Every analysed reference still resolves and no public surface was added without documentation. Absence of findings means the checks passed, not that documentation was skipped." />
      ) : (
        <div className="split">
          <div className="list-pane">
            <div className="mini-filter">
              {(['all', 'conflict', 'outdated', 'missing', 'review'] as const).map((f) => (
                <button key={f} className={`chip-btn ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>{f}</button>
              ))}
            </div>
            {filtered.map((f) => (
              <button key={f.id} className={`list-item ${f.id === active?.id ? 'list-item-active' : ''}`} onClick={() => setActiveId(f.id)}>
                <div className="list-item-title"><span className={`doc-status doc-${f.status}`}>{f.status}</span> {f.title}</div>
                <div className="list-item-sub">{f.document}</div>
                <div className="list-item-meta"><span className="muted small">confidence {f.confidence}</span><span className="muted small">severity {f.severity}</span></div>
              </button>
            ))}
          </div>
          <div className="detail-pane">
            {active && (
              <div className="stack">
                <div className="card">
                  <div className="card-head"><h2>{active.title}</h2><Chip tone={active.status === 'conflict' ? 'bad' : active.status === 'outdated' ? 'warn' : 'neutral'}>{active.status}</Chip></div>
                  <p className="lede">{active.description}</p>
                  <Field label="Why this was flagged" value={active.reason} />
                  <div className="two-col">
                    <div>
                      <h4 className="subhead">Code evidence</h4>
                      {active.codeEvidence.length === 0 ? <p className="muted small">No code evidence attached.</p> : (
                        <div className="evidence">
                          {active.codeEvidence.map((e, i) => (
                            <div className="evidence-item" key={i}>
                              <div className="evidence-head">{e.file ? <FileRef file={e.file} line={e.line} onOpen={onOpen} inline /> : <span className="muted">repository</span>}<span className="evidence-source">{e.source}</span></div>
                              {e.snippet && <pre className="evidence-snippet">{e.snippet}</pre>}
                              <div className="evidence-note">{e.note}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div>
                      <h4 className="subhead">Document evidence</h4>
                      <div className="evidence">
                        {active.docEvidence.map((e, i) => (
                          <div className="evidence-item" key={i}>
                            <div className="evidence-head"><FileRef file={e.file ?? active.document} line={e.line} onOpen={onOpen} inline /><span className="evidence-source">{e.source}</span></div>
                            {e.snippet && <pre className="evidence-snippet">{e.snippet}</pre>}
                            <div className="evidence-note">{e.note}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                  <h4 className="subhead">Suggested update</h4>
                  <p>{active.suggestedUpdate}</p>
                  {active.patch && (
                    <>
                      <div className="card-head"><h4 className="subhead">Documentation patch preview</h4><Chip tone={active.patch.applies ? 'good' : 'bad'}>{active.patch.applies ? 'applies' : 'does not apply'}</Chip></div>
                      <DiffView diff={active.patch.diff} />
                      <p className="muted small">This is a preview generated from the document text; DiffWise has not written it. Apply documentation edits yourself or through your editor.</p>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <section className="card">
        <div className="card-head"><h2>Analysed documents</h2><span className="muted">{report.documentation.files.length}</span></div>
        <table className="table">
          <thead><tr><th>Document</th><th>Kind</th><th>References</th><th>Last reviewed</th></tr></thead>
          <tbody>
            {report.documentation.files.map((d) => (
              <tr key={d.path}>
                <td><FileRef file={d.path} onOpen={onOpen} inline /></td>
                <td>{d.kind}</td>
                <td>{d.references.length}</td>
                <td>{d.lastReviewed ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
