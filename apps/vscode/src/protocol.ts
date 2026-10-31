import type {
  AnalysisStage, AppliedFix, ChatTurn, Citation, FixSolution, ReviewIndexEntry, ReviewReport, ReviewTarget, TestExecution,
} from '@diffwise/core';

export type SectionId =
  | 'overview' | 'changes' | 'architecture' | 'review' | 'documentation' | 'security'
  | 'testing' | 'agent' | 'discussion' | 'settings';

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

export interface ChatAnswerPayload {
  answer: string;
  citations: Citation[];
  confidence: 'high' | 'medium' | 'low';
  caveats: string[];
  suggestedQuestions: string[];
  invalidCitations: number;
}

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
  | { type: 'navigate'; section: SectionId }
  | { type: 'openFinding'; id: string };

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
