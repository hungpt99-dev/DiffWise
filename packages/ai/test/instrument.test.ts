import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentCache, UsageMeter, contentKey } from '@diffwise/core';
import { createProvider, instrumentProvider, type LlmProvider } from '../src';

/** A provider whose answers are scripted, so nothing leaves the process. */
class ScriptedProvider implements LlmProvider {
  readonly id = 'openai-compatible' as const;
  readonly label = 'scripted';
  readonly model = 'scripted-model';
  readonly capabilities = { chat: true, jsonMode: true, streaming: false };
  calls: string[][] = [];
  failWith?: Error;

  constructor(private readonly reply = '{"findings":[]}') {}

  async complete(request: { messages: Array<{ role: string; content: string }> }): Promise<{
    text: string; model: string; latencyMs: number; usage: { promptTokens: number; completionTokens: number };
  }> {
    this.calls.push(request.messages.map((m) => m.content));
    if (this.failWith) throw this.failWith;
    return { text: this.reply, model: this.model, latencyMs: 5, usage: { promptTokens: 120, completionTokens: 30 } };
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number; message: string; model: string }> {
    return { ok: true, latencyMs: 1, message: 'ok', model: this.model };
  }
}

describe('instrumented provider', () => {
  it('serves an identical prompt from the cache and records the tokens it avoided', async () => {
    const inner = new ScriptedProvider();
    const meter = new UsageMeter();
    const provider = instrumentProvider(inner, { meter, promptVersion: 'test-1', cache: new ContentCache({ ttlMs: 60_000 }) });
    const request = { messages: [{ role: 'user' as const, content: 'review this diff' }], json: true, task: 'review' as const };

    const first = await provider.complete(request);
    const second = await provider.complete(request);

    expect(inner.calls).toHaveLength(1);
    expect(first.cache?.hit).toBe(false);
    expect(second.cache?.hit).toBe(true);
    expect(second.cache?.savedPromptTokens).toBe(120);
    expect(second.usage.promptTokens).toBe(0);

    const summary = meter.summary();
    expect(summary.totals.requests).toBe(2);
    expect(summary.totals.cacheHits).toBe(1);
    expect(summary.totals.cacheMisses).toBe(1);
    expect(summary.totals.tokensSavedByCache).toBe(120);
    expect(summary.totals.promptTokens).toBe(120);
  });

  it('never reuses an answer when the prompt, model or prompt version changes', async () => {
    const inner = new ScriptedProvider();
    const meter = new UsageMeter();
    const cache = new ContentCache({ ttlMs: 60_000 });
    const provider = instrumentProvider(inner, { meter, promptVersion: 'test-1', cache });

    await provider.complete({ messages: [{ role: 'user', content: 'diff A' }], json: true });
    await provider.complete({ messages: [{ role: 'user', content: 'diff A ' }], json: true });
    await provider.complete({ messages: [{ role: 'user', content: 'diff A' }], json: true, maxTokens: 99 });

    const bumped = instrumentProvider(inner, { meter, promptVersion: 'test-2', cache });
    await bumped.complete({ messages: [{ role: 'user', content: 'diff A' }], json: true });

    expect(inner.calls).toHaveLength(4);
    expect(meter.summary().totals.cacheHits).toBe(0);
  });

  it('attributes usage to the declared task', async () => {
    const inner = new ScriptedProvider();
    const meter = new UsageMeter();
    const provider = instrumentProvider(inner, { meter, promptVersion: 'test-1', defaultTask: 'review' });
    await provider.complete({ messages: [{ role: 'user', content: 'a' }] });
    await provider.complete({ messages: [{ role: 'user', content: 'b' }], task: 'verify' });
    const summary = meter.summary();
    expect(summary.byTask.map((t) => t.task).sort()).toEqual(['review', 'verify']);
  });

  it('records a failed call as a failure with an estimated prompt, then rethrows', async () => {
    const inner = new ScriptedProvider();
    inner.failWith = new Error('provider exploded');
    const meter = new UsageMeter();
    const provider = instrumentProvider(inner, { meter, promptVersion: 'test-1' });

    await expect(provider.complete({ messages: [{ role: 'user', content: 'this prompt was still sent' }], task: 'review' }))
      .rejects.toThrow('provider exploded');

    const summary = meter.summary();
    expect(summary.totals.failures).toBe(1);
    expect(summary.totals.promptTokens).toBeGreaterThan(0);
    expect(summary.totals.source).toBe('estimated');
  });

  it('derives keys from every input and nothing else', () => {
    expect(contentKey('a', 'b')).toBe(contentKey('a', 'b'));
    expect(contentKey('a', 'b')).not.toBe(contentKey('a', 'b', 'c'));
  });
});

describe('provider usage parsing', () => {
  let server: Server;
  let baseUrl = '';

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.endsWith('/chat/completions')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          model: 'gpt-4o-mini',
          choices: [{ message: { content: '{"findings":[]}' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 1_000,
            completion_tokens: 200,
            prompt_tokens_details: { cached_tokens: 400 },
            completion_tokens_details: { reasoning_tokens: 120 },
          },
        }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}/v1` : '';
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reads cached and reasoning tokens when the provider reports them', async () => {
    const provider = createProvider({
      id: 'openai-compatible', baseUrl, model: 'gpt-4o-mini', maxTokens: 100, temperature: 0, timeoutMs: 5_000,
    });
    const result = await provider.complete({ messages: [{ role: 'user', content: 'hi' }], json: true });
    expect(result.usage.promptTokens).toBe(1_000);
    expect(result.usage.cachedTokens).toBe(400);
    expect(result.usage.reasoningTokens).toBe(120);
    expect(result.usage.source).toBe('provider');
  });

  it('marks usage as estimated when the provider omits it', async () => {
    const bare = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    });
    await new Promise<void>((resolve) => bare.listen(0, '127.0.0.1', resolve));
    const address = bare.address();
    const url = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}/v1` : '';
    try {
      const provider = createProvider({ id: 'openai-compatible', baseUrl: url, model: 'gpt-4o-mini', maxTokens: 100, temperature: 0, timeoutMs: 5_000 });
      const result = await provider.complete({ messages: [{ role: 'user', content: 'a prompt that costs something' }] });
      expect(result.usage.source).toBe('estimated');
      expect(result.usage.promptTokens).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => bare.close(() => resolve()));
    }
  });
});
