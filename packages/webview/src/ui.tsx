import type { ReactNode } from 'react';
import type { Confidence, Finding, Severity } from '@diffwise/core';

export function short(text: string, max = 240): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function SeverityBadge({ severity, compact = false }: { severity: Severity; compact?: boolean }) {
  return (
    <span className={cx('sev', `sev-${severity}`, compact && 'sev-compact')} title={`Severity: ${severity}`}>
      <span className="sev-dot" aria-hidden="true" />
      {compact ? severity.slice(0, 4) : severity}
    </span>
  );
}

export function ConfidenceMark({ confidence }: { confidence: Confidence }) {
  const label: Record<Confidence, string> = {
    verified: 'Verified', high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence',
  };
  return <span className={cx('conf', `conf-${confidence}`)} title={label[confidence]}>{label[confidence]}</span>;
}

export function Chip({ children, tone = 'neutral', title }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'good' | 'warn' | 'bad'; title?: string }) {
  return <span className={cx('chip', `chip-${tone}`)} title={title}>{children}</span>;
}

export function SectionHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="section-head">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p className="section-desc">{description}</p>}
      </div>
      {actions && <div className="section-actions">{actions}</div>}
    </header>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className={cx('stat', tone && `stat-${tone}`)}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function EmptyState({ title, body, action, icon = '◇' }: { title: string; body: string; action?: ReactNode; icon?: string }) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden="true">{icon}</div>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}

export function Banner({ level, title, children, action }: { level: 'info' | 'warn' | 'error' | 'success'; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={cx('banner', `banner-${level}`)} role={level === 'error' ? 'alert' : 'status'}>
      <div className="banner-title">{title}</div>
      {children && <div className="banner-body">{children}</div>}
      {action && <div className="banner-action">{action}</div>}
    </div>
  );
}

export function RiskMeter({ score, level }: { score: number; level: string }) {
  return (
    <div className={cx('risk-meter', `risk-${level}`)} title={`Risk score ${score}/100 (${level})`}>
      <div className="risk-track"><div className="risk-fill" style={{ width: `${Math.max(2, Math.min(100, score))}%` }} /></div>
      <div className="risk-caption"><strong>{score}</strong><span>/100 · {level}</span></div>
    </div>
  );
}

export function Field({ label, value, mono = false, children }: { label: string; value?: ReactNode; mono?: boolean; children?: ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      <div className={cx('field-value', mono && 'mono')}>{children ?? value}</div>
    </div>
  );
}

export function FileRef({ file, line, onOpen, inline = false }: { file: string; line?: number; onOpen?: (file: string, line?: number) => void; inline?: boolean }) {
  return (
    <button type="button" className={cx('file-ref', inline && 'file-ref-inline')} onClick={() => onOpen?.(file, line)} title={`Open ${file}${line ? `:${line}` : ''}`}>
      <span className="file-icon" aria-hidden="true">›</span>
      <span className="file-path">{file}</span>
      {line !== undefined && <span className="file-line">:{line}</span>}
    </button>
  );
}

export function EvidenceList({ finding, onOpen }: { finding: Finding; onOpen?: (file: string, line?: number) => void }) {
  return (
    <div className="evidence">
      {finding.evidence.map((e, idx) => (
        <div className="evidence-item" key={`${e.file ?? 'ev'}-${idx}`}>
          <div className="evidence-head">
            {e.file ? <FileRef file={e.file} line={e.line} onOpen={onOpen} inline /> : <span className="muted">repository graph</span>}
            <span className={cx('evidence-source', `src-${e.source}`)}>{e.source}</span>
          </div>
          {e.snippet && <pre className="evidence-snippet">{e.snippet}</pre>}
          <div className="evidence-note">{e.note}</div>
        </div>
      ))}
    </div>
  );
}

export function DiffView({ diff }: { diff: string }) {
  const lines = diff.split(/\r?\n/);
  return (
    <pre className="diff" aria-label="Proposed patch">
      {lines.map((line, idx) => {
        const kind = line.startsWith('+++') || line.startsWith('---') ? 'meta'
          : line.startsWith('diff --git') || line.startsWith('@@') || line.startsWith('index ') ? 'hunk'
          : line.startsWith('+') ? 'add'
          : line.startsWith('-') ? 'del'
          : 'ctx';
        return <div key={idx} className={cx('diff-line', `diff-${kind}`)}>{line || ' '}</div>;
      })}
    </pre>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ id: T; label: string; count?: number }>; value: T; onChange: (id: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === value} className={cx('tab', t.id === value && 'tab-active')} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count !== undefined && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}
