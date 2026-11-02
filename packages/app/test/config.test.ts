import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG, applyEnvOverrides, analysisSettingsFrom, normalizeConfig, resolveProvider,
} from '../src/config';

describe('configuration', () => {
  it('falls back to documented defaults', () => {
    const warnings: string[] = [];
    const config = normalizeConfig(undefined, warnings);
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings).toEqual([]);
    expect(config.provider.apiKeyEnvVar).toBe('DIFFWISE_API_KEY');
    expect(config.ai.sendRepositoryContent).toBe(false);
    expect(config.qualityGate.failOn).toBe('high');
  });

  it('never accepts a credential inside config.json, and says so', () => {
    const warnings: string[] = [];
    const config = normalizeConfig({ provider: { apiKey: 'sk-live-should-not-be-here' } }, warnings);
    expect(JSON.stringify(config)).not.toContain('sk-live');
    expect(warnings.join(' ')).toMatch(/must not be stored/);
  });

  it('ignores unknown keys and clamps invalid numbers', () => {
    const warnings: string[] = [];
    const config = normalizeConfig({ analysis: { maxFiles: -5 }, provider: { id: 'not-a-provider' }, extra: true }, warnings);
    expect(config.analysis.maxFiles).toBe(1);
    expect(config.provider.id).toBe('openai-compatible');
    expect(config).not.toHaveProperty('extra');
  });

  it('applies environment overrides used by CI', () => {
    const config = applyEnvOverrides(DEFAULT_CONFIG, {
      DIFFWISE_MODEL: 'test-model',
      DIFFWISE_AI: 'off',
      DIFFWISE_FAIL_ON: 'low',
      DIFFWISE_VERIFY_COMMAND: 'npm test',
      DIFFWISE_MAX_FILES: '42',
    });
    expect(config.provider.model).toBe('test-model');
    expect(config.ai.enabled).toBe(false);
    expect(config.qualityGate.failOn).toBe('low');
    expect(config.verification.command).toBe('npm test');
    expect(config.analysis.maxFiles).toBe(42);
    // The original object is not mutated.
    expect(DEFAULT_CONFIG.provider.model).toBe('gpt-4o-mini');
  });

  it('maps config to analysis settings', () => {
    const settings = analysisSettingsFrom(DEFAULT_CONFIG);
    expect(settings.maxFiles).toBe(DEFAULT_CONFIG.analysis.maxFiles);
    expect(settings.aiEnabled).toBe(DEFAULT_CONFIG.ai.enabled);
    expect(settings.providerId).toBe(DEFAULT_CONFIG.provider.id);
  });

  it('reports a missing key instead of throwing', () => {
    const resolved = resolveProvider(DEFAULT_CONFIG, {});
    expect(resolved.provider).toBeUndefined();
    expect(resolved.apiKeyPresent).toBe(false);
    expect(resolved.reason).toContain('DIFFWISE_API_KEY');
  });

  it('builds a provider when the key is present, without exposing it', () => {
    const resolved = resolveProvider(DEFAULT_CONFIG, { DIFFWISE_API_KEY: 'sk-test-value' });
    expect(resolved.provider).toBeTruthy();
    expect(resolved.apiKeyPresent).toBe(true);
    expect(JSON.stringify({ reason: resolved.reason })).not.toContain('sk-test-value');
  });

  it('routes models per task, with fastModel as the fallback', () => {
    // Default: one model for everything, so a single-provider setup builds one
    // provider and behaves exactly as before routing existed.
    const plain = resolveProvider(DEFAULT_CONFIG, { DIFFWISE_API_KEY: 'sk-test' });
    expect(plain.models).toMatchObject({
      review: DEFAULT_CONFIG.provider.model,
      verify: DEFAULT_CONFIG.provider.model,
      fix: DEFAULT_CONFIG.provider.model,
      chat: DEFAULT_CONFIG.provider.model,
    });

    const routed = resolveProvider(
      normalizeConfig({ models: { review: 'strong-model', verify: 'cheap-model' } }),
      { DIFFWISE_API_KEY: 'sk-test' },
    );
    expect(routed.models).toMatchObject({ review: 'strong-model', verify: 'cheap-model' });
    // Chat and fix were not configured: they follow the cheap model, which is
    // the documented fallback for everything except reviewer work.
    expect(routed.tasks?.review).not.toBe(routed.tasks?.verify);
  });

  it('accepts ai.required from config and the environment', () => {
    expect(DEFAULT_CONFIG.ai.required).toBe(false);
    expect(normalizeConfig({ ai: { required: true } }).ai.required).toBe(true);
    expect(applyEnvOverrides(DEFAULT_CONFIG, { DIFFWISE_AI_REQUIRED: '1' }).ai.required).toBe(true);
    expect(applyEnvOverrides(normalizeConfig({ ai: { required: true } }), { DIFFWISE_AI_REQUIRED: '0' }).ai.required).toBe(false);
  });

  it('honours ai.enabled=false over a present key', () => {
    const config = normalizeConfig({ ai: { enabled: false } });
    const resolved = resolveProvider(config, { DIFFWISE_API_KEY: 'sk-test' });
    expect(resolved.provider).toBeUndefined();
    expect(resolved.reason).toMatch(/disabled/i);
  });
});
