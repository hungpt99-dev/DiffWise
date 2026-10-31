import { useEffect, useRef, useState } from 'react';
import type { ChatTurn, ReviewReport } from '@diffwise/core';
import { Banner, Chip, EmptyState, FileRef, SectionHeader } from '../ui';

export type ChatScope = { type: 'report' } | { type: 'finding'; id: string };

const REPORT_QUESTIONS = [
  'Why is this change rated at this risk level?',
  'Which other services could be affected by this change?',
  'What could go wrong under concurrent execution?',
  'Is the documentation still accurate after this change?',
  'What tests should I add before merging?',
  'Which findings are hypotheses rather than confirmed problems?',
];

const FINDING_QUESTIONS = [
  'Explain this finding in the context of the payment flow.',
  'Is there a simpler fix than the proposed options?',
  'What happens if this operation is retried?',
  'Reassess this finding from a security perspective.',
  'Which test would prove this is fixed?',
];

export function Discussion({ report, messages, pending, scope, onScope, onAsk, onOpen, onSettings }: {
  report: ReviewReport;
  messages: ChatTurn[];
  pending: boolean;
  scope: ChatScope;
  onScope: (s: ChatScope) => void;
  onAsk: (q: string) => void;
  onOpen: (file: string, line?: number) => void;
  onSettings: () => void;
}) {
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const finding = scope.type === 'finding' ? report.findings.find((f) => f.id === scope.id) : undefined;
  const questions = finding ? FINDING_QUESTIONS : REPORT_QUESTIONS;

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages.length, pending]);

  const send = () => {
    const q = draft.trim();
    if (!q || pending) return;
    setDraft('');
    onAsk(q);
  };

  return (
    <div className="stack chat-page">
      <SectionHeader
        eyebrow="Report-aware discussion"
        title="Talk to this review"
        description="The assistant receives the current report, the selected finding, the diff and its evidence. Answers must cite repository lines; unverifiable citations are removed before display."
        actions={<select value={scope.type === 'report' ? 'report' : scope.id} onChange={(e) => onScope(e.target.value === 'report' ? { type: 'report' } : { type: 'finding', id: e.target.value })} aria-label="Discussion scope">
          <option value="report">Whole report</option>
          {report.findings.map((f) => <option key={f.id} value={f.id}>{f.severity} · {f.title.slice(0, 60)}</option>)}
        </select>}
      />

      {report.provider.state !== 'ok' && (
        <Banner level="warn" title="The AI provider is not ready" action={<button className="btn" onClick={onSettings}>Open settings</button>}>
          {report.provider.message ?? 'Configure a provider to use discussion. Deterministic findings remain fully available.'}
        </Banner>
      )}

      {finding && (
        <div className="scope-card">
          <Chip tone={finding.severity === 'critical' ? 'bad' : finding.severity === 'high' ? 'warn' : 'neutral'}>{finding.severity}</Chip>
          <strong>{finding.title}</strong>
          <FileRef file={finding.file} line={finding.range.start} onOpen={onOpen} inline />
          <button className="link" onClick={() => onScope({ type: 'report' })}>discuss whole report</button>
        </div>
      )}

      <div className="chat">
        <div className="chat-log">
          {messages.length === 0 && (
            <div className="chat-intro">
              <EmptyState
                icon="✦"
                title={finding ? 'Ask about this finding' : 'Ask about this review'}
                body={finding
                  ? 'The assistant can see the finding, its evidence, the affected code and every proposed fix. Ask it to challenge the finding, compare fixes, or explain the failure mode.'
                  : 'The assistant can see the diff, findings, architecture impact, documentation drift and recorded agent decisions. Ask it to connect them, or to challenge the analysis.'}
              />
              <div className="suggested-questions">
                {questions.map((q) => <button key={q} className="suggestion-chip" onClick={() => onAsk(q)}>{q}</button>)}
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} className={`msg msg-${m.role}`}>
              <div className="msg-role">{m.role === 'user' ? 'You' : 'DiffWise'}</div>
              <div className="msg-body">
                <div className="msg-text">{m.content}</div>
                {m.citations && m.citations.length > 0 && (
                  <div className="citations">
                    <div className="citations-label">Citations</div>
                    {m.citations.map((c, j) => (
                      <div className={`citation ${c.valid ? '' : 'citation-invalid'}`} key={j}>
                        <FileRef file={c.file} line={c.line} onOpen={onOpen} inline />
                        {c.note && <span className="citation-note">{c.note}</span>}
                      </div>
                    ))}
                  </div>
                )}
                {m.error && <Banner level="error" title="Answer failed">{m.error}</Banner>}
              </div>
            </div>
          ))}
          {pending && <div className="msg msg-assistant"><div className="msg-role">DiffWise</div><div className="msg-body"><div className="typing"><span /><span /><span /></div></div></div>}
          <div ref={endRef} />
        </div>

        <div className="chat-input">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder={finding ? `Ask about “${finding.title.slice(0, 60)}”…` : 'Ask about the report, a finding, or the change…'}
            rows={2}
            aria-label="Question"
          />
          <div className="chat-actions">
            <span className="muted small">Enter to send · Shift+Enter for a new line</span>
            <button className="btn primary" onClick={send} disabled={pending || !draft.trim()}>{pending ? 'Thinking…' : 'Send'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
