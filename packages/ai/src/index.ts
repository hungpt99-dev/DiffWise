/**
 * DiffWise AI layer.
 *
 * Public surface: a provider factory, the review enricher, the report chat and
 * a connectivity check. The extension and the MCP server use only these.
 */
export type {
  ChatMessage, CompletionRequest, CompletionResult, LlmProvider, PingResult, ProviderCapabilities,
  ProviderConfig, ProviderId, Usage,
} from './types';
export { ProviderError, scrubKey, estimateTokens } from './types';
export { createProvider, OpenAiCompatibleProvider, AnthropicProvider, NoProvider, contextWindowFor } from './providers';
export { AiReviewer } from './reviewer';
export type { AiReviewerOptions } from './reviewer';
export { ReportChat, testProvider } from './chat';
export type { AskOptions, ChatAnswer, ChatOptions } from './chat';
export { parseJsonLoose, salvageJson, stringArray, clampLine } from './json';
export { ReviewSession } from './session';
export type { ReviewSessionOptions, ReviewSessionResult } from './session';
export { REVIEW_SYSTEM, FIX_SYSTEM, CHAT_SYSTEM, PROMPT_VERSION, reviewUserPrompt, fixUserPrompt, chatUserPrompt } from './prompts';
export { InstrumentedProvider, instrumentProvider, CACHE_KEY_VERSION } from './instrument';
export type { InstrumentOptions } from './instrument';
export { locateQuote } from './reviewer';
