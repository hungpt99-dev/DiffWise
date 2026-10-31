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
  | { type: 'history'; history: ReviewIndexEntry[] };

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
  | { type: 'copy'; text: string };

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
  | 'overview' | 'changes' | 'architecture' | 'review' | 'documentation' | 'security'
  | 'testing' | 'agent' | 'discussion' | 'settings';

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
  { id: 'documentation', label: 'Documentation', short: 'DC' },
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
  kind: 'vscode' | 'standalone';
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
  // Standalone mode is a UI harness: it loads a real report JSON produced by the
  // engine, but it cannot run git, apply patches or call a model. Actions are
  // acknowledged with an explicit notice instead of simulated success.
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

export type { Finding, FixSolution, ReviewReport, ReviewTarget, AppliedFix, TestExecution, Citation, ChatTurn, ProviderStatus, AnalysisStage, ReviewIndexEntry };
