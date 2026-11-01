import { useMemo, useState } from 'react';
import type { EvidenceClass, Finding, ReviewReport, VerificationStatus } from '@diffwise/core';
import { Chip, ConfidenceMark, EmptyState, EvidenceList, FileRef, SectionHeader, SeverityBadge, Stat } from '../ui';

/**
 * Verification section.
 *
 * The point of this view is to make it impossible to read a finding as proof
 * without seeing what supported it. Each finding shows its verdict, the evidence
 * classes that backed it, every check with its outcome, and what each verifier
 * said — including the opinions that were discarded.
 */

const STATUS_ORDER: VerificationStatus[] = ['CONFIRMED', 'LIKELY', 'DISPUTED', 'UNVERIFIED', 'REJECTED'];

const STATUS_TONE: Record<VerificationStatus, 'good' | 'accent' | 'warn' | 'bad' | 'neutral'> = {
  CONFIRMED: 'good',
  LIKELY: 'accent',
  DISPUTED: 'warn',
  UNVERIFIED: 'neutral',
  REJECTED: 'bad',
};

const CLASS_LABEL: Record<EvidenceClass, string> = {
  static: 'Static',
  model: 'Model',
  test: 'Test',
  runtime: 'Runtime',
  human: 'Human',
};

function VerificationBadge({ status }: { status: VerificationStatus }) {
  return <Chip tone={STATUS_TONE[status]}>{status}</Chip>;
}

function FindingRow({ finding, onOpen }: { finding: Finding; onOpen?: (file: string, line?: number) => void }) {
  const [open, setOpen] = useState(false);
  const v = finding.verification;
  const classes = v?.evidenceClasses ?? { static: 0, model: 0, test: 0, runtime: 0, human: 0 };

  return (
    <div className={`verify-row${open ? ' verify-open' : ''}`}>
      <button className="verify-head" onClick={() => setOpen((x) => !x)}>
        <SeverityBadge severity={finding.severity} compact />
        <span className="verify-title">{finding.title}</span>
        {v ? <VerificationBadge status={v.status} /> : <Chip tone="neutral">unverified</Chip>}
        <span className="verify-loc"><FileRef file={finding.file} line={finding.range.start} onOpen={onOpen} inline /></span>
      </button>

      {open && (
        <div className="verify-body">
          <p className="muted">{finding.description}</p>

          {v ? (
            <>
              <div className="dw-fields">
                <div className="dw-field"><span className="dw-field-label">Method</span><span>{v.method}</span></div>
                <div className="dw-field"><span className="dw-field-label">Confidence</span><ConfidenceMark confidence={v.confidence} /></div>
                <div className="dw-field">
                  <span className="dw-field-label">Evidence classes</span>
                  <span className="dw-chips">
                    {(Object.keys(classes) as EvidenceClass[]).map((cls) => (
                      <Chip key={cls} tone={classes[cls] > 0 ? 'accent' : 'neutral'} title={`${classes[cls]} item(s)`}>
                        {CLASS_LABEL[cls]} {classes[cls]}
                      </Chip>
                    ))}
                  </span>
                </div>
                {v.severity.effective !== v.severity.original && (
                  <div className="dw-field">
                    <span className="dw-field-label">Severity</span>
                    <span>{v.severity.original} → {v.severity.effective} · {v.severity.reason}</span>
                  </div>
                )}
                <div className="dw-field"><span className="dw-field-label">Reproducible by a test</span><span>{v.reproducible ? 'yes' : 'no'}</span></div>
              </div>

              <h4 className="dw-subhead-sm">Checks</h4>
              <table className="dw-table dw-table-compact">
                <thead><tr><th>Check</th><th>Kind</th><th>Outcome</th><th>Detail</th></tr></thead>
                <tbody>
                  {v.checks.map((check) => (
                    <tr key={check.id}>
                      <td><code>{check.id}</code></td>
                      <td>{check.kind}</td>
                      <td>
                        <Chip tone={check.outcome === 'supports' ? 'good' : check.outcome === 'contradicts' ? 'bad' : 'neutral'}>
                          {check.outcome}
                        </Chip>
                      </td>
                      <td className="muted">{check.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {v.verifiers.length > 0 && (
                <>
                  <h4 className="dw-subhead-sm">Independent verifiers</h4>
                  <ul className="dw-verifier-list">
                    {v.verifiers.map((opinion) => (
                      <li key={opinion.verifierId} className={opinion.discarded ? 'discarded' : ''}>
                        <div>
                          <strong>{opinion.verifierId}</strong> <Chip tone={opinion.verdict === 'rejected' ? 'bad' : opinion.verdict === 'confirmed' ? 'good' : 'neutral'}>{opinion.verdict}</Chip>
                          {opinion.model ? <span className="muted"> · {opinion.model}</span> : null}
                          {opinion.discarded ? <span className="problem-text"> · discarded: {opinion.discarded}</span> : null}
                        </div>
                        <p className="muted">{opinion.reasoning}</p>
                      </li>
                    ))}
                  </ul>
                  <p className="muted">Agreement between verifiers is recorded, not counted as proof. A finding is only CONFIRMED when static, test, runtime or human evidence supports it.</p>
                </>
              )}

              {v.notes.length > 0 && (
                <ul className="dw-notes">
                  {v.notes.map((note, i) => <li key={i} className="muted">{note}</li>)}
                </ul>
              )}
            </>
          ) : (
            <p className="muted">This finding has no verification record (it was produced by a schema v2 review).</p>
          )}

          <h4 className="dw-subhead-sm">Evidence</h4>
          <EvidenceList finding={finding} onOpen={onOpen} />
        </div>
      )}
    </div>
  );
}

export function Verification({ report, onOpen }: { report: ReviewReport; onOpen?: (file: string, line?: number) => void }) {
  const [status, setStatus] = useState<'all' | VerificationStatus>('all');
  const [query, setQuery] = useState('');

  const findings = report.findings;
  const counts = useMemo(() => {
    const out: Record<string, number> = { all: findings.length };
    for (const status of STATUS_ORDER) out[status] = 0;
    for (const finding of findings) {
      const s = finding.verification?.status ?? 'UNVERIFIED';
      out[s] = (out[s] ?? 0) + 1;
    }
    return out;
  }, [findings]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    return findings
      .filter((f) => status === 'all' || (f.verification?.status ?? 'UNVERIFIED') === status)
      .filter((f) => !q || `${f.title} ${f.file}`.toLowerCase().includes(q))
      .sort((a, b) => STATUS_ORDER.indexOf(a.verification?.status ?? 'UNVERIFIED') - STATUS_ORDER.indexOf(b.verification?.status ?? 'UNVERIFIED'));
  }, [findings, status, query]);

  const summary = report.review?.verification;
  const withheld = report.withheldFindings ?? [];

  return (
    <div className="section">
      <SectionHeader
        eyebrow="Verification"
        title="What was actually demonstrated"
        description="A finding is a claim. This view shows which claims a deterministic check, a test run, a human or the repository itself actually supports."
        actions={
          <input
            className="dw-search"
            placeholder="Filter findings…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        }
      />

      <div className="stats">
        <Stat label="Confirmed" value={summary?.confirmed ?? counts.CONFIRMED ?? 0} tone="good" hint="non-model evidence" />
        <Stat label="Likely" value={summary?.likely ?? counts.LIKELY ?? 0} hint="supported, not demonstrated" />
        <Stat label="Disputed" value={summary?.disputed ?? counts.DISPUTED ?? 0} tone="warn" hint="verifiers disagree" />
        <Stat label="Unverified" value={summary?.unverified ?? counts.UNVERIFIED ?? 0} hint="nothing checked" />
        <Stat label="Rejected" value={summary?.rejected ?? counts.REJECTED ?? 0} tone="bad" hint="evidence failed" />
        <Stat label="Corroborated" value={summary?.corroborated ?? 0} hint="rule + reviewer agreed" />
      </div>

      <div className="dw-tabs">
        <button className={status === 'all' ? 'dw-tab dw-tab-active' : 'dw-tab'} onClick={() => setStatus('all')}>All {counts.all}</button>
        {STATUS_ORDER.map((s) => (
          <button key={s} className={status === s ? 'dw-tab dw-tab-active' : 'dw-tab'} onClick={() => setStatus(s)}>
            {s} {counts[s] ?? 0}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="No findings in this view" body="Change the filter, or run a review to populate this section." />
      ) : (
        <div className="verify-list">
          {filtered.map((finding) => <FindingRow key={finding.id} finding={finding} onOpen={onOpen} />)}
        </div>
      )}

      {withheld.length > 0 && (
        <>
          <h3 className="dw-subhead">Withheld findings</h3>
          <p className="muted">
            {withheld.length} finding(s) fell below the published verification floor and are excluded from the list above.
            They are kept here rather than deleted, so the decision stays auditable.
          </p>
          <ul className="dw-notes">
            {withheld.map((f) => (
              <li key={f.id}>
                <SeverityBadge severity={f.severity} compact /> {f.title} <span className="muted">({f.verification?.status ?? 'UNVERIFIED'})</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
