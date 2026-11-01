/**
 * Caching and usage instrumentation for model calls.
 *
 * Both concerns live in one decorator because they share the request path and
 * must agree: a cache hit is a request that cost no input tokens, and the
 * usage report has to say both things at once.
 *
 * The cache key is the hash of the provider, the model, the prompt version and
 * the **exact messages**. That is deliberately stricter than "the same finding
 * ids": a one-character change in the context produces a different key, so a
 * cached answer can never be replayed against context it was not written for.
 */
import { ContentCache, contentKey, estimatePromptTokens, type AiTask, type UsageMeter } from '@diffwise/core';
import type {
  CompletionRequest, CompletionResult, LlmProvider, PingResult, ProviderCapabilities, ProviderId,
} from './types';

export const CACHE_KEY_VERSION = 'llm-cache-v1';

export interface InstrumentOptions {
  cache?: ContentCache;
  meter?: UsageMeter;
  /** Prompt template version; bumping it invalidates every cached answer. */
  promptVersion: string;
  /** Task used when a request does not declare one. */
  defaultTask?: AiTask;
}

interface CachedAnswer {
  text: string;
  model: string;
  finishReason?: string;
  usage: { promptTokens: number; completionTokens: number; cachedTokens?: number; reasoningTokens?: number; source?: 'provider' | 'estimated' };
}

export class InstrumentedProvider implements LlmProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;

  constructor(private readonly inner: LlmProvider, private readonly opts: InstrumentOptions) {
    this.id = inner.id;
    this.label = inner.label;
    this.model = inner.model;
    this.capabilities = inner.capabilities;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const task: AiTask = request.task ?? this.opts.defaultTask ?? 'untagged';
    const cache = this.opts.cache;
    const key = cache
      ? contentKey(
        CACHE_KEY_VERSION,
        this.inner.id,
        this.inner.model,
        this.opts.promptVersion,
        request.json ? 'json' : 'text',
        String(request.maxTokens ?? ''),
        String(request.temperature ?? ''),
        request.messages.map((m) => `${m.role}:${m.content}`).join('\u0002'),
      )
      : undefined;

    if (cache && key) {
      const hit = await cache.get<CachedAnswer>(key);
      if (hit?.value?.text) {
        const saved = hit.value.usage.promptTokens || estimatePromptTokens(request.messages, this.inner.model);
        this.opts.meter?.record({
          task,
          provider: this.inner.id,
          model: this.inner.model,
          promptTokens: 0,
          completionTokens: 0,
          cacheHit: true,
          tokensSavedByCache: saved,
          latencyMs: 0,
          source: 'provider',
        });
        return {
          text: hit.value.text,
          model: hit.value.model,
          latencyMs: 0,
          usage: { promptTokens: 0, completionTokens: 0, source: 'provider' },
          ...(hit.value.finishReason ? { finishReason: hit.value.finishReason } : {}),
          cache: { hit: true, savedPromptTokens: saved },
        };
      }
    }

    let result: Awaited<ReturnType<LlmProvider['complete']>>;
    try {
      result = await this.inner.complete(request);
    } catch (err) {
      // A failed call still costs its prompt, and the provider usually reports
      // no usage for it. Recording it as a failure with an estimated prompt is
      // the honest option: dropping it entirely makes a review that lost half
      // its requests look cheap.
      this.opts.meter?.record({
        task,
        provider: this.inner.id,
        model: this.inner.model,
        promptTokens: estimatePromptTokens(request.messages, this.inner.model),
        completionTokens: 0,
        cacheHit: false,
        failure: true,
        source: 'estimated',
      });
      throw err;
    }
    const usage = result.usage;
    this.opts.meter?.record({
      task,
      provider: this.inner.id,
      model: result.model || this.inner.model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      ...(usage.cachedTokens !== undefined ? { cachedPromptTokens: usage.cachedTokens } : {}),
      ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
      cacheHit: false,
      latencyMs: result.latencyMs,
      source: usage.source ?? 'provider',
    });

    if (cache && key && result.text) {
      await cache.set<CachedAnswer>(key, {
        text: result.text,
        model: result.model,
        ...(result.finishReason ? { finishReason: result.finishReason } : {}),
        usage: {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          ...(usage.cachedTokens !== undefined ? { cachedTokens: usage.cachedTokens } : {}),
          ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
          ...(usage.source ? { source: usage.source } : {}),
        },
      }, { task });
    }
    if (cache && key) return { ...result, cache: { hit: false, savedPromptTokens: 0 } };
    return result;
  }

  ping(): Promise<PingResult> {
    // Never cached: a ping exists to prove connectivity now.
    return this.inner.ping();
  }
}

/** Wrap a provider once, at construction, so every call path is covered. */
export function instrumentProvider(inner: LlmProvider, opts: InstrumentOptions): LlmProvider {
  return new InstrumentedProvider(inner, opts);
}
