import type {
  AnalysisStage, AppliedFix, ChatTurn, Citation, Finding, FixSolution, ProviderStatus, ReviewIndexEntry,
  ReviewReport, ReviewTarget, Severity, TestExecution,
} from '@diffwise/core';

/** Messages the extension host sends into the webview. */
export type HostMessage =
  | { type: 'report'; report: ReviewReport; history: ReviewIndexEntry[]; settings: UiSettings; appliedFixes?: AppliedFix[] }
  | { type: 'progress'; stages: AnalysisStage[]; running: boolean; label?: string }
  | { type: 'error'; message: string; detail?: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'chat'; requestId: string; answer?: ChatAnswerPayload; error?: string }
  | { type: 'fixes'; findingId: string; fixes: FixSolution[]; error?: string }
  | { type: 'applied'; applied: AppliedFix; report: ReviewReport }
  | { type: 'verification'; execution: TestExecution }
  | { type: 'settingsSaved'; settings: UiSettings }
  | { type: 'providerTest'; requestId: string; result: { ok: boolean; message: string; latencyMs: number; model: string } }
  | { type: 'history'; history: ReviewIndexEntry[] }
  | { type: 'workspace'; state: WorkspacePayload; notice?: string; error?: string; ruleTest?: RuleTestPayload; tools?: McpToolPayload[] };

export interface ChatAnswerPayload {
  answer: string;
  citations: Citation[];
  confidence: 'high' | 'medium' | 'low';
  caveats: string[];
  suggestedQuestions: string[];
  invalidCitations: number;
}

/** Messages the webview sends to the extension host. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'run'; target: ReviewTarget }
  | { type: 'cancel' }
  | { type: 'openFile'; file: string; line?: number; endLine?: number }
  | { type: 'openReview'; id: string }
  | { type: 'openHistory' }
  | { type: 'applyFix'; findingId: string; solutionId: string; approved: true }
  | { type: 'revertFix'; appliedFixId: string }
  | { type: 'verify'; command?: string; approved?: boolean }
  | { type: 'ask'; requestId: string; question: string; findingId?: string; history: ChatTurn[] }
  | { type: 'saveSettings'; settings: UiSettings }
  | { type: 'testProvider'; requestId: string; settings: UiSettings }
  | { type: 'generateFix'; findingId: string }
  | { type: 'openSettingsFile' }
  | { type: 'copy'; text: string }
  | { type: 'workspaceAction'; action: string; payload?: unknown };

export interface UiSettings {
  providerId: 'openai-compatible' | 'anthropic' | 'ollama' | 'none';
  baseUrl: string;
  model: string;
  apiKeyEnvVar: string;
  apiKeyPresent: boolean;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  aiEnabled: boolean;
  sendRepositoryContent: boolean;
  verificationCommand: string;
  maxFiles: number;
  extraHeaders: Record<string, string>;
}

export interface ViewState {
  report: ReviewReport | null;
  history: ReviewIndexEntry[];
  stages: AnalysisStage[];
  running: boolean;
  progressLabel?: string;
  error?: string;
  notice?: { level: 'info' | 'warn' | 'error'; message: string };
  settings: UiSettings | null;
  providerTest?: { ok: boolean; message: string; latencyMs: number; model: string };
  chatByScope: Record<string, ChatTurn[]>;
  pendingChat: Record<string, boolean>;
  fixesByFinding: Record<string, FixSolution[]>;
  fixLoading: string | null;
  appliedFixes: AppliedFix[];
  verification?: TestExecution;
  activeSection: SectionId;
  activeFindingId?: string;
  selectedFixByFinding: Record<string, string>;
  compareMode: boolean;
}

export type SectionId =
  | 'overview' | 'changes' | 'architecture' | 'review' | 'verification' | 'pipeline'
  | 'documentation' | 'security' | 'testing' | 'agent' | 'discussion' | 'settings'
  | 'rules' | 'mcp' | 'providers' | 'usage';

export interface SectionDef {
  id: SectionId;
  label: string;
  short: string;
}

export const SECTIONS: SectionDef[] = [
  { id: 'overview', label: 'Overview', short: 'OV' },
  { id: 'changes', label: 'Change Explorer', short: 'CH' },
  { id: 'architecture', label: 'Architecture Impact', short: 'AR' },
  { id: 'review', label: 'Code Review', short: 'CR' },
  { id: 'verification', label: 'Verified Findings', short: 'VF' },
  { id: 'pipeline', label: 'Review Pipeline', short: 'PL' },
  { id: 'documentation', label: 'Documentation', short: 'DC' },
  { id: 'rules', label: 'Rules & Policies', short: 'RL' },
  { id: 'mcp', label: 'MCP Connections', short: 'MC' },
  { id: 'providers', label: 'AI Providers', short: 'PV' },
  { id: 'usage', label: 'Usage & Cost', short: 'US' },
  { id: 'security', label: 'Security & Reliability', short: 'SR' },
  { id: 'testing', label: 'Testing', short: 'TS' },
  { id: 'agent', label: 'Agent Activity', short: 'AG' },
  { id: 'discussion', label: 'Discussion', short: 'AI' },
  { id: 'settings', label: 'Settings', short: 'ST' },
];

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info',
};

export function isVsCodeHost(): boolean {
  return typeof acquireVsCodeApi === 'function';
}

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void };

export interface Bridge {
  post(message: WebviewMessage): void;
  subscribe(handler: (message: HostMessage) => void): void;
  kind: 'vscode' | 'server' | 'static' | 'standalone';
}

/** Payload embedded by `diffwise report --format html`. */
interface StaticPayload {
  mode: 'static';
  generatedAt: string;
  capabilities: { readReport: boolean; aiChat: boolean; applyFix: boolean; runVerification: boolean; reason: string };
  report: ReviewReport;
}

declare global {
  interface Window {
    __DIFFWISE_STATIC__?: StaticPayload;
    __DIFFWISE_SERVER__?: { mode: 'server' };
  }
}

export function createBridge(): Bridge {
  if (isVsCodeHost()) {
    const api = acquireVsCodeApi();
    return {
      kind: 'vscode',
      post: (message) => api.postMessage(message),
      subscribe: (handler) => {
        window.addEventListener('message', (event: MessageEvent<HostMessage>) => handler(event.data));
      },
    };
  }
  if (window.__DIFFWISE_SERVER__?.mode === 'server') return serverBridge();
  if (window.__DIFFWISE_STATIC__) return staticBridge(window.__DIFFWISE_STATIC__);
  // Standalone UI harness: loads a real report JSON, but cannot run git, apply
  // patches or call a model. Actions are acknowledged explicitly, never faked.
  return {
    kind: 'standalone',
    post: (message) => {
      window.dispatchEvent(new CustomEvent('diffwise-standalone-post', { detail: message }));
    },
    subscribe: (handler) => {
      window.addEventListener('diffwise-standalone-message', (event) => {
        handler((event as CustomEvent<HostMessage>).detail);
      });
    },
  };
}

/**
 * Bridge for the local report server (`diffwise report --serve`).
 *
 * Every action becomes one HTTP request; the server enforces the session,
 * workspace boundary and approval rules. Failures surface as real error/notice
 * messages instead of a silent no-op.
 */
function serverBridge(): Bridge {
  const handlers: Array<(m: HostMessage) => void> = [];
  const emit = (message: HostMessage): void => { for (const handler of handlers) handler(message); };
  // The last known bootstrap data, reused when a mutation returns a report so
  // the UI does not lose its history list or settings.
  let lastHistory: ReviewIndexEntry[] = [];
  let lastSettings: UiSettings = emptyUiSettings();

  const request = async <T,>(path: string, body?: unknown): Promise<T> => {
    const res = await fetch(path, body === undefined
      ? { headers: { Accept: 'application/json' } }
      : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DiffWise-Request': '1', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(typeof data.error === 'string' ? data.error : `Request failed (${res.status}).`);
    }
    return data as T;
  };

  const loadBootstrap = async (): Promise<void> => {
    try {
      const data = await request<{
        report: ReviewReport | null;
        history: ReviewIndexEntry[];
        settings: UiSettings;
        appliedFixes?: AppliedFix[];
      }>('/api/bootstrap');
      lastHistory = data.history;
      lastSettings = data.settings;
      if (data.report) {
        emit({ type: 'report', report: data.report, history: data.history, settings: data.settings, appliedFixes: data.appliedFixes ?? [] });
      } else {
        emit({ type: 'history', history: data.history });
      }
    } catch (err) {
      emit({ type: 'error', message: 'Could not load the review from the local server.', detail: (err as Error).message });
    }
  };

  return {
    kind: 'server',
    subscribe: (handler) => {
      handlers.push(handler);
    },
    post: (message) => {
      void (async () => {
        try {
          switch (message.type) {
            case 'ready':
              await loadBootstrap();
              return;
            case 'run': {
              emit({ type: 'progress', stages: [], running: true, label: `Reviewing ${message.target.label}` });
              try {
                const data = await request<{ report: ReviewReport; history: ReviewIndexEntry[]; settings: UiSettings }>('/api/review', { target: message.target });
                lastHistory = data.history;
                lastSettings = data.settings;
                emit({ type: 'report', report: data.report, history: data.history, settings: data.settings });
              } catch (err) {
                emit({ type: 'error', message: 'Review failed.', detail: (err as Error).message });
                emit({ type: 'progress', stages: [], running: false });
              }
              return;
            }
            case 'cancel':
              emit({ type: 'notice', level: 'warn', message: 'Cancelling a review is not supported over the local server; the run continues and the result will be shown.' });
              return;
            case 'openFile':
              window.open(`/source?path=${encodeURIComponent(message.file)}${message.line ? `&line=${message.line}` : ''}${message.endLine ? `&end=${message.endLine}` : ''}`, '_blank', 'noopener');
              return;
            case 'openReview': {
              const data = await request<{ report: ReviewReport; history: ReviewIndexEntry[]; settings: UiSettings; appliedFixes?: AppliedFix[] }>('/api/open-review', { id: message.id });
              lastHistory = data.history;
              lastSettings = data.settings;
              emit({ type: 'report', report: data.report, history: data.history, settings: data.settings, appliedFixes: data.appliedFixes ?? [] });
              return;
            }
            case 'ask': {
              try {
                const data = await request<{ answer: ChatAnswerPayload; model: string; provider: string }>('/api/chat', {
                  question: message.question,
                  ...(message.findingId ? { findingId: message.findingId } : {}),
                  history: message.history,
                });
                emit({ type: 'chat', requestId: message.requestId, answer: data.answer });
              } catch (err) {
                emit({ type: 'chat', requestId: message.requestId, error: (err as Error).message });
              }
              return;
            }
            case 'generateFix':
              try {
                const data = await request<{ fixes: FixSolution[] }>('/api/fix/generate', { findingId: message.findingId });
                emit({ type: 'fixes', findingId: message.findingId, fixes: data.fixes });
              } catch (err) {
                emit({ type: 'fixes', findingId: message.findingId, fixes: [], error: (err as Error).message });
              }
              return;
            case 'applyFix': {
              const data = await request<{ ok: boolean; report: ReviewReport; error?: string; applied: { files: string[] } }>('/api/fix/apply', {
                findingId: message.findingId,
                solutionId: message.solutionId,
                approved: message.approved === true,
              });
              if (!data.ok) {
                emit({ type: 'notice', level: 'error', message: data.error ?? 'The patch was not applied.' });
                return;
              }
              const applied = data.report.appliedFixes[data.report.appliedFixes.length - 1];
              if (applied) emit({ type: 'applied', applied, report: data.report });
              else emit({ type: 'report', report: data.report, history: lastHistory, settings: lastSettings });
              return;
            }
            case 'revertFix': {
              const data = await request<{ ok: boolean; reverted: string[]; errors: string[]; report: ReviewReport }>('/api/fix/rollback', { appliedFixId: message.appliedFixId });
              emit({ type: 'report', report: data.report, history: lastHistory, settings: lastSettings });
              emit({
                type: 'notice',
                level: data.ok ? 'info' : 'error',
                message: data.ok ? `Restored ${data.reverted.length} file(s).` : `Rollback incomplete: ${data.errors.join('; ')}`,
              });
              return;
            }
            case 'verify': {
              const data = await request<{ execution: TestExecution; report: ReviewReport }>('/api/verify', {});
              emit({ type: 'verification', execution: data.execution });
              emit({ type: 'report', report: data.report, history: lastHistory, settings: lastSettings });
              return;
            }
            case 'saveSettings':
              emit({ type: 'notice', level: 'info', message: 'Configuration lives in .diffwise/config.json. Edit it there (or run "diffwise config set") and reload this page.' });
              return;
            case 'testProvider': {
              const health = await request<{ provider: { id: string; model: string; keyPresent: boolean } }>('/api/health');
              emit({
                type: 'providerTest',
                requestId: message.requestId,
                result: {
                  ok: health.provider.keyPresent,
                  message: health.provider.keyPresent
                    ? `${health.provider.id}/${health.provider.model} is configured.`
                    : 'No API key is set for the configured provider.',
                  latencyMs: 0,
                  model: health.provider.model,
                },
              });
              return;
            }
            case 'openSettingsFile':
              emit({ type: 'notice', level: 'info', message: 'Open .diffwise/config.json in your editor to change provider or verification settings.' });
              return;
            case 'copy':
              await navigator.clipboard?.writeText(message.text).catch(() => undefined);
              return;
            default:
              return;
          }
        } catch (err) {
          emit({ type: 'notice', level: 'error', message: (err as Error).message });
        }
      })();
    },
  };
}

function emptyUiSettings(): UiSettings {
  return {
    providerId: 'openai-compatible', baseUrl: '', model: '', apiKeyEnvVar: 'DIFFWISE_API_KEY',
    apiKeyPresent: false, maxTokens: 0, temperature: 0, timeoutMs: 0, aiEnabled: true,
    sendRepositoryContent: false, verificationCommand: '', maxFiles: 0, extraHeaders: {},
  };
}

/**
 * Bridge for the standalone HTML export: the report is embedded, so every read
 * works offline. Actions that need a live backend answer with the export's own
 * capability statement instead of pretending to run.
 */
function staticBridge(payload: StaticPayload): Bridge {
  const handlers: Array<(m: HostMessage) => void> = [];
  const emit = (message: HostMessage): void => { for (const handler of handlers) handler(message); };
  const reason = payload.capabilities.reason;
  return {
    kind: 'static',
    subscribe: (handler) => {
      handlers.push(handler);
      queueMicrotask(() => {
        handler({
          type: 'report',
          report: payload.report,
          history: [],
          settings: { ...emptyUiSettings(), aiEnabled: false, verificationCommand: payload.report.settings.verificationCommand ?? '' },
          appliedFixes: payload.report.appliedFixes,
        });
      });
    },
    post: (message) => {
      switch (message.type) {
        case 'ready':
          return;
        case 'copy':
          void navigator.clipboard?.writeText(message.text).catch(() => undefined);
          return;
        case 'openFile':
          emit({ type: 'notice', level: 'info', message: `${message.file}${message.line ? `:${message.line}` : ''} — the standalone export does not include repository files. Run "diffwise report latest --serve" to open source.` });
          return;
        case 'ask':
          emit({ type: 'chat', requestId: message.requestId, error: reason });
          return;
        case 'generateFix':
          emit({ type: 'fixes', findingId: message.findingId, fixes: [], error: reason });
          return;
        case 'applyFix':
        case 'verify':
        case 'revertFix':
          emit({ type: 'notice', level: 'warn', message: reason });
          return;
        default:
          emit({ type: 'notice', level: 'info', message: reason });
      }
    },
  };
}

export type { Finding, FixSolution, ReviewReport, ReviewTarget, AppliedFix, TestExecution, Citation, ChatTurn, ProviderStatus, AnalysisStage, ReviewIndexEntry };

// ---------------------------------------------------------------- workspace ---

export interface WorkspaceRule {
  id: string;
  name: string;
  category: string;
  severity: string;
  confidence: string;
  enabled: boolean;
  priority: number;
  enforcement: string;
  blocksGate: boolean;
  files: string[];
  exclude: string[];
  languages: string[] | 'any';
  description: string;
  recommendation: string;
  detection: { type: string; pattern?: string; required?: string; message?: string; from?: string; scope?: string };
  pack: string;
  path?: string;
  builtin: boolean;
  editable: boolean;
}

export interface WorkspaceRuleDescriptor {
  id: string;
  name: string;
  category: string;
  severity: string;
  mode: string;
  pack: string;
  enabled: boolean;
  description: string;
  source: 'builtin' | 'pack';
  path?: string;
  priority?: number;
  enforcement?: string;
  blocksGate?: boolean;
}

export interface WorkspaceDocumentationSource {
  path: string;
  category?: string;
  priority?: number;
  enabled?: boolean;
  modules?: string[];
}

export interface WorkspaceMcpServer {
  name: string;
  transport: 'stdio' | 'http';
  enabled: boolean;
  command?: string;
  args?: string[];
  url?: string;
  permissions: {
    readOnly: boolean;
    allowedTools: string[];
    allowedResources: string[];
    contextTools: string[];
    maxOutputBytes: number;
    timeoutMs: number;
    allowWrite: boolean;
  };
  context?: { tool?: string; resource?: string; arguments: Record<string, unknown>; label?: string };
}

export interface WorkspaceProvider {
  name: string;
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  fastModel?: string;
  apiKeyEnvVar: string;
  apiKeyPresent: boolean;
  enabled: boolean;
  primary: boolean;
}

export interface WorkspacePayload {
  rules: {
    custom: WorkspaceRule[];
    builtin: WorkspaceRuleDescriptor[];
    issues: Array<{ level: string; path: string; message: string }>;
    conflicts: Array<{ level: string; id: string; message: string }>;
    categories: Array<{ id: string; label: string; description: string }>;
    policy: {
      layers: Array<{ kind: string; source: string; appliesTo: string; loaded: boolean; error?: string }>;
      provenance: Record<string, string>;
      minSeverity: string;
      ruleOverrides: number;
      warnings: string[];
    };
  };
  documentation: {
    sources: WorkspaceDocumentationSource[];
    maxSections: number;
    maxChars: number;
    indexed: { documents: number; sections: number; bytes: number; duplicates: number; categories: Record<string, number> } | null;
    indexedAt?: string;
  };
  mcp: {
    path: string;
    exists: boolean;
    servers: WorkspaceMcpServer[];
    warnings: string[];
    statuses?: Array<{ name: string; state: string; message?: string; tools: number; resources: number; prompts: number }>;
    tools?: McpToolPayload[];
  };
  providers: {
    profiles: WorkspaceProvider[];
    routing?: Record<string, { provider?: string; model?: string; fallback?: string }>;
    models?: Record<string, string>;
    ai: { enabled: boolean; required: boolean; sendRepositoryContent: boolean };
    warnings: string[];
    tasks: string[];
  };
}

export interface RuleTestPayload {
  ruleId: string;
  valid: boolean;
  matches: Array<{ file: string; line: number; endLine: number; snippet: string; note: string }>;
  filesScanned: number;
  filesMatched: number;
  skipped: number;
  issues: Array<{ level: string; path: string; message: string }>;
}

export interface McpToolPayload {
  name: string;
  description?: string;
  readOnly: boolean;
  destructive: boolean;
  server: string;
}
