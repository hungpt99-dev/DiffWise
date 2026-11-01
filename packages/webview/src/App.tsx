import { useEffect, useMemo, useRef, useState } from 'react';
import type { AnalysisStage, ChatTurn, ReviewIndexEntry, ReviewReport, ReviewTarget } from '@diffwise/core';
import { SECTIONS, createBridge, type HostMessage, type SectionId, type UiSettings, type ViewState } from './protocol';
import { Banner, Chip, EmptyState, RiskMeter, cx, duration, timeAgo } from './ui';
import { Overview } from './sections/Overview';
import { Changes } from './sections/Changes';
import { Architecture } from './sections/Architecture';
import { Review } from './sections/Review';
import { Documentation } from './sections/Documentation';
import { Security } from './sections/Security';
import { Testing } from './sections/Testing';
import { Agent } from './sections/Agent';
import { Discussion, type ChatScope } from './sections/Discussion';
import { Settings } from './sections/Settings';

const DEFAULT_SETTINGS: UiSettings = {
  providerId: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKeyEnvVar: 'DIFFWISE_API_KEY',
  apiKeyPresent: false,
  maxTokens: 4000,
  temperature: 0.1,
  timeoutMs: 180000,
  aiEnabled: true,
  sendRepositoryContent: false,
  verificationCommand: '',
  maxFiles: 200,
  extraHeaders: {},
};

export function App() {
  const bridge = useMemo(() => createBridge(), []);
  const [state, setState] = useState<ViewState>({
    report: null, history: [], stages: [], running: false, settings: null,
    chatByScope: {}, pendingChat: {}, fixesByFinding: {}, fixLoading: null,
    appliedFixes: [], activeSection: 'overview', selectedFixByFinding: {}, compareMode: false,
  });
  const [scope, setScope] = useState<ChatScope>({ type: 'report' });
  const [providerTest, setProviderTest] = useState<{ ok: boolean; message: string; latencyMs: number; model: string } | undefined>();
  const [testingProvider, setTestingProvider] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [targetMenu, setTargetMenu] = useState(false);
  const [notice, setNotice] = useState<{ level: 'info' | 'warn' | 'error'; message: string } | undefined>();
  const pendingRequests = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    bridge.subscribe((message: HostMessage) => {
      setState((prev) => reduce(prev, message, setProviderTest, setTestingProvider, setNotice));
      if (message.type === 'report') setNotice(undefined);
    });
    bridge.post({ type: 'ready' });
  }, [bridge]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const report = state.report;
  const settings = state.settings ?? DEFAULT_SETTINGS;

  const run = (target: ReviewTarget) => {
    setTargetMenu(false);
    setState((prev) => ({ ...prev, running: true, error: undefined, stages: prev.stages.map((s) => ({ ...s, status: 'pending' as const })) }));
    bridge.post({ type: 'run', target });
  };

  const openFile = (file: string, line?: number, endLine?: number) => bridge.post({ type: 'openFile', file, line, endLine });

  const ask = (question: string, findingId?: string) => {
    const scopeKey = findingId ? `finding:${findingId}` : scope.type === 'finding' ? `finding:${scope.id}` : 'report';
    if (bridge.kind === 'standalone' || bridge.kind === 'static') {
      setNotice({ level: 'warn', message: bridge.kind === 'static'
        ? 'This standalone export is read-only. Run "diffwise report latest --serve" for report-aware chat.'
        : 'Discussion requires a host with a model provider (VS Code extension or "diffwise report --serve").' });
      return;
    }
    const history = state.chatByScope[scopeKey] ?? [];
    const turn: ChatTurn = { role: 'user', content: question, createdAt: new Date().toISOString() };
    const requestId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    pendingRequests.current.set(requestId, scopeKey);
    registerRequestScope(requestId, scopeKey);
    setState((prev) => ({
      ...prev,
      chatByScope: { ...prev.chatByScope, [scopeKey]: [...(prev.chatByScope[scopeKey] ?? []), turn] },
      pendingChat: { ...prev.pendingChat, [scopeKey]: true },
    }));
    bridge.post({ type: 'ask', requestId, question, ...(findingId ? { findingId } : scope.type === 'finding' ? { findingId: scope.id } : {}), history });
  };

  const generateFix = (findingId: string) => {
    setState((prev) => ({ ...prev, fixLoading: findingId }));
    bridge.post({ type: 'generateFix', findingId });
  };

  const applyFix = (findingId: string, solutionId: string) => bridge.post({ type: 'applyFix', findingId, solutionId, approved: true });
  const revertFix = (appliedFixId: string) => bridge.post({ type: 'revertFix', appliedFixId });
  const verify = () => bridge.post({ type: 'verify', approved: true });
  const saveSettings = (s: UiSettings) => bridge.post({ type: 'saveSettings', settings: s });
  const testProvider = (s: UiSettings) => {
    const requestId = `provider-${Date.now()}`;
    setTestingProvider(true);
    bridge.post({ type: 'testProvider', requestId, settings: s });
  };
  const copy = (text: string) => {
    if (bridge.kind === 'vscode') bridge.post({ type: 'copy', text });
    else navigator.clipboard?.writeText(text).then(() => setNotice({ level: 'info', message: 'Copied to clipboard.' })).catch(() => setNotice({ level: 'warn', message: 'Clipboard is unavailable in this context.' }));
  };

  const openSettingsFile = () => bridge.post({ type: 'openSettingsFile' });
  const findingCount = report?.findings.length ?? 0;
  const runningStage = state.stages.find((s) => s.status === 'running');

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Logo />
          <div className="brand-text">
            <span className="brand-name">DiffWise</span>
            <span className="brand-tag">engineering review workspace</span>
          </div>
        </div>

        <div className="topbar-context">
          {report ? (
            <>
              <span className="repo">{report.repository.name}</span>
              <Chip tone="neutral"><span className="mono">{report.repository.branch}</span></Chip>
              <Chip tone="neutral">{report.target.label}</Chip>
              <span className="muted small">{report.changes.length} files · {findingCount} findings</span>
            </>
          ) : <span className="muted">No review loaded</span>}
        </div>

        <div className="topbar-actions">
          {report && <div className="risk-pill" title={report.risk.summary}><span className="risk-label">Risk</span><RiskMeter score={report.risk.score} level={report.risk.level} /></div>}
          <div className="menu-wrap">
            <button className="btn primary" onClick={() => (report ? run(report.target) : run({ mode: 'working', label: 'Working tree' }))} disabled={state.running}>
              {state.running ? 'Analyzing…' : report ? 'Reanalyze' : 'Review changes'}
            </button>
            <button className="btn primary caret" aria-label="Choose review target" onClick={() => setTargetMenu((v) => !v)} disabled={state.running}>▾</button>
            {targetMenu && (
              <div className="menu" onMouseLeave={() => setTargetMenu(false)}>
                <button onClick={() => run({ mode: 'working', label: 'Working tree' })}>Working tree changes</button>
                <button onClick={() => run({ mode: 'staged', label: 'Staged changes' })}>Staged changes</button>
                <button onClick={() => run({ mode: 'commits', base: 'HEAD~1', head: 'HEAD', label: 'Last commit' })}>Last commit</button>
                <button onClick={() => run({ mode: 'branch', base: 'main', head: 'HEAD', label: 'Branch vs main' })}>Branch vs main</button>
              </div>
            )}
          </div>
          {state.running && <button className="btn danger" onClick={() => bridge.post({ type: 'cancel' })}>Cancel</button>}
          <div className="menu-wrap">
            <button className="btn ghost" onClick={() => setHistoryOpen((v) => !v)} title="Review history">History</button>
            {historyOpen && (
              <div className="menu wide" onMouseLeave={() => setHistoryOpen(false)}>
                {state.history.length === 0 ? <div className="menu-empty">No reviews recorded yet.</div> : state.history.map((h) => (
                  <button key={h.id} onClick={() => { setHistoryOpen(false); bridge.post({ type: 'openReview', id: h.id }); }}>
                    <span className="menu-row"><span>{h.targetLabel}</span><span className={`risk-dot risk-${h.riskLevel}`} /></span>
                    <span className="menu-sub">{new Date(h.createdAt).toLocaleString()} · {h.findings} findings · {h.changedFiles} files</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="btn ghost" onClick={() => setState((s) => ({ ...s, activeSection: 'settings' }))} title="Settings">Settings</button>
        </div>
      </header>

      <div className="shell">
        <nav className="rail" aria-label="Report sections">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={cx('rail-item', state.activeSection === s.id && 'rail-active')}
              onClick={() => setState((prev) => ({ ...prev, activeSection: s.id }))}
              title={s.label}
            >
              <span className="rail-short">{s.short}</span>
              <span className="rail-label">{s.label}</span>
              {s.id === 'review' && findingCount > 0 && <span className="rail-count">{findingCount}</span>}
              {s.id === 'documentation' && (report?.documentation.findings.length ?? 0) > 0 && <span className="rail-count">{report!.documentation.findings.length}</span>}
              {s.id === 'agent' && (report?.agent.events.length ?? 0) > 0 && <span className="rail-count">{report!.agent.events.length}</span>}
            </button>
          ))}
          <div className="rail-spacer" />
          <div className={cx('provider-dot', report?.provider.state)} title={`Provider: ${report?.provider.state ?? 'unknown'}`}>
            <span className="dot" />
            <span className="rail-provider">{report?.provider.state === 'ok' ? 'AI ready' : report?.provider.state === 'disabled' ? 'AI off' : report?.provider.state ?? 'no report'}</span>
          </div>
        </nav>

        <main className="main">
          {bridge.kind === 'static' && (
          <Banner level="info" title="Standalone export">
            This file contains a real DiffWise report rendered offline. Chat, patch application and verification
            need a live local session: run <code className="mono">diffwise report latest --serve</code>.
          </Banner>
        )}
        {state.error && <Banner level="error" title="Analysis error">{state.error}</Banner>}
          {notice && <Banner level={notice.level} title={notice.level === 'warn' ? 'Notice' : notice.level === 'error' ? 'Error' : 'Information'}>{notice.message}</Banner>}
          {state.running && <ProgressPanel stages={state.stages} label={runningStage?.label ?? 'Starting analysis'} />}

          {!report && !state.running && (
            <Welcome
              onRun={run}
              kind={bridge.kind}
              history={state.history}
              onOpenReview={(id) => bridge.post({ type: 'openReview', id })}
            />
          )}

          {report && !state.running && (
            <>
              {state.activeSection === 'overview' && (
                <Overview
                  report={report}
                  running={state.running}
                  onSection={(id) => setState((prev) => ({ ...prev, activeSection: id }))}
                  onOpen={openFile}
                  onRerun={() => run(report.target)}
                />
              )}
              {state.activeSection === 'changes' && <Changes report={report} onOpen={openFile} />}
              {state.activeSection === 'architecture' && <Architecture report={report} onOpen={openFile} />}
              {state.activeSection === 'review' && (
                <Review
                  report={report}
                  activeId={state.activeFindingId}
                  onSelect={(id) => setState((prev) => ({ ...prev, activeFindingId: id }))}
                  onOpen={openFile}
                  onDiscuss={(id) => { setScope({ type: 'finding', id }); setState((prev) => ({ ...prev, activeSection: 'discussion' })); }}
                  fixesByFinding={state.fixesByFinding}
                  fixLoading={state.fixLoading}
                  onGenerateFix={generateFix}
                  onApplyFix={applyFix}
                  onRevertFix={revertFix}
                  appliedFixes={state.appliedFixes}
                  verification={state.verification}
                  onVerify={verify}
                />
              )}
              {state.activeSection === 'documentation' && <Documentation report={report} onOpen={openFile} />}
              {state.activeSection === 'security' && <Security report={report} onOpen={openFile} onDiscuss={(id) => { setScope({ type: 'finding', id }); setState((prev) => ({ ...prev, activeSection: 'discussion' })); }} />}
              {state.activeSection === 'testing' && <Testing report={report} onOpen={openFile} onVerify={verify} verification={state.verification} onCopy={copy} />}
              {state.activeSection === 'agent' && <Agent report={report} onOpen={openFile} onCopy={copy} />}
              {state.activeSection === 'discussion' && (
                <Discussion
                  report={report}
                  messages={state.chatByScope[scope.type === 'finding' ? `finding:${scope.id}` : 'report'] ?? []}
                  pending={Boolean(state.pendingChat[scope.type === 'finding' ? `finding:${scope.id}` : 'report'])}
                  scope={scope}
                  onScope={(s) => setScope(s)}
                  onAsk={(q) => ask(q)}
                  onOpen={openFile}
                  onSettings={() => setState((prev) => ({ ...prev, activeSection: 'settings' }))}
                />
              )}
              {state.activeSection === 'settings' && (
                <Settings
                  settings={settings}
                  onSave={saveSettings}
                  onTest={testProvider}
                  testResult={providerTest}
                  testing={testingProvider}
                  onOpenSettingsFile={openSettingsFile}
                />
              )}
            </>
          )}
        </main>
      </div>

      <footer className="statusbar">
        <span className={cx('status-item', report?.summary.completeness === 'complete' ? 'ok' : 'warn')}>
          {report ? `${report.summary.completeness} analysis` : 'no analysis'}
        </span>
        {report && <span className="status-item">review {report.id}</span>}
        {report && <span className="status-item">{report.findings.length} findings</span>}
        {report && <span className="status-item">{duration(report.durationMs)}</span>}
        {report?.ai && <span className="status-item">{report.ai.requests} model request(s)</span>}
        {report && <span className="status-item">updated {timeAgo(report.createdAt)}</span>}
        <span className="status-spacer" />
        <span className="status-item">DiffWise 0.1.0</span>
        <span className={cx('status-item', 'bridge', bridge.kind)}>{hostLabel(bridge.kind)}</span>
      </footer>
    </div>
  );
}

function reduce(
  prev: ViewState,
  message: HostMessage,
  setProviderTest: (r: { ok: boolean; message: string; latencyMs: number; model: string } | undefined) => void,
  setTestingProvider: (b: boolean) => void,
  setNotice: (n: { level: 'info' | 'warn' | 'error'; message: string } | undefined) => void,
): ViewState {
  switch (message.type) {
    case 'report':
      return {
        ...prev,
        report: message.report,
        history: message.history,
        settings: message.settings,
        running: false,
        stages: message.report.stages,
        appliedFixes: message.appliedFixes ?? message.report.appliedFixes ?? [],
        fixesByFinding: { ...prev.fixesByFinding, ...groupFixes(message.report) },
        activeFindingId: prev.activeFindingId ?? message.report.findings[0]?.id,
      };
    case 'progress':
      return { ...prev, stages: message.stages, running: message.running };
    case 'error':
      return { ...prev, running: false, error: message.detail ? `${message.message} — ${message.detail}` : message.message };
    case 'notice':
      setNotice({ level: message.level, message: message.message });
      return prev;
    case 'chat': {
      const targetKey = requestScopes.get(message.requestId) ?? 'report';
      const pending = { ...prev.pendingChat };
      delete pending[targetKey];
      if (!message.answer) {
        const turn: ChatTurn = { role: 'assistant', content: 'The answer could not be produced.', createdAt: new Date().toISOString(), error: message.error ?? 'Unknown provider error' };
        return { ...prev, pendingChat: pending, chatByScope: { ...prev.chatByScope, [targetKey]: [...(prev.chatByScope[targetKey] ?? []), turn] } };
      }
      const turn: ChatTurn = {
        role: 'assistant',
        content: `${message.answer.answer}${message.answer.caveats.length ? `\n\nCaveats: ${message.answer.caveats.join(' ')}` : ''}${message.answer.confidence === 'low' ? '\n\nConfidence: low — treat as unverified interpretation.' : ''}`,
        createdAt: new Date().toISOString(),
        citations: message.answer.citations,
      };
      return { ...prev, pendingChat: pending, chatByScope: { ...prev.chatByScope, [targetKey]: [...(prev.chatByScope[targetKey] ?? []), turn] } };
    }
    case 'fixes':
      return {
        ...prev,
        fixLoading: null,
        fixesByFinding: { ...prev.fixesByFinding, [message.findingId]: message.fixes },
        ...(message.error ? { error: message.error } : {}),
      };
    case 'applied':
      return {
        ...prev,
        report: message.report,
        appliedFixes: [...prev.appliedFixes.filter((a) => a.id !== message.applied.id), message.applied],
        verification: message.applied.verification ?? prev.verification,
      };
    case 'verification':
      return { ...prev, verification: message.execution };
    case 'settingsSaved':
      setNotice({ level: 'info', message: 'Settings saved.' });
      return { ...prev, settings: message.settings };
    case 'providerTest':
      setTestingProvider(false);
      setProviderTest(message.result);
      return prev;
    case 'history':
      return { ...prev, history: message.history };
    default:
      return prev;
  }
}

function groupFixes(report: ReviewReport): Record<string, import('@diffwise/core').FixSolution[]> {
  const out: Record<string, import('@diffwise/core').FixSolution[]> = {};
  for (const fix of report.fixes) (out[fix.findingId] ??= []).push(fix);
  return out;
}

const requestScopes = new Map<string, string>();

export function registerRequestScope(requestId: string, key: string): void {
  requestScopes.set(requestId, key);
}

function ProgressPanel({ stages, label }: { stages: AnalysisStage[]; label: string }) {
  const done = stages.filter((s) => s.status === 'completed').length;
  const pct = stages.length ? Math.round((done / stages.length) * 100) : 0;
  return (
    <div className="card progress-card">
      <div className="card-head"><h2>Analysis in progress</h2><Chip tone="accent">{pct}%</Chip></div>
      <div className="progress-bar"><div style={{ width: `${Math.max(4, pct)}%` }} /></div>
      <p className="muted small">{label}</p>
      <div className="stage-list compact">
        {stages.map((s) => (
          <div className="stage" key={s.id}>
            <span className={`stage-dot stage-${s.status}`} />
            <span className="stage-label">{s.label}</span>
            <span className="stage-status">{s.status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Welcome({ onRun, kind, history, onOpenReview }: { onRun: (t: ReviewTarget) => void; kind: 'vscode' | 'server' | 'static' | 'standalone'; history: ReviewIndexEntry[]; onOpenReview: (id: string) => void }) {
  return (
    <div className="welcome">
      <div className="welcome-hero">
        <Logo large />
        <h1>Understand every change.<br />Make better engineering decisions.</h1>
        <p className="lede">DiffWise reads the change, the architecture around it, the documents that describe it and the decisions that produced it — then tells you what could go wrong and what to do about it.</p>
        <div className="welcome-actions">
          <button className="btn primary large" onClick={() => onRun({ mode: 'working', label: 'Working tree' })}>Review current changes</button>
          <button className="btn large" onClick={() => onRun({ mode: 'staged', label: 'Staged changes' })}>Review staged</button>
          <button className="btn ghost large" onClick={() => onRun({ mode: 'commits', base: 'HEAD~1', head: 'HEAD', label: 'Last commit' })}>Review last commit</button>
        </div>
        <p className="muted small">{hostDescription(kind)}</p>
      </div>

      <div className="welcome-grid">
        {[
          ['Five questions', 'What changed, why, what is affected, what could break, and how to fix it — answered from repository evidence.'],
          ['Evidence discipline', 'Every finding cites file, line and the exact text that supports it. Model claims that cannot be verified are discarded.'],
          ['Documentation as a target', 'README, ADRs, OpenAPI and design docs are checked against the code that changed.'],
          ['Safe fixes', 'Alternative solutions, trade-offs, machine-validated patches, explicit approval, backed-up files, real verification output.'],
        ].map(([title, body]) => (
          <div className="welcome-card" key={title}>
            <h3>{title}</h3>
            <p>{body}</p>
          </div>
        ))}
      </div>

      {history.length > 0 && (
        <div className="card">
          <div className="card-head"><h3>Previous reviews</h3></div>
          {history.slice(0, 5).map((h) => (
            <button className="history-row" key={h.id} onClick={() => onOpenReview(h.id)}>
              <span className={`risk-dot risk-${h.riskLevel}`} />
              <span>{h.targetLabel}</span>
              <span className="muted small">{new Date(h.createdAt).toLocaleString()}</span>
              <span className="muted small">{h.findings} findings · {h.changedFiles} files</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function hostLabel(kind: 'vscode' | 'server' | 'static' | 'standalone'): string {
  switch (kind) {
    case 'vscode': return 'VS Code host';
    case 'server': return 'local report server';
    case 'static': return 'standalone export';
    default: return 'standalone harness';
  }
}

function hostDescription(kind: 'vscode' | 'server' | 'static' | 'standalone'): string {
  switch (kind) {
    case 'vscode': return 'Runs inside this VS Code window. Nothing leaves your machine until you configure a provider.';
    case 'server': return 'Served by diffwise report --serve on loopback. Model credentials stay on the local backend; patches require explicit approval.';
    case 'static': return 'A self-contained export. It renders the stored report offline and cannot run git, call a model or modify files.';
    default: return 'Standalone UI harness: load a review from the extension to interact with live data.';
  }
}

function Logo({ large = false }: { large?: boolean }) {
  return (
    <svg className={cx('logo', large && 'logo-large')} viewBox="0 0 40 40" role="img" aria-label="DiffWise">
      <rect x="1" y="1" width="38" height="38" rx="10" className="logo-frame" />
      <path d="M12 11v18" className="logo-rail" />
      <path d="M17 14h9M17 20h6M17 26h11" className="logo-lines" />
      <circle cx="28" cy="14" r="3" className="logo-node" />
      <circle cx="24" cy="26" r="2.4" className="logo-node alt" />
    </svg>
  );
}
