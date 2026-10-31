import { useEffect, useMemo, useState } from 'react';
import type { AppliedFix, Finding, FindingCategory, FixSolution, ReviewReport, Severity, TestExecution } from '@diffwise/core';
import { Banner, Chip, ConfidenceMark, DiffView, EmptyState, EvidenceList, Field, FileRef, SectionHeader, SeverityBadge, Tabs, timeAgo } from '../ui';

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export function Review({ report, activeId, onSelect, onOpen, onDiscuss, fixesByFinding, fixLoading, onGenerateFix, onApplyFix, onRevertFix, appliedFixes, verification, onVerify }: {
  report: ReviewReport;
  activeId?: string;
  onSelect: (id: string) => void;
  onOpen: (file: string, line?: number) => void;
  onDiscuss: (findingId: string) => void;
  fixesByFinding: Record<string, FixSolution[]>;
  fixLoading: string | null;
  onGenerateFix: (findingId: string) => void;
  onApplyFix: (findingId: string, solutionId: string) => void;
  onRevertFix: (appliedFixId: string) => void;
  appliedFixes: AppliedFix[];
  verification?: TestExecution;
  onVerify: () => void;
}) {
  const [severities, setSeverities] = useState<Set<Severity>>(new Set(SEVERITIES));
  const [category, setCategory] = useState<'all' | FindingCategory>('all');
  const [source, setSource] = useState<'all' | 'deterministic' | 'ai'>('all');
  const [query, setQuery] = useState('');

  const findings = useMemo(() => {
    const q = query.toLowerCase().trim();
    return report.findings.filter((f) => {
      if (!severities.has(f.severity)) return false;
      if (category !== 'all' && f.category !== category) return false;
      if (source !== 'all' && f.source !== source) return false;
      if (q && !`${f.title} ${f.description} ${f.file} ${f.tags.join(' ')}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [report.findings, severities, category, source, query]);

  const active = report.findings.find((f) => f.id === activeId) ?? findings[0];

  return (
    <div className="stack">
      <SectionHeader
        eyebrow="Intelligent code review"
        title="Findings, with evidence"
        description="Each finding cites the exact repository text that supports it. Deterministic findings are verified; model findings passed the same evidence check before being accepted."
        actions={<div className="counts">
          {SEVERITIES.map((s) => <span key={s} className={`count count-${s}`}>{report.summary.findingsBySeverity[s] ?? 0}<em>{s}</em></span>)}
        </div>}
      />

      <div className="filter-bar">
        <div className="segmented">
          {SEVERITIES.map((s) => (
            <button key={s} className={`seg seg-${s} ${severities.has(s) ? 'on' : 'off'}`} onClick={() => {
              setSeverities((prev) => { const next = new Set(prev); if (next.has(s)) next.delete(s); else next.add(s); return next; });
            }}>{s}</button>
          ))}
        </div>
        <select value={category} onChange={(e) => setCategory(e.target.value as typeof category)} aria-label="Filter by category">
          <option value="all">All categories</option>
          {Object.keys(report.summary.findingsByCategory).map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value as typeof source)} aria-label="Filter by source">
          <option value="all">All sources</option>
          <option value="deterministic">Deterministic</option>
          <option value="ai">AI</option>
        </select>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search findings…" aria-label="Search findings" />
        <span className="muted small">{findings.length} shown</span>
      </div>

      {findings.length === 0 ? (
        <EmptyState title="No findings match these filters" body="Clear the filters to see the full set. An empty code review is a valid result when the change is small and well covered." />
      ) : (
        <div className="split review-split">
          <div className="list-pane">
            {findings.map((f) => (
              <button key={f.id} className={`finding-row ${f.id === active?.id ? 'finding-row-active' : ''}`} onClick={() => onSelect(f.id)}>
                <div className="finding-row-top">
                  <SeverityBadge severity={f.severity} compact />
                  <span className="finding-title">{f.title}</span>
                </div>
                <div className="finding-meta">
                  <span className={`cat cat-${f.category}`}>{f.category}</span>
                  <span className="mono small">{f.file}:{f.range.start}</span>
                  {f.source === 'ai' && <Chip tone="accent">AI</Chip>}
                  <ConfidenceMark confidence={f.confidence} />
                </div>
              </button>
            ))}
          </div>
          <div className="detail-pane">
            {active && (
              <FindingDetail
                finding={active}
                report={report}
                onOpen={onOpen}
                onDiscuss={onDiscuss}
                fixes={fixesByFinding[active.id] ?? report.fixes.filter((f) => f.findingId === active.id)}
                fixLoading={fixLoading === active.id}
                onGenerateFix={() => onGenerateFix(active.id)}
                onApplyFix={onApplyFix}
                onRevertFix={onRevertFix}
                appliedFixes={appliedFixes.filter((a) => a.findingId === active.id)}
                verification={verification}
                onVerify={onVerify}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FindingDetail({ finding, report, onOpen, onDiscuss, fixes, fixLoading, onGenerateFix, onApplyFix, onRevertFix, appliedFixes, verification, onVerify }: {
  finding: Finding;
  report: ReviewReport;
  onOpen: (file: string, line?: number) => void;
  onDiscuss: (id: string) => void;
  fixes: FixSolution[];
  fixLoading: boolean;
  onGenerateFix: () => void;
  onApplyFix: (findingId: string, solutionId: string) => void;
  onRevertFix: (appliedFixId: string) => void;
  appliedFixes: AppliedFix[];
  verification?: TestExecution;
  onVerify: () => void;
}) {
  const [tab, setTab] = useState<'finding' | 'fixes' | 'related'>('finding');
  const related = report.findings.filter((f) => f.id !== finding.id && (f.file === finding.file || f.category === finding.category)).slice(0, 5);
  const docImpacts = report.documentation.findings.filter((d) => (d.codeEvidence ?? []).some((e) => e.file === finding.file));

  return (
    <div className="stack">
      <div className="card finding-card">
        <div className="finding-head">
          <SeverityBadge severity={finding.severity} />
          <h2>{finding.title}</h2>
        </div>
        <div className="finding-sub">
          <span className={`cat cat-${finding.category}`}>{finding.category}</span>
          <span className={`kind kind-${finding.kind}`}>{finding.kind}</span>
          <ConfidenceMark confidence={finding.confidence} />
          <span className="muted small">rule {finding.ruleId} · {finding.source === 'ai' ? 'model, evidence-validated' : 'deterministic'}</span>
        </div>
        <div className="finding-location"><FileRef file={finding.file} line={finding.range.start} onOpen={onOpen} /> <span className="muted">{finding.range.start === finding.range.end ? `line ${finding.range.start}` : `lines ${finding.range.start}–${finding.range.end}`}</span></div>

        <Tabs value={tab} onChange={setTab} tabs={[
          { id: 'finding', label: 'Finding' },
          { id: 'fixes', label: 'Fix options', count: fixes.length },
          { id: 'related', label: 'Related impact', count: related.length + docImpacts.length },
        ]} />

        {tab === 'finding' && (
          <div className="stack">
            <p className="lede">{finding.description}</p>
            <div className="two-col">
              <div>
                <h4 className="subhead">Why it matters</h4>
                <p>{finding.whyItMatters}</p>
                {finding.consequences.length > 0 && <>
                  <h4 className="subhead">Consequences</h4>
                  <ul className="tight">{finding.consequences.map((c, i) => <li key={i}>{c}</li>)}</ul>
                </>}
              </div>
              <div>
                <h4 className="subhead">Recommended action</h4>
                <p>{finding.recommendation}</p>
                {finding.reproduction && <>
                  <h4 className="subhead">Reproduction</h4>
                  <p className="mono small">{finding.reproduction}</p>
                </>}
              </div>
            </div>
            <h4 className="subhead">Evidence</h4>
            <EvidenceList finding={finding} onOpen={onOpen} />
            {finding.tags.length > 0 && <div className="tag-row">{finding.tags.map((t) => <Chip key={t}>{t}</Chip>)}</div>}
            <div className="finding-actions">
              <button className="btn" onClick={() => setTab('fixes')}>Compare fixes</button>
              <button className="btn ghost" onClick={() => onDiscuss(finding.id)}>Discuss this finding</button>
              <button className="btn ghost" onClick={() => onOpen(finding.file, finding.range.start)}>Open source</button>
            </div>
          </div>
        )}

        {tab === 'fixes' && (
          <FixPanel
            finding={finding}
            fixes={fixes}
            loading={fixLoading}
            onGenerate={onGenerateFix}
            onApply={onApplyFix}
            onRevert={onRevertFix}
            appliedFixes={appliedFixes}
            verification={verification}
            onVerify={onVerify}
            onOpen={onOpen}
          />
        )}

        {tab === 'related' && (
          <div className="stack">
            <h4 className="subhead">Other findings in this file or category</h4>
            {related.length === 0 ? <p className="muted">No related finding.</p> : related.map((f) => (
              <div className="related-row" key={f.id}>
                <SeverityBadge severity={f.severity} compact />
                <span>{f.title}</span>
                <span className="muted small mono">{f.file}:{f.range.start}</span>
              </div>
            ))}
            <h4 className="subhead">Documentation impact</h4>
            {docImpacts.length === 0 ? <p className="muted">No documentation finding references this file.</p> : docImpacts.map((d) => (
              <div className="related-row" key={d.id}><Chip tone="warn">{d.status}</Chip><span>{d.title}</span><span className="muted small">{d.document}</span></div>
            ))}
            <h4 className="subhead">Tests covering this file</h4>
            {report.tests.files.filter((t) => t.targets.includes(finding.file)).length === 0
              ? <p className="muted">No test resolves to {finding.file}.</p>
              : report.tests.files.filter((t) => t.targets.includes(finding.file)).map((t) => (
                <div className="related-row" key={t.path}><Chip tone="good">{t.framework}</Chip><span>{t.path}</span><span className="muted small">{t.testCount} test(s)</span></div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function FixPanel({ finding, fixes, loading, onGenerate, onApply, onRevert, appliedFixes, verification, onVerify, onOpen }: {
  finding: Finding;
  fixes: FixSolution[];
  loading: boolean;
  onGenerate: () => void;
  onApply: (findingId: string, solutionId: string) => void;
  onRevert: (appliedFixId: string) => void;
  appliedFixes: AppliedFix[];
  verification?: TestExecution;
  onVerify: () => void;
  onOpen: (file: string, line?: number) => void;
}) {
  // Patched options come first: guidance without a diff is useful, but the
  // concrete, machine-validated change is what a reviewer wants to inspect.
  const ordered = [...fixes].sort((a, b) => Number(Boolean(b.patch)) - Number(Boolean(a.patch)));
  const [selectedId, setSelectedId] = useState<string | undefined>(ordered[0]?.id);
  const [approved, setApproved] = useState(false);
  // When new options arrive (for example an on-demand generation), move the
  // selection to a validated patch unless the reviewer already picked one.
  useEffect(() => {
    const current = fixes.find((f) => f.id === selectedId);
    if (current?.patch) return;
    const firstPatched = [...fixes].find((f) => f.patch);
    if (firstPatched) setSelectedId(firstPatched.id);
  }, [fixes, selectedId]);
  const [compare, setCompare] = useState(false);
  const selected = ordered.find((f) => f.id === selectedId) ?? ordered[0];
  const applied = appliedFixes.find((a) => a.solutionId === selected?.id) ?? appliedFixes[0];

  if (fixes.length === 0) {
    return (
      <div className="stack">
        <Banner level="info" title="No fix has been generated for this finding yet">
          Fix generation sends the finding and the surrounding code to the configured model, then validates every proposed patch against the working tree before showing it.
        </Banner>
        <div><button className="btn primary" onClick={onGenerate} disabled={loading}>{loading ? 'Generating options…' : 'Generate fix options'}</button></div>
        {appliedFixes.length > 0 && <AppliedFixCard applied={appliedFixes[0]!} onRevert={onRevert} verification={verification} onVerify={onVerify} />}
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="fix-toolbar">
        <span className="muted small">{fixes.length} alternative solution(s), each with a machine-validated patch.</span>
        <button className="link" onClick={() => setCompare((v) => !v)}>{compare ? 'Hide comparison' : 'Compare side by side'}</button>
        <button className="link" onClick={onGenerate} disabled={loading}>{loading ? 'Regenerating…' : 'Generate another'}</button>
      </div>

      {compare ? (
        <div className="compare-grid" style={{ gridTemplateColumns: `120px repeat(${ordered.length}, minmax(180px, 1fr))` }}>
          <div />
          {ordered.map((f) => <div className="compare-head" key={f.id}><strong>{cleanLabel(f.label)}</strong><button className="link" onClick={() => { setSelectedId(f.id); setCompare(false); }}>inspect →</button></div>)}
          {([
            ['Complexity', (f: FixSolution) => f.complexity],
            ['Approach', (f: FixSolution) => f.approach],
            ['Advantages', (f: FixSolution) => f.advantages.join('; ')],
            ['Disadvantages', (f: FixSolution) => f.disadvantages.join('; ')],
            ['Performance', (f: FixSolution) => f.performance],
            ['Side effects', (f: FixSolution) => f.sideEffects.join('; ') || '—'],
            ['Testing', (f: FixSolution) => f.testing.join('; ')],
            ['Compatibility', (f: FixSolution) => f.compatibility],
            ['Patch applies', (f: FixSolution) => f.patch?.validation.applies ? 'yes (validated)' : 'no'],
          ] as Array<[string, (f: FixSolution) => string]>).map(([label, get]) => (
            <div className="compare-row" key={label}>
              <div className="compare-label">{label}</div>
              {ordered.map((f) => <div className="compare-cell" key={f.id}>{get(f)}</div>)}
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="solution-tabs">
            {ordered.map((f, i) => (
              <button key={f.id} className={`solution-tab ${selected?.id === f.id ? 'active' : ''}`} onClick={() => { setSelectedId(f.id); setApproved(false); }}>
                <span className="solution-letter">{String.fromCharCode(65 + i)}</span>
                <span>{cleanLabel(f.label)}</span>
                <Chip tone={f.complexity === 'low' ? 'good' : f.complexity === 'high' ? 'bad' : 'warn'}>{f.complexity} complexity</Chip>
              </button>
            ))}
          </div>
          {selected && (
            <div className="stack">
              <div className="card inner">
                <h3>{selected.label}</h3>
                <p className="lede">{selected.description}</p>
                <div className="meta-row">
                  <span><strong>Approach</strong> {selected.approach}</span>
                  <span><strong>Source</strong> {selected.source}</span>
                  <span><strong>Files</strong> {selected.filesAffected.length}</span>
                </div>
                <div className="two-col">
                  <div>
                    <h4 className="subhead">Advantages</h4>
                    <ul className="tight good-list">{selected.advantages.map((a, i) => <li key={i}>{a}</li>)}</ul>
                    <h4 className="subhead">Performance</h4>
                    <p>{selected.performance}</p>
                  </div>
                  <div>
                    <h4 className="subhead">Disadvantages</h4>
                    <ul className="tight bad-list">{selected.disadvantages.map((d, i) => <li key={i}>{d}</li>)}</ul>
                    <h4 className="subhead">Side effects</h4>
                    <p>{selected.sideEffects.length ? selected.sideEffects.join('; ') : 'None identified.'}</p>
                  </div>
                </div>
                <Field label="Testing required" value={selected.testing.join('; ') || 'No specific test proposed.'} />
                <Field label="Compatibility" value={selected.compatibility} />
                <Field label="Files affected" value={<div className="file-list">{selected.filesAffected.map((f) => <FileRef key={f} file={f} onOpen={onOpen} inline />)}</div>} />
              </div>

              {selected.patch && (
                <div className="card inner">
                  <div className="card-head">
                    <h3>Patch preview</h3>
                    <Chip tone={selected.patch.validation.applies ? 'good' : 'bad'}>{selected.patch.validation.applies ? 'applies to working tree' : 'does not apply'}</Chip>
                  </div>
                  {selected.patch.validation.fuzz !== undefined && selected.patch.validation.fuzz > 0 && (
                    <Banner level="warn" title="Patch needed fuzz">{`Context matched with ${selected.patch.validation.fuzz} line(s) of offset. Read the diff before applying.`}</Banner>
                  )}
                  {selected.patch.destructive && (
                    <Banner level="error" title="Destructive change">
                      This patch touches deployment-sensitive files or deletes content. DiffWise will back up affected files, but you must review every line.
                    </Banner>
                  )}
                  <DiffView diff={selected.patch.diff} />
                </div>
              )}

              {applied ? (
                <AppliedFixCard applied={applied} onRevert={onRevert} verification={verification} onVerify={onVerify} />
              ) : (
                <div className="apply-box">
                  <label className="check">
                    <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} />
                    <span>I have reviewed this exact diff and approve applying it to the working tree.</span>
                  </label>
                  <div className="apply-actions">
                    <button className="btn primary" disabled={!approved || !selected.patch?.validation.applies} onClick={() => { onApply(finding.id, selected.id); setApproved(false); }}>
                      Apply patch
                    </button>
                    <span className="muted small">Files are backed up to <code>.diffwise/backups/</code> before writing. Nothing runs automatically.</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Proposal labels often start with "Option A —"; the UI already shows the letter. */
function cleanLabel(label: string): string {
  return label.replace(/^Option\s+[A-Z]\s*[—:-]\s*/i, '');
}

function AppliedFixCard({ applied, onRevert, verification, onVerify }: { applied: AppliedFix; onRevert: (id: string) => void; verification?: TestExecution; onVerify: () => void }) {
  const [approved, setApproved] = useState(false);
  return (
    <div className="card applied">
      <div className="card-head"><h3>Applied fix</h3><Chip tone="good">applied {timeAgo(applied.appliedAt)}</Chip></div>
      <Field label="Files written" value={applied.files.join(', ')} />
      <Field label="Backup" value={applied.backupDir} mono />
      <div className="divider" />
      <div className="card-head"><h4>Verification</h4>{!verification && (
        <div className="verify-approve">
          <label className="check"><input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} /><span>I approve running the configured command in this repository.</span></label>
          <button className="btn" onClick={onVerify} disabled={!approved}>Run verification command</button>
        </div>
      )}</div>
      {verification ? (
        <div className="stack">
          <div className="meta-row">
            <span><strong>Command</strong> <code>{verification.command || '(none configured)'}</code></span>
            <span><strong>Status</strong> <Chip tone={verification.status === 'passed' ? 'good' : verification.status === 'not-run' ? 'warn' : 'bad'}>{verification.status}</Chip></span>
            <span><strong>Exit</strong> {verification.exitCode ?? '—'}</span>
            <span><strong>Duration</strong> {(verification.durationMs / 1000).toFixed(1)}s</span>
          </div>
          {verification.status === 'not-run' && <Banner level="warn" title="Not verified">{verification.outputTail}</Banner>}
          {verification.status === 'passed' && <Banner level="success" title="Command exited 0">This is the actual result of the configured command. It does not prove the fix is correct beyond what that command covers.</Banner>}
          <pre className="output">{verification.outputTail || '(no output)'}</pre>
        </div>
      ) : (
        <p className="muted small">No verification has been run for this fix. DiffWise never claims a fix is verified without an execution result.</p>
      )}
      <div className="divider" />
      <button className="btn danger" onClick={() => onRevert(applied.id)}>Revert this fix</button>
    </div>
  );
}
