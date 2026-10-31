import { useState } from 'react';
import type { FileChange, ReviewReport } from '@diffwise/core';
import { Chip, DiffView, EmptyState, FileRef, SectionHeader, Tabs } from '../ui';

export function Changes({ report, onOpen }: { report: ReviewReport; onOpen: (file: string, line?: number) => void }) {
  const [tab, setTab] = useState<'groups' | 'files' | 'symbols'>('groups');
  const [selected, setSelected] = useState<string | null>(report.changeGroups[0]?.id ?? null);
  const [file, setFile] = useState<string | null>(report.changes[0]?.path ?? null);
  const group = report.changeGroups.find((g) => g.id === selected) ?? report.changeGroups[0];
  const currentFile = report.changes.find((c) => c.path === file) ?? report.changes[0];

  if (report.changes.length === 0) {
    return <EmptyState title="No changes in this review" body="The selected target produced an empty diff. Change the review target or commit some work." />;
  }

  return (
    <div className="stack">
      <SectionHeader eyebrow="Semantic change explorer" title="What changed, grouped by intent" description="DiffWise groups related modifications instead of treating each file as an independent edit. Purpose lines record the evidence they were derived from." />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'groups', label: 'Change groups', count: report.changeGroups.length },
          { id: 'files', label: 'Files', count: report.changes.length },
          { id: 'symbols', label: 'Symbols', count: report.symbols.length },
        ]}
      />

      {tab === 'groups' && (
        <div className="split">
          <div className="list-pane">
            {report.changeGroups.map((g) => (
              <button key={g.id} className={`list-item ${g.id === group?.id ? 'list-item-active' : ''}`} onClick={() => setSelected(g.id)}>
                <div className="list-item-title">{g.title}</div>
                <div className="list-item-sub">{g.purpose}</div>
                <div className="list-item-meta">
                  <Chip tone="neutral">{g.purposeBasis}</Chip>
                  <span className="add">+{g.additions}</span><span className="del">−{g.deletions}</span>
                  <span className="muted">{g.files.length} file(s)</span>
                </div>
              </button>
            ))}
          </div>
          <div className="detail-pane">
            {group && (
              <div className="stack">
                <div className="card">
                  <div className="card-head"><h2>{group.title}</h2><Chip tone="accent">{group.module}</Chip></div>
                  <p className="lede">{group.purpose}</p>
                  <div className="meta-row">
                    <span><strong>Basis</strong> {group.purposeBasis}</span>
                    <span><strong>Change types</strong> {group.changeTypes.join(', ')}</span>
                    <span><strong>Symbols</strong> {group.symbols.join(', ') || 'none resolved'}</span>
                  </div>
                  <h3 className="subhead">Files in this group</h3>
                  <div className="file-list">
                    {group.files.map((f) => (
                      <div className="file-row" key={f}>
                        <FileRef file={f} onOpen={onOpen} />
                        <button className="link" onClick={() => { setFile(f); setTab('files'); }}>view diff →</button>
                      </div>
                    ))}
                  </div>
                  {group.evidence.length > 0 && (
                    <>
                      <h3 className="subhead">Evidence</h3>
                      {group.evidence.map((e, i) => (
                        <div className="evidence-item" key={i}>
                          <div className="evidence-head"><FileRef file={e.file ?? ''} line={e.line} onOpen={onOpen} inline /><span className="evidence-note">{e.note}</span></div>
                          {e.snippet && <pre className="evidence-snippet">{e.snippet}</pre>}
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'files' && (
        <div className="split">
          <div className="list-pane">
            {report.changes.map((c) => (
              <button key={c.path} className={`list-item ${c.path === currentFile?.path ? 'list-item-active' : ''}`} onClick={() => setFile(c.path)}>
                <div className="list-item-title"><span className={`status status-${c.status}`}>{c.status}</span> {c.path}</div>
                <div className="list-item-meta"><span className="add">+{c.additions}</span><span className="del">−{c.deletions}</span><span className="muted">{c.language}</span></div>
              </button>
            ))}
          </div>
          <div className="detail-pane">
            {currentFile && <FileDetail change={currentFile} onOpen={onOpen} />}
          </div>
        </div>
      )}

      {tab === 'symbols' && (
        <div className="card">
          <table className="table">
            <thead><tr><th>Symbol</th><th>Kind</th><th>Change</th><th>File</th><th>References</th><th>Signature</th></tr></thead>
            <tbody>
              {report.symbols.map((s) => (
                <tr key={s.id}>
                  <td><strong>{s.container ? `${s.container}.` : ''}{s.name}</strong>{s.exported && <span className="exported" title="Exported">export</span>}</td>
                  <td>{s.kind}</td>
                  <td><span className={`sym-change sym-${s.change}`}>{s.change}</span>{s.signatureChanged && <span className="sig-changed" title="Signature changed">sig Δ</span>}</td>
                  <td><FileRef file={s.file} line={s.range.start} onOpen={onOpen} inline /></td>
                  <td>{s.referenceCount}</td>
                  <td className="mono small">{s.signature.slice(0, 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FileDetail({ change, onOpen }: { change: FileChange; onOpen: (file: string, line?: number) => void }) {
  return (
    <div className="card">
      <div className="card-head">
        <h2><FileRef file={change.path} onOpen={onOpen} /></h2>
        <Chip tone="neutral">{change.language}</Chip>
      </div>
      <div className="meta-row">
        <span><strong>Status</strong> {change.status}</span>
        <span><strong>Lines</strong> +{change.additions} −{change.deletions}</span>
        {change.oldPath && <span><strong>Renamed from</strong> {change.oldPath}</span>}
      </div>
      {change.binary ? <p className="muted">Binary file: contents are not analysed.</p> : <DiffView diff={change.patch} />}
    </div>
  );
}
