import { useState } from 'react';
import type { AgentEvent, ReviewReport } from '@diffwise/core';
import { Chip, EmptyState, FileRef, SectionHeader, timeAgo } from '../ui';

const TYPE_LABEL: Record<AgentEvent['type'], string> = {
  task_intent: 'Intent', plan: 'Plan', decision: 'Decision', alternative: 'Rejected alternative',
  constraint: 'Constraint', activity: 'Activity', verification: 'Verification', unresolved_issue: 'Unresolved',
};

export function Agent({ report, onOpen, onCopy }: { report: ReviewReport; onOpen: (file: string, line?: number) => void; onCopy: (text: string) => void }) {
  const agent = report.agent;
  const [filter, setFilter] = useState<'all' | AgentEvent['type']>('all');
  const events = [...agent.events]
    .filter((e) => filter === 'all' || e.type === filter)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  const mcpConfig = JSON.stringify({
    mcpServers: {
      diffwise: {
        command: 'node',
        args: ['/absolute/path/to/DiffWise/packages/mcp/bin/diffwise-mcp.js'],
        env: { DIFFWISE_REPO_ROOT: report.repository.root },
      },
    },
  }, null, 2);

  return (
    <div className="stack">
      <SectionHeader
        eyebrow="Coding agent context"
        title="Why this change was made"
        description="Structured intent, decisions, rejected alternatives and verification evidence recorded by the coding agent through the DiffWise MCP server. This is explicit engineering context, never hidden model reasoning."
      />

      {agent.events.length === 0 ? (
        <EmptyState
          title="No agent context recorded"
          body="DiffWise can review the diff without it, but intent, decisions and rejected alternatives make the review far stronger. Connect the MCP server below and record them as you work."
          icon="⌁"
        />
      ) : (
        <>
          <div className="grid grid-3">
            <div className="mini-stat"><strong>{agent.intents.length}</strong><span>recorded intents</span></div>
            <div className="mini-stat"><strong>{agent.decisions.length}</strong><span>decisions</span></div>
            <div className="mini-stat"><strong>{agent.unresolved.length}</strong><span>unresolved issues</span></div>
          </div>

          <section className="card">
            <div className="card-head"><h2>Intent versus implementation</h2><span className="muted small">deterministic comparison of stated files with the actual diff</span></div>
            {agent.intentAlignment.length === 0 ? <p className="muted">No intent was recorded, so alignment cannot be assessed.</p> : (
              <div className="alignment-list">
                {agent.intentAlignment.map((a) => (
                  <div className={`alignment alignment-${a.verdict}`} key={a.intent.id}>
                    <div className="alignment-head">
                      <Chip tone={a.verdict === 'aligned' ? 'good' : a.verdict === 'divergent' ? 'bad' : 'warn'}>{a.verdict}</Chip>
                      <strong>{a.intent.title}</strong>
                      <span className="muted small">{timeAgo(a.intent.createdAt)}</span>
                    </div>
                    <p className="muted small">{a.note}</p>
                    <div className="two-col">
                      <div>
                        <h4 className="subhead">Files touched</h4>
                        <div className="tag-row">{a.touchedFiles.length ? a.touchedFiles.map((f) => <FileRef key={f} file={f} onOpen={onOpen} inline />) : <span className="muted small">none</span>}</div>
                        {a.unplannedFiles.length > 0 && <><h4 className="subhead warn-text">Not mentioned in the intent</h4><div className="tag-row">{a.unplannedFiles.map((f) => <FileRef key={f} file={f} onOpen={onOpen} inline />)}</div></>}
                      </div>
                      <div>
                        <h4 className="subhead">Planned but unchanged</h4>
                        <div className="tag-row">{a.plannedButUnchanged.length ? a.plannedButUnchanged.map((f) => <Chip key={f}>{f}</Chip>) : <span className="muted small">none</span>}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <div className="filter-bar">
            <div className="mini-filter">
              {(['all', 'task_intent', 'plan', 'decision', 'alternative', 'constraint', 'activity', 'verification', 'unresolved_issue'] as const).map((f) => (
                <button key={f} className={`chip-btn ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>{f === 'all' ? 'All' : TYPE_LABEL[f]}</button>
              ))}
            </div>
            <span className="muted small">{events.length} event(s)</span>
          </div>

          <section className="card">
            <div className="card-head"><h2>Development timeline</h2></div>
            <ol className="timeline">
              {events.map((e) => (
                <li className={`timeline-item tl-${e.type}`} key={e.id}>
                  <div className="timeline-marker" aria-hidden="true" />
                  <div className="timeline-body">
                    <div className="timeline-head">
                      <span className={`evt evt-${e.type}`}>{TYPE_LABEL[e.type]}</span>
                      <strong>{e.title}</strong>
                      <span className="muted small">{new Date(e.createdAt).toLocaleString()} · {timeAgo(e.createdAt)}</span>
                    </div>
                    <p>{e.detail}</p>
                    <div className="timeline-meta">
                      {e.actor && <span className="muted small">actor: {e.actor}</span>}
                      {e.status && <Chip tone={e.status === 'passed' ? 'good' : e.status === 'partial' ? 'warn' : 'neutral'}>{e.status}</Chip>}
                      {(e.files ?? []).map((f) => <FileRef key={f} file={f} onOpen={onOpen} inline />)}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </>
      )}

      <section className="card">
        <div className="card-head"><h2>Connect the MCP server</h2><span className="muted small">interface v1</span></div>
        <p className="muted small">Add this to your coding agent's MCP configuration. The server exposes record_task_intent, record_plan, record_decision, record_alternative, record_constraint, record_activity, record_verification, record_unresolved_issue, get_change_context, get_review_context, get_related_decisions and search_project_knowledge.</p>
        <pre className="output">{mcpConfig}</pre>
        <div className="modal-actions"><button className="btn" onClick={() => onCopy(mcpConfig)}>Copy configuration</button></div>
      </section>
    </div>
  );
}
