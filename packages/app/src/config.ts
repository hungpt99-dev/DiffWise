/**
 * Project configuration.
 *
 * One file — `.diffwise/config.json` — is the source of truth for every
 * interface. Credentials are never stored in it: only the *name* of the
 * environment variable that holds the key. That keeps a committed config
 * shareable and a generated report safe to publish.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { AnalysisSettings, ModelPrice, PriceTable, Severity } from '@diffwise/core';
import { DEFAULT_ANALYSIS_SETTINGS } from '@diffwise/core';
import { createProvider, type LlmProvider, type ProviderId } from '@diffwise/ai';

export const CONFIG_SCHEMA_VERSION = 1;
export const CONFIG_FILE = '.diffwise/config.json';

export type QualityGateSeverity = Severity | 'none';

export interface ProviderConfigFile {
  /** Wire protocol, not a vendor: openai-compatible covers most gateways. */
  id: ProviderId;
  baseUrl: string;
  model: string;
  /** Name of the environment variable that holds the key. Never the key. */
  apiKeyEnvVar: string;
  /** Cheaper model for chat/fixes; falls back to `model`. */
  fastModel?: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  extraHeaders?: Record<string, string>;
}

export interface DiffWiseConfig {
  schemaVersion: number;
  provider: ProviderConfigFile;
  ai: { enabled: boolean; sendRepositoryContent: boolean };
  analysis: { maxFiles: number; maxFileBytes: number; ignoreGlobs: string[] };
  verification: { command: string; timeoutMs: number };
  qualityGate: { failOn: QualityGateSeverity };
  /** Content-addressed cache for model answers. */
  cache: { enabled: boolean; maxEntries: number; ttlDays: number };
  /** How long one reviewer may run before it is treated as failed. */
  review: { timeoutMs: number };
  /**
   * Optional list prices, keyed by model name or prefix wildcard. DiffWise
   * ships none: a cost is reported only when the user states the price.
   */
  pricing?: PriceTable;
}

export const DEFAULT_CONFIG: DiffWiseConfig = {
  schemaVersion: CONFIG_SCHEMA_VERSION,
  provider: {
    id: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKeyEnvVar: 'DIFFWISE_API_KEY',
    maxTokens: 8000,
    temperature: 0.1,
    timeoutMs: 180_000,
  },
  ai: { enabled: true, sendRepositoryContent: false },
  analysis: {
    maxFiles: DEFAULT_ANALYSIS_SETTINGS.maxFiles,
    maxFileBytes: DEFAULT_ANALYSIS_SETTINGS.maxFileBytes,
    ignoreGlobs: DEFAULT_ANALYSIS_SETTINGS.ignoreGlobs,
  },
  verification: { command: '', timeoutMs: 300_000 },
  qualityGate: { failOn: 'high' },
  cache: { enabled: true, maxEntries: 500, ttlDays: 14 },
  // 120s is the core default and it is too tight for reasoning models: they can
  // spend most of a minute thinking before the first output token.
  review: { timeoutMs: 180_000 },
};

export interface LoadedConfig {
  config: DiffWiseConfig;
  /** Absolute path of the file that was read, when one existed. */
  path?: string;
  /** Human-readable problems found while loading (never fatal on their own). */
  warnings: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pick<T>(value: unknown, fallback: T, type: 'string' | 'number' | 'boolean'): T {
  return typeof value === type ? (value as T) : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Normalise arbitrary JSON into a config, recording what had to be defaulted. */
export function normalizeConfig(raw: unknown, warnings: string[] = []): DiffWiseConfig {
  const base = structuredClone(DEFAULT_CONFIG);
  if (!isObject(raw)) {
    if (raw !== undefined) warnings.push('Config must be a JSON object; using defaults.');
    return base;
  }
  const provider = isObject(raw.provider) ? raw.provider : {};
  base.provider.id = oneOf(provider.id, ['openai-compatible', 'anthropic', 'ollama', 'none'] as const, base.provider.id);
  base.provider.baseUrl = pick(provider.baseUrl, base.provider.baseUrl, 'string');
  base.provider.model = pick(provider.model, base.provider.model, 'string');
  base.provider.apiKeyEnvVar = pick(provider.apiKeyEnvVar, base.provider.apiKeyEnvVar, 'string');
  base.provider.fastModel = pick(provider.fastModel, '', 'string');
  base.provider.maxTokens = pick(provider.maxTokens, base.provider.maxTokens, 'number');
  base.provider.temperature = pick(provider.temperature, base.provider.temperature, 'number');
  base.provider.timeoutMs = pick(provider.timeoutMs, base.provider.timeoutMs, 'number');
  if (isObject(provider.extraHeaders)) {
    base.provider.extraHeaders = Object.fromEntries(
      Object.entries(provider.extraHeaders).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  }
  if (typeof provider.apiKey === 'string') {
    warnings.push('provider.apiKey must not be stored in config.json; set the environment variable named by provider.apiKeyEnvVar instead.');
  }

  const ai = isObject(raw.ai) ? raw.ai : {};
  base.ai.enabled = pick(ai.enabled, base.ai.enabled, 'boolean');
  base.ai.sendRepositoryContent = pick(ai.sendRepositoryContent, base.ai.sendRepositoryContent, 'boolean');

  const analysis = isObject(raw.analysis) ? raw.analysis : {};
  base.analysis.maxFiles = Math.max(1, pick(analysis.maxFiles, base.analysis.maxFiles, 'number'));
  base.analysis.maxFileBytes = Math.max(1024, pick(analysis.maxFileBytes, base.analysis.maxFileBytes, 'number'));
  if (Array.isArray(analysis.ignoreGlobs) && analysis.ignoreGlobs.every((g) => typeof g === 'string')) {
    base.analysis.ignoreGlobs = analysis.ignoreGlobs as string[];
  }

  const verification = isObject(raw.verification) ? raw.verification : {};
  base.verification.command = pick(verification.command, base.verification.command, 'string');
  base.verification.timeoutMs = Math.max(1000, pick(verification.timeoutMs, base.verification.timeoutMs, 'number'));

  const cache = isObject(raw.cache) ? raw.cache : {};
  base.cache.enabled = pick(cache.enabled, base.cache.enabled, 'boolean');
  base.cache.maxEntries = Math.max(0, pick(cache.maxEntries, base.cache.maxEntries, 'number'));
  base.cache.ttlDays = Math.max(0, pick(cache.ttlDays, base.cache.ttlDays, 'number'));

  const review = isObject(raw.review) ? raw.review : {};
  base.review.timeoutMs = Math.max(10_000, pick(review.timeoutMs, base.review.timeoutMs, 'number'));

  if (isObject(raw.pricing)) {
    const pricing: PriceTable = {};
    for (const [key, value] of Object.entries(raw.pricing)) {
      if (!isObject(value)) continue;
      const input = pick(value.inputPerMTok, Number.NaN, 'number');
      const output = pick(value.outputPerMTok, Number.NaN, 'number');
      if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
        warnings.push(`pricing.${key} ignored: inputPerMTok and outputPerMTok must be non-negative numbers.`);
        continue;
      }
      const price: ModelPrice = {
        inputPerMTok: input,
        outputPerMTok: output,
        source: pick(value.source, 'config', 'string'),
        ...(typeof value.cachedInputPerMTok === 'number' ? { cachedInputPerMTok: value.cachedInputPerMTok } : {}),
        ...(typeof value.asOf === 'string' ? { asOf: value.asOf } : {}),
      };
      pricing[key] = price;
    }
    if (Object.keys(pricing).length > 0) base.pricing = pricing;
  }

  const gate = isObject(raw.qualityGate) ? raw.qualityGate : {};
  base.qualityGate.failOn = oneOf(gate.failOn, ['critical', 'high', 'medium', 'low', 'info', 'none'] as const, base.qualityGate.failOn);

  if (raw.schemaVersion !== undefined && raw.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    warnings.push(`Config schemaVersion ${String(raw.schemaVersion)} is not ${CONFIG_SCHEMA_VERSION}; unknown keys were ignored.`);
  }
  return base;
}

/** Environment overrides. Documented in docs/CLI.md; used by CI and tests. */
export function applyEnvOverrides(config: DiffWiseConfig, env: NodeJS.ProcessEnv = process.env): DiffWiseConfig {
  const next = structuredClone(config);
  if (env.DIFFWISE_PROVIDER_ID) next.provider.id = oneOf(env.DIFFWISE_PROVIDER_ID, ['openai-compatible', 'anthropic', 'ollama', 'none'] as const, next.provider.id);
  if (env.DIFFWISE_BASE_URL) next.provider.baseUrl = env.DIFFWISE_BASE_URL;
  if (env.DIFFWISE_MODEL) next.provider.model = env.DIFFWISE_MODEL;
  if (env.DIFFWISE_FAST_MODEL) next.provider.fastModel = env.DIFFWISE_FAST_MODEL;
  if (env.DIFFWISE_API_KEY_ENV_VAR) next.provider.apiKeyEnvVar = env.DIFFWISE_API_KEY_ENV_VAR;
  if (env.DIFFWISE_MAX_TOKENS) next.provider.maxTokens = Number(env.DIFFWISE_MAX_TOKENS) || next.provider.maxTokens;
  if (env.DIFFWISE_TIMEOUT_MS) next.provider.timeoutMs = Number(env.DIFFWISE_TIMEOUT_MS) || next.provider.timeoutMs;
  if (env.DIFFWISE_SEND_CONTENT === '1') next.ai.sendRepositoryContent = true;
  if (env.DIFFWISE_AI === 'off') next.ai.enabled = false;
  if (env.DIFFWISE_VERIFY_COMMAND) next.verification.command = env.DIFFWISE_VERIFY_COMMAND;
  if (env.DIFFWISE_FAIL_ON) next.qualityGate.failOn = oneOf(env.DIFFWISE_FAIL_ON, ['critical', 'high', 'medium', 'low', 'info', 'none'] as const, next.qualityGate.failOn);
  if (env.DIFFWISE_MAX_FILES) next.analysis.maxFiles = Number(env.DIFFWISE_MAX_FILES) || next.analysis.maxFiles;
  if (env.DIFFWISE_REVIEWER_TIMEOUT_MS) next.review.timeoutMs = Math.max(10_000, Number(env.DIFFWISE_REVIEWER_TIMEOUT_MS) || next.review.timeoutMs);
  if (env.DIFFWISE_CACHE === 'off') next.cache.enabled = false;
  if (env.DIFFWISE_CACHE_MAX_ENTRIES) next.cache.maxEntries = Math.max(0, Number(env.DIFFWISE_CACHE_MAX_ENTRIES) || next.cache.maxEntries);
  if (env.DIFFWISE_CACHE_TTL_DAYS) next.cache.ttlDays = Math.max(0, Number(env.DIFFWISE_CACHE_TTL_DAYS) || next.cache.ttlDays);
  return next;
}

export async function loadConfig(
  root: string,
  options: { configPath?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<LoadedConfig> {
  const file = options.configPath
    ? (isAbsolute(options.configPath) ? options.configPath : resolve(root, options.configPath))
    : join(root, CONFIG_FILE);
  const warnings: string[] = [];
  let raw: unknown;
  let path: string | undefined;
  try {
    raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
    path = file;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') warnings.push(`Could not read ${file}: ${(err as Error).message}`);
  }
  const config = applyEnvOverrides(normalizeConfig(raw, warnings), options.env);
  return { config, warnings, ...(path ? { path } : {}) };
}

export async function saveConfig(root: string, config: DiffWiseConfig, configPath?: string): Promise<string> {
  const file = configPath ? resolve(root, configPath) : join(root, CONFIG_FILE);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return file;
}

export function analysisSettingsFrom(config: DiffWiseConfig): AnalysisSettings {
  return {
    ...DEFAULT_ANALYSIS_SETTINGS,
    maxFiles: config.analysis.maxFiles,
    maxFileBytes: config.analysis.maxFileBytes,
    ignoreGlobs: config.analysis.ignoreGlobs,
    aiEnabled: config.ai.enabled,
    sendRepositoryContent: config.ai.sendRepositoryContent,
    providerId: config.provider.id,
    model: config.provider.model,
    ...(config.verification.command ? { verificationCommand: config.verification.command } : {}),
  };
}

export interface ResolvedProvider {
  provider?: LlmProvider;
  fastProvider?: LlmProvider;
  apiKeyPresent: boolean;
  /** Why no provider is available, when that is the case. */
  reason?: string;
}

/**
 * Build providers from config. A missing key is not an error: DiffWise reviews
 * deterministically without a model, and says so in the report.
 */
export function resolveProvider(
  config: DiffWiseConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProvider {
  if (!config.ai.enabled) return { apiKeyPresent: false, reason: 'AI is disabled in config (ai.enabled=false).' };
  if (config.provider.id === 'none') return { apiKeyPresent: false, reason: 'provider.id is "none".' };
  const apiKey = env[config.provider.apiKeyEnvVar];
  const needsKey = config.provider.id !== 'ollama';
  if (needsKey && !apiKey) {
    return {
      apiKeyPresent: false,
      reason: `Environment variable ${config.provider.apiKeyEnvVar} is not set; the review runs deterministically without AI.`,
    };
  }
  const base = {
    id: config.provider.id,
    baseUrl: config.provider.baseUrl,
    ...(apiKey ? { apiKey } : {}),
    model: config.provider.model,
    maxTokens: config.provider.maxTokens,
    temperature: config.provider.temperature,
    timeoutMs: config.provider.timeoutMs,
    ...(config.provider.extraHeaders ? { extraHeaders: config.provider.extraHeaders } : {}),
  };
  const provider = createProvider(base);
  const fastModel = config.provider.fastModel?.trim();
  const fastProvider = fastModel && fastModel !== config.provider.model
    ? createProvider({ ...base, model: fastModel })
    : undefined;
  return { provider, apiKeyPresent: Boolean(apiKey), ...(fastProvider ? { fastProvider } : {}) };
}
