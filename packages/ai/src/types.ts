import type { AiTask } from '@diffwise/core';

/**
 * Provider-neutral model interface.
 *
 * The core review engine never imports this package: AI is an optional
 * enricher layer, and every provider is replaceable behind these types.
 */

export type ProviderId = 'openai-compatible' | 'anthropic' | 'ollama' | 'none';

export interface ProviderConfig {
  id: ProviderId;
  baseUrl: string;
  apiKey?: string;
  model: string;
  fastModel?: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  extraHeaders?: Record<string, string>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Ask the provider for a JSON object when it supports a native JSON mode. */
  json?: boolean;
  signal?: AbortSignal;
  /**
   * Which stage is paying for this call. Used only for attribution in the usage
   * report; providers ignore it.
   */
  task?: AiTask;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** Input tokens the provider served from its own prompt cache. */
  cachedTokens?: number;
  /** Hidden reasoning tokens, when the provider reports them separately. */
  reasoningTokens?: number;
  /** 'provider' when the numbers came from the API, 'estimated' otherwise. */
  source?: 'provider' | 'estimated';
}

export interface CompletionResult {
  text: string;
  model: string;
  latencyMs: number;
  usage: Usage;
  finishReason?: string;
  /** Present when the answer was served from DiffWise's content cache. */
  cache?: { hit: boolean; savedPromptTokens: number };
}

export interface ProviderCapabilities {
  chat: boolean;
  jsonMode: boolean;
  streaming: boolean;
  maxContextTokens?: number;
}

export interface PingResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  model: string;
}

export interface LlmProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  complete(request: CompletionRequest): Promise<CompletionResult>;
  ping(): Promise<PingResult>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Never place a key in an error message, log line or report. */
export function scrubKey(text: string, key: string | undefined): string {
  if (!key || key.length < 6) return text;
  return text.split(key).join('[REDACTED]');
}

export { estimateTokens, estimatePromptTokens } from '@diffwise/core';
