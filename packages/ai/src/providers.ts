import type {
  ChatMessage, CompletionRequest, CompletionResult, LlmProvider, PingResult, ProviderCapabilities,
  ProviderConfig, ProviderId,
} from './types';
import { ProviderError, scrubKey } from './types';
import { estimatePromptTokens } from '@diffwise/core';
import { providerDefinition } from './registry';

/**
 * HTTP providers.
 *
 * All of them speak plain fetch (Node >= 20), apply a hard timeout, retry
 * transient failures with backoff, and surface a scrubbed, actionable error.
 * Only three wire shapes are implemented, which is deliberate: an adapter that
 * silently half-works is worse than an explicit "unsupported provider".
 */

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (base.endsWith(path)) return base;
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

function timeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Provider request timed out after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  opts: { timeoutMs: number; signal?: AbortSignal; apiKey?: string },
): Promise<{ status: number; text: string }> {
  const { signal, cancel } = timeoutSignal(opts.signal, opts.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...JSON_HEADERS, ...headers },
      body: JSON.stringify(body),
      signal,
    });
    const text = await res.text();
    return { status: res.status, text };
  } catch (err) {
    if (signal.aborted) {
      const reason = (signal.reason as Error | undefined)?.message ?? 'Request aborted';
      throw new ProviderError(reason, undefined, false);
    }
    throw new ProviderError(scrubKey((err as Error).message, opts.apiKey), undefined, true);
  } finally {
    cancel();
  }
}

function parseJsonBody(text: string, apiKey?: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ProviderError('Provider returned a non-JSON response', undefined, false, scrubKey(text.slice(0, 400), apiKey));
  }
}

function errorMessage(body: Record<string, unknown>, fallback: string): string {
  const err = body.error;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    const msg = e.message ?? e.type ?? e.code;
    if (typeof msg === 'string') return msg;
  }
  const message = body.message;
  if (typeof message === 'string') return message;
  return fallback;
}

async function withRetry<T>(run: (attempt: number) => Promise<T>, signal?: AbortSignal): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await run(attempt);
    } catch (err) {
      lastError = err;
      const retryable = err instanceof ProviderError ? err.retryable : false;
      if (!retryable || attempt === 2 || signal?.aborted) throw err;
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
    }
  }
  throw lastError;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Read usage from a response body.
 *
 * Every provider reports it differently, and some gateways omit it entirely.
 * When it is absent the estimate is marked `source: 'estimated'` so the report
 * never presents a guess as a measurement.
 */
function readUsage(
  usage: Record<string, unknown> | undefined,
  messages: Array<{ role: string; content: string }>,
  request: { model?: string },
  shape: 'openai' | 'anthropic' = 'openai',
): { promptTokens: number; completionTokens: number; cachedTokens?: number; reasoningTokens?: number; source: 'provider' | 'estimated' } {
  const prompt = num(shape === 'anthropic' ? usage?.input_tokens : usage?.prompt_tokens, -1);
  const completion = num(shape === 'anthropic' ? usage?.output_tokens : usage?.completion_tokens, -1);
  if (prompt < 0 && completion < 0) {
    return {
      promptTokens: estimatePromptTokens(messages, request.model),
      completionTokens: 0,
      source: 'estimated',
    };
  }
  const promptDetails = (shape === 'openai' ? usage?.prompt_tokens_details : undefined) as Record<string, unknown> | undefined;
  const completionDetails = (shape === 'openai' ? usage?.completion_tokens_details : undefined) as Record<string, unknown> | undefined;
  const cached = shape === 'anthropic'
    ? num(usage?.cache_read_input_tokens, 0)
    : num(promptDetails?.cached_tokens, 0);
  const reasoning = num(completionDetails?.reasoning_tokens, 0);
  return {
    promptTokens: Math.max(0, prompt),
    completionTokens: Math.max(0, completion),
    ...(cached > 0 ? { cachedTokens: cached } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
    source: 'provider',
  };
}

function contextWindowFor(model: string): number | undefined {
  const m = model.toLowerCase();
  if (/(gpt-4\.1|gpt-5|o[34])/.test(m)) return 128_000;
  if (/gpt-4o/.test(m)) return 128_000;
  if (/claude/.test(m)) return 200_000;
  if (/gemini/.test(m)) return 1_000_000;
  if (/deepseek/.test(m)) return 128_000;
  if (/(qwen|llama|mistral)/.test(m)) return 32_000;
  return undefined;
}

class OpenAiCompatibleProvider implements LlmProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  private jsonModeSupported = true;

  constructor(protected readonly config: ProviderConfig, id: ProviderId = 'openai-compatible', label = 'OpenAI-compatible') {
    this.id = id;
    this.label = label;
    this.model = config.model;
    const window = contextWindowFor(config.model);
    this.capabilities = { chat: true, jsonMode: true, streaming: false, ...(window ? { maxContextTokens: window } : {}) };
  }

  protected headers(): Record<string, string> {
    const h: Record<string, string> = { ...(this.config.extraHeaders ?? {}) };
    if (this.config.apiKey) h.Authorization = `Bearer ${this.config.apiKey}`;
    return h;
  }

  protected endpoint(): string {
    return joinUrl(this.config.baseUrl, '/chat/completions');
  }

  protected body(request: CompletionRequest, json: boolean, maxTokens: number): Record<string, unknown> {
    return {
      model: this.config.model,
      messages: request.messages,
      temperature: request.temperature ?? this.config.temperature,
      max_tokens: maxTokens,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    const useJson = Boolean(request.json) && this.jsonModeSupported;
    const baseTokens = request.maxTokens ?? this.config.maxTokens;
    // Reasoning models spend completion tokens on hidden reasoning before they
    // emit an answer. A tight budget can therefore produce an empty `content`
    // with finish_reason=length. Retry once with a larger budget instead of
    // reporting a provider failure.
    // One bounded escalation, never three: every retry re-sends the whole
    // prompt, so an unbounded ladder multiplies cost on a provider that keeps
    // returning empty content. `max(1.5x, +2000)` is enough for reasoning
    // models whose hidden reasoning consumed the first budget.
    const escalated = Math.min(32_000, Math.max(Math.ceil(baseTokens * 1.5), baseTokens + 2_000));
    const budgets = baseTokens >= escalated ? [baseTokens] : [baseTokens, escalated];
    let lastFinish: string | undefined;
    for (const budget of budgets) {
      const attempt = await this.once(request, useJson, budget, started);
      if (attempt.text) return attempt;
      lastFinish = attempt.finishReason;
      if (attempt.finishReason !== 'length') break;
    }
    throw new ProviderError(
      `Model returned no content${lastFinish === 'length' ? ' because it hit the max_tokens limit (reasoning tokens count toward it); raise diffwise.provider.maxTokens' : ''}`,
      undefined,
      false,
    );
  }

  private async once(request: CompletionRequest, useJson: boolean, budget: number, started: number): Promise<CompletionResult> {
    return withRetry(async () => {
      const res = await postJson(this.endpoint(), this.body(request, useJson, budget), this.headers(), {
        timeoutMs: this.config.timeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
        ...(this.config.apiKey ? { apiKey: this.config.apiKey } : {}),
      });
      const body = parseJsonBody(res.text, this.config.apiKey);
      if (res.status >= 400) {
        const message = errorMessage(body, `HTTP ${res.status}`);
        // Some gateways reject response_format; degrade once instead of failing the review.
        if (useJson && res.status === 400 && /response_format|json_object|json mode/i.test(message)) {
          this.jsonModeSupported = false;
          return this.complete({ ...request, json: false });
        }
        throw new ProviderError(message, res.status, res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500);
      }
      const choices = body.choices as Array<Record<string, unknown>> | undefined;
      const first = choices?.[0];
      const message = first?.message as Record<string, unknown> | undefined;
      const text = typeof message?.content === 'string' ? message.content : '';
      const usage = body.usage as Record<string, unknown> | undefined;
      return {
        text,
        model: typeof body.model === 'string' ? body.model : this.config.model,
        latencyMs: Date.now() - started,
        usage: readUsage(usage, request.messages, { model: this.config.model }, 'openai'),
        ...(typeof first?.finish_reason === 'string' ? { finishReason: first.finish_reason } : {}),
      };
    }, request.signal);
  }

  async ping(): Promise<PingResult> {
    const started = Date.now();
    try {
      const result = await this.complete({
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        maxTokens: 8,
        temperature: 0,
      });
      return {
        ok: true,
        latencyMs: Date.now() - started,
        message: `Connected. Model replied in ${Date.now() - started}ms.`,
        model: result.model,
      };
    } catch (err) {
      const e = err as ProviderError;
      return { ok: false, latencyMs: Date.now() - started, message: scrubKey(e.message, this.config.apiKey), model: this.config.model };
    }
  }
}

class OllamaProvider extends OpenAiCompatibleProvider {
  constructor(config: ProviderConfig) {
    super({ ...config, baseUrl: config.baseUrl || 'http://127.0.0.1:11434/v1' }, 'ollama', 'Ollama / local OpenAI-compatible');
    this.capabilities.jsonMode = false;
  }
}

/** Azure OpenAI: same body shape, deployment path and `api-key` header. */
class AzureOpenAiProvider extends OpenAiCompatibleProvider {
  constructor(config: ProviderConfig) {
    super(config, 'azure-openai', 'Azure OpenAI');
    if (!this.config.baseUrl) throw new ProviderError('Azure OpenAI needs provider.baseUrl (https://<resource>.openai.azure.com).', undefined, false);
  }

  protected override headers(): Record<string, string> {
    const h: Record<string, string> = { ...(this.config.extraHeaders ?? {}) };
    if (this.config.apiKey) h['api-key'] = this.config.apiKey;
    return h;
  }

  protected override endpoint(): string {
    const base = this.config.baseUrl.replace(/\/+$/, '');
    const deployment = encodeURIComponent(this.config.deployment || this.config.model);
    const apiVersion = this.config.apiVersion || '2024-10-21';
    return `${base}/openai/deployments/${deployment}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
  }
}

interface GeminiPart { text?: string }
interface GeminiCandidate { content?: { parts?: GeminiPart[] }; finishReason?: string }

/** Google Gemini `generateContent`. Native shape; no OpenAI emulation. */
class GeminiProvider implements LlmProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;

  constructor(private readonly config: ProviderConfig) {
    this.id = config.id;
    this.label = config.label || 'Google Gemini';
    this.model = config.model;
    const window = contextWindowFor(config.model);
    this.capabilities = { chat: true, jsonMode: true, streaming: false, ...(window ? { maxContextTokens: window } : {}) };
  }

  private endpoint(): string {
    const base = (this.config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    if (base.includes(':generateContent')) return base;
    return `${base}/models/${encodeURIComponent(this.config.model)}:generateContent`;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    const system = request.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const headers: Record<string, string> = { ...(this.config.extraHeaders ?? {}) };
    if (this.config.apiKey) headers['x-goog-api-key'] = this.config.apiKey;
    return withRetry(async () => {
      const res = await postJson(this.endpoint(), {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents,
        generationConfig: {
          temperature: request.temperature ?? this.config.temperature,
          maxOutputTokens: request.maxTokens ?? this.config.maxTokens,
          ...(request.json ? { responseMimeType: 'application/json' } : {}),
        },
      }, headers, {
        timeoutMs: this.config.timeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
        ...(this.config.apiKey ? { apiKey: this.config.apiKey } : {}),
      });
      const body = parseJsonBody(res.text, this.config.apiKey);
      if (res.status >= 400) {
        throw new ProviderError(errorMessage(body, `HTTP ${res.status}`), res.status, res.status === 429 || res.status >= 500);
      }
      const candidates = (body.candidates as GeminiCandidate[] | undefined) ?? [];
      const text = candidates[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (!text) throw new ProviderError('Gemini returned no text content', res.status, false);
      const usage = body.usageMetadata as Record<string, unknown> | undefined;
      const promptTokens = num(usage?.promptTokenCount, -1);
      return {
        text,
        model: this.config.model,
        latencyMs: Date.now() - started,
        usage: promptTokens >= 0
          ? {
            promptTokens,
            completionTokens: num(usage?.candidatesTokenCount, 0),
            ...(num(usage?.cachedContentTokenCount, 0) > 0 ? { cachedTokens: num(usage?.cachedContentTokenCount, 0) } : {}),
            source: 'provider',
          }
          : { promptTokens: estimatePromptTokens(request.messages, this.config.model), completionTokens: 0, source: 'estimated' },
        ...(candidates[0]?.finishReason ? { finishReason: candidates[0].finishReason } : {}),
      };
    }, request.signal);
  }

  async ping(): Promise<PingResult> {
    const started = Date.now();
    try {
      await this.complete({ messages: [{ role: 'user', content: 'Reply with: ok' }], maxTokens: 8, temperature: 0 });
      return { ok: true, latencyMs: Date.now() - started, message: `Connected to ${this.label}.`, model: this.model };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, message: scrubKey((err as Error).message, this.config.apiKey), model: this.model };
    }
  }
}

/**
 * Fallback wrapper.
 *
 * Fallback is opt-in and transparent: a provider failure is recorded on the
 * result, never hidden. The caller decides whether a cross-provider fallback is
 * allowed for the data in question.
 */
class FallbackProvider implements LlmProvider {
  constructor(
    readonly primary: LlmProvider,
    readonly secondary: LlmProvider,
    private readonly onFallback?: (reason: string, error: Error) => void,
  ) {}

  get id(): ProviderId { return this.primary.id; }
  get label(): string { return `${this.primary.label} (fallback: ${this.secondary.label})`; }
  get model(): string { return this.primary.model; }
  get capabilities(): ProviderCapabilities { return this.primary.capabilities; }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    try {
      return await this.primary.complete(request);
    } catch (err) {
      if (request.signal?.aborted) throw err;
      this.onFallback?.((err as Error).message, err as Error);
      const result = await this.secondary.complete(request);
      return { ...result, model: `${result.model} (fallback)` };
    }
  }

  async ping(): Promise<PingResult> {
    const first = await this.primary.ping();
    if (first.ok) return first;
    const second = await this.secondary.ping();
    return { ...second, message: `primary: ${first.message}; fallback: ${second.message}` };
  }
}

/** Wrap a provider with an explicit fallback. */
export function withFallback(
  primary: LlmProvider,
  secondary: LlmProvider | undefined,
  onFallback?: (reason: string, error: Error) => void,
): LlmProvider {
  return secondary ? new FallbackProvider(primary, secondary, onFallback) : primary;
}

interface AnthropicContentBlock { type: string; text?: string }

class AnthropicProvider implements LlmProvider {
  readonly id: ProviderId = 'anthropic';
  readonly label = 'Anthropic Messages API';
  readonly model: string;
  readonly capabilities: ProviderCapabilities;

  constructor(private readonly config: ProviderConfig) {
    this.model = config.model;
    const window = contextWindowFor(config.model);
    this.capabilities = { chat: true, jsonMode: false, streaming: false, ...(window ? { maxContextTokens: window } : {}) };
  }

  private endpoint(): string {
    const base = this.config.baseUrl.replace(/\/+$/, '');
    if (base.endsWith('/v1/messages')) return base;
    if (base.endsWith('/v1')) return `${base}/messages`;
    return `${base}/v1/messages`;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    const system = request.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const messages = request.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
    return withRetry(async () => {
      const res = await postJson(this.endpoint(), {
        model: this.config.model,
        system,
        messages,
        max_tokens: request.maxTokens ?? this.config.maxTokens,
        temperature: request.temperature ?? this.config.temperature,
      }, {
        'anthropic-version': '2023-06-01',
        ...(this.config.apiKey ? { 'x-api-key': this.config.apiKey } : {}),
        ...(this.config.extraHeaders ?? {}),
      }, {
        timeoutMs: this.config.timeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
        ...(this.config.apiKey ? { apiKey: this.config.apiKey } : {}),
      });
      const body = parseJsonBody(res.text, this.config.apiKey);
      if (res.status >= 400) {
        throw new ProviderError(errorMessage(body, `HTTP ${res.status}`), res.status, res.status === 429 || res.status >= 500);
      }
      const blocks = (body.content as AnthropicContentBlock[] | undefined) ?? [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      if (!text) throw new ProviderError('Anthropic returned no text content', res.status, false);
      const usage = body.usage as Record<string, unknown> | undefined;
      return {
        text,
        model: this.config.model,
        latencyMs: Date.now() - started,
        usage: readUsage(usage, request.messages, { model: this.config.model }, 'anthropic'),
      };
    }, request.signal);
  }

  async ping(): Promise<PingResult> {
    const started = Date.now();
    try {
      await this.complete({ messages: [{ role: 'user', content: 'Reply with: ok' }], maxTokens: 8, temperature: 0 });
      return { ok: true, latencyMs: Date.now() - started, message: `Connected to ${this.label}.`, model: this.model };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, message: scrubKey((err as Error).message, this.config.apiKey), model: this.model };
    }
  }
}

/** A provider that is explicitly not configured: every call explains why. */
class NoProvider implements LlmProvider {
  readonly id: ProviderId = 'none';
  readonly label = 'No provider configured';
  readonly model = 'none';
  readonly capabilities: ProviderCapabilities = { chat: false, jsonMode: false, streaming: false };
  async complete(): Promise<CompletionResult> {
    throw new ProviderError('No AI provider is configured. Open DiffWise settings to choose a provider.', undefined, false);
  }
  async ping(): Promise<PingResult> {
    return { ok: false, latencyMs: 0, message: 'No AI provider is configured.', model: 'none' };
  }
}

export function createProvider(config: ProviderConfig): LlmProvider {
  const definition = providerDefinition(config.id);
  switch (definition.protocol) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'gemini':
      return new GeminiProvider(config);
    case 'azure-openai':
      return new AzureOpenAiProvider(config);
    case 'openai':
    case 'bedrock-openai':
      if (config.id === 'ollama') return new OllamaProvider(config);
      return new OpenAiCompatibleProvider(config, config.id, config.label || definition.label);
    case 'none':
    default:
      return new NoProvider();
  }
}

export {
  OpenAiCompatibleProvider, AnthropicProvider, GeminiProvider, AzureOpenAiProvider, FallbackProvider,
  NoProvider, contextWindowFor,
};
