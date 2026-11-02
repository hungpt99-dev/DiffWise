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
import type { AnalysisSettings, DocumentationSource, ModelPrice, PriceTable, Severity } from '@diffwise/core';
import { DEFAULT_ANALYSIS_SETTINGS } from '@diffwise/core';
import { PROVIDER_IDS, createProvider, providerDefinition, withFallback, type LlmProvider, type ProviderId } from '@diffwise/ai';

export const CONFIG_SCHEMA_VERSION = 1;
export const CONFIG_FILE = '.diffwise/config.json';

export type QualityGateSeverity = Severity | 'none';

export interface ProviderConfigFile {
  /** Wire protocol, not a vendor: openai covers most gateways. */
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
  /** Azure OpenAI API version. */
  apiVersion?: string;
  /** Azure deployment name, when it differs from the model. */
  deployment?: string;
  /** Profile name used by task routing. The primary block is called `primary`. */
  name?: string;
  /** Human label shown in provider management. */
  label?: string;
  /** A disabled profile stays configured but is never selected. */
  enabled?: boolean;
}

/** A route entry: which provider profile and model a task should use. */
export interface ProviderRouteConfig {
  /** Profile name from `provider` (`primary`) or `providers[]`. */
  provider?: string;
  model?: string;
  /** Profile used when the primary route fails. Explicit opt-in only. */
  fallback?: string;
  /** Refuse cross-provider fallback when repository content is sent. */
  allowCrossProviderFallback?: boolean;
}

export const ROUTE_TASKS = [
  'review', 'security', 'architecture', 'performance', 'database', 'business-logic',
  'api-contract', 'reliability', 'documentation', 'tests', 'maintainability',
  'verify', 'fix', 'chat', 'docs',
] as const;
export type RouteTask = (typeof ROUTE_TASKS)[number];

export interface DiffWiseConfig {
  schemaVersion: number;
  provider: ProviderConfigFile;
  ai: {
    /**
     * When true, a review that could not run its AI stage is partial and the
     * CLI fails it. AI is still not required to install or open the product.
     */
    required: boolean;
    sendRepositoryContent: boolean;
    enabled: boolean;
  };
  /** Model per AI task. Missing entries fall back to `provider.fastModel` / `provider.model`. */
  models?: Partial<Record<RouteTask, string>>;
  /** Additional named provider profiles. `provider` remains the primary. */
  providers?: ProviderConfigFile[];
  /** Per-task provider/model/fallback routing. */
  routing?: Partial<Record<RouteTask, ProviderRouteConfig>>;
  analysis: { maxFiles: number; maxFileBytes: number; ignoreGlobs: string[] };
  verification: { command: string; timeoutMs: number };
  qualityGate: { failOn: QualityGateSeverity };
  /** Content-addressed cache for model answers. */
  cache: { enabled: boolean; maxEntries: number; ttlDays: number };
  /** How long one reviewer may run before it is treated as failed. */
  review: { timeoutMs: number };
  /** Documentation sources connected to this project. */
  documentation?: { sources: DocumentationSource[]; maxSections: number; maxChars: number };
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
  ai: { enabled: true, required: false, sendRepositoryContent: false },
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

function normalizeProviderConfig(
  value: Record<string, unknown>,
  fallback: ProviderConfigFile,
  warnings: string[],
  where: string,
): ProviderConfigFile {
  const next = structuredClone(fallback);
  const id = oneOf(value.id, PROVIDER_IDS, next.id);
  if (value.id !== undefined && !PROVIDER_IDS.includes(value.id as ProviderId)) {
    warnings.push(`${where}.id "${String(value.id)}" is not a known provider; using ${next.id}.`);
  }
  next.id = id;
  const definition = providerDefinition(id);
  const baseUrl = pick(value.baseUrl, '', 'string').trim();
  next.baseUrl = baseUrl || definition.baseUrl || next.baseUrl;
  const model = pick(value.model, next.model, 'string').trim();
  next.model = model || definition.defaultModel || next.model;
  const envVar = pick(value.apiKeyEnvVar, next.apiKeyEnvVar, 'string').trim();
  next.apiKeyEnvVar = envVar || definition.apiKeyEnvVar;
  next.fastModel = pick(value.fastModel, next.fastModel ?? '', 'string');
  next.maxTokens = Math.max(1, pick(value.maxTokens, next.maxTokens, 'number'));
  next.temperature = pick(value.temperature, next.temperature, 'number');
  next.timeoutMs = Math.max(1_000, pick(value.timeoutMs, next.timeoutMs, 'number'));
  next.enabled = pick(value.enabled, next.enabled ?? true, 'boolean');
  if (typeof value.name === 'string' && value.name.trim()) next.name = value.name.trim().replace(/\s+/g, '-');
  if (typeof value.label === 'string') next.label = value.label;
  if (typeof value.apiVersion === 'string') next.apiVersion = value.apiVersion;
  if (typeof value.deployment === 'string') next.deployment = value.deployment;
  if (isObject(value.extraHeaders)) {
    next.extraHeaders = Object.fromEntries(
      Object.entries(value.extraHeaders).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  }
  if (typeof value.apiKey === 'string') {
    warnings.push(`${where}.apiKey must not be stored in config.json; set the environment variable named by ${where}.apiKeyEnvVar instead.`);
  }
  if (definition.requiresBaseUrl && !next.baseUrl) {
    warnings.push(`${where}.baseUrl is required for ${definition.label}; the profile will report a configuration error until it is set.`);
  }
  return next;
}

/** Normalise arbitrary JSON into a config, recording what had to be defaulted. */
export function normalizeConfig(raw: unknown, warnings: string[] = []): DiffWiseConfig {
  const base = structuredClone(DEFAULT_CONFIG);
  if (!isObject(raw)) {
    if (raw !== undefined) warnings.push('Config must be a JSON object; using defaults.');
    return base;
  }
  const provider = isObject(raw.provider) ? raw.provider : {};
  base.provider = normalizeProviderConfig(provider, base.provider, warnings, 'provider');

  if (Array.isArray(raw.providers)) {
    const profiles: ProviderConfigFile[] = [];
    const names = new Set<string>(['primary']);
    for (const [index, entry] of raw.providers.entries()) {
      if (!isObject(entry)) { warnings.push(`providers[${index}] ignored: expected an object.`); continue; }
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      if (!name) { warnings.push(`providers[${index}] ignored: a profile needs a name.`); continue; }
      if (names.has(name)) { warnings.push(`providers[${index}] ignored: duplicate profile name "${name}".`); continue; }
      names.add(name);
      profiles.push(normalizeProviderConfig(entry, { ...base.provider, name }, warnings, `providers.${name}`));
    }
    if (profiles.length > 0) base.providers = profiles;
  }

  const ai = isObject(raw.ai) ? raw.ai : {};
  base.ai.enabled = pick(ai.enabled, base.ai.enabled, 'boolean');
  base.ai.required = pick(ai.required, base.ai.required, 'boolean');
  base.ai.sendRepositoryContent = pick(ai.sendRepositoryContent, base.ai.sendRepositoryContent, 'boolean');

  if (isObject(raw.models)) {
    const models: NonNullable<DiffWiseConfig['models']> = {};
    for (const task of ROUTE_TASKS) {
      const value = raw.models[task];
      if (typeof value === 'string' && value.trim()) models[task] = value.trim();
      else if (value !== undefined) warnings.push(`models.${task} ignored: expected a model name.`);
    }
    if (Object.keys(models).length > 0) base.models = models;
  }

  if (isObject(raw.routing)) {
    const routing: NonNullable<DiffWiseConfig['routing']> = {};
    for (const task of ROUTE_TASKS) {
      const entry = raw.routing[task];
      if (entry === undefined) continue;
      if (!isObject(entry)) { warnings.push(`routing.${task} ignored: expected an object.`); continue; }
      const route: ProviderRouteConfig = {};
      if (typeof entry.provider === 'string' && entry.provider.trim()) route.provider = entry.provider.trim();
      if (typeof entry.model === 'string' && entry.model.trim()) route.model = entry.model.trim();
      if (typeof entry.fallback === 'string' && entry.fallback.trim()) route.fallback = entry.fallback.trim();
      if (typeof entry.allowCrossProviderFallback === 'boolean') route.allowCrossProviderFallback = entry.allowCrossProviderFallback;
      routing[task] = route;
    }
    if (Object.keys(routing).length > 0) base.routing = routing;
  }

  if (isObject(raw.documentation) && Array.isArray(raw.documentation.sources)) {
    const sources: DocumentationSource[] = [];
    for (const [index, entry] of raw.documentation.sources.entries()) {
      if (!isObject(entry)) continue;
      const path = typeof entry.path === 'string' ? entry.path.trim() : '';
      if (!path) { warnings.push(`documentation.sources[${index}] ignored: a path is required.`); continue; }
      const source: DocumentationSource = { path };
      if (typeof entry.category === 'string') source.category = entry.category as DocumentationSource['category'];
      if (typeof entry.priority === 'number' && Number.isFinite(entry.priority)) source.priority = Math.trunc(entry.priority);
      if (typeof entry.enabled === 'boolean') source.enabled = entry.enabled;
      if (Array.isArray(entry.modules)) source.modules = entry.modules.filter((m): m is string => typeof m === 'string');
      sources.push(source);
    }
    base.documentation = {
      sources,
      maxSections: Math.max(1, pick(raw.documentation.maxSections, 6, 'number')),
      maxChars: Math.max(400, pick(raw.documentation.maxChars, 6_000, 'number')),
    };
  }

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
  if (env.DIFFWISE_AI_REQUIRED === '1') next.ai.required = true;
  if (env.DIFFWISE_AI_REQUIRED === '0') next.ai.required = false;
  for (const task of ['review', 'verify', 'fix', 'chat'] as const) {
    const value = env[`DIFFWISE_MODEL_${task.toUpperCase()}`];
    if (value) next.models = { ...(next.models ?? {}), [task]: value };
  }
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

export type AiTask = 'review' | 'verify' | 'fix' | 'chat';

export interface ResolvedProvider {
  provider?: LlmProvider;
  fastProvider?: LlmProvider;
  apiKeyPresent: boolean;
  /** Model chosen per task, after routing. */
  models?: Partial<Record<RouteTask, string>>;
  /** Provider instance per execution task; tasks sharing a model share an instance. */
  tasks?: Partial<Record<AiTask, LlmProvider>>;
  /** Reviewer-specific models, from routing/models. */
  reviewerModels?: Partial<Record<RouteTask, string>>;
  /** Per-task fallback state, recorded so a silent switch is impossible. */
  routes?: Partial<Record<RouteTask, { provider: string; model: string; fallback?: string }>>;
  /** Why no provider is available, when that is the case. */
  reason?: string;
}

function providerFromProfile(profile: ProviderConfigFile, model: string, env: NodeJS.ProcessEnv): { provider?: LlmProvider; reason?: string } {
  const definition = providerDefinition(profile.id);
  if (profile.id === 'none') return { reason: 'provider.id is "none".' };
  if (profile.enabled === false) return { reason: `provider profile "${profile.name ?? 'primary'}" is disabled.` };
  const apiKey = profile.apiKeyEnvVar ? env[profile.apiKeyEnvVar] : undefined;
  if (definition.needsKey && !apiKey) {
    return {
      reason: `Environment variable ${profile.apiKeyEnvVar || '(none)'} is not set for provider "${profile.name ?? 'primary'}" (${definition.label}).`,
    };
  }
  if (definition.requiresBaseUrl && !profile.baseUrl) {
    return { reason: `Provider "${profile.name ?? 'primary'}" (${definition.label}) needs a base URL.` };
  }
  try {
    return {
      provider: createProvider({
        id: profile.id,
        baseUrl: profile.baseUrl,
        ...(apiKey ? { apiKey } : {}),
        model: model || profile.model,
        maxTokens: profile.maxTokens,
        temperature: profile.temperature,
        timeoutMs: profile.timeoutMs,
        ...(profile.extraHeaders ? { extraHeaders: profile.extraHeaders } : {}),
        ...(profile.apiVersion ? { apiVersion: profile.apiVersion } : {}),
        ...(profile.deployment ? { deployment: profile.deployment } : {}),
        ...(profile.label ? { label: profile.label } : {}),
      }),
    };
  } catch (err) {
    return { reason: `Provider "${profile.name ?? 'primary'}" could not be created: ${(err as Error).message}` };
  }
}

/**
 * Build providers from configuration.
 *
 * The primary block is still the default; named profiles and task routing are
 * additive. A missing key is not an error: DiffWise reviews deterministically
 * without a model and says so. Fallback is only used when a route explicitly
 * names a fallback profile — and refused across providers when repository
 * content is being sent without explicit permission.
 */
export function resolveProvider(
  config: DiffWiseConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProvider {
  if (!config.ai.enabled) return { apiKeyPresent: false, reason: 'AI is disabled in config (ai.enabled=false).' };
  if (config.provider.id === 'none') return { apiKeyPresent: false, reason: 'provider.id is "none".' };

  const profiles = new Map<string, ProviderConfigFile>();
  profiles.set('primary', { ...config.provider, name: 'primary' });
  for (const profile of config.providers ?? []) {
    if (!profile.name) continue;
    profiles.set(profile.name, profile);
  }

  const reasons: string[] = [];
  let apiKeyPresent = false;
  for (const profile of profiles.values()) {
    if (profile.apiKeyEnvVar && env[profile.apiKeyEnvVar]) apiKeyPresent = true;
  }

  const instances = new Map<string, LlmProvider | null>();
  const failure = new Map<string, string>();
  const instanceFor = (profileName: string, model: string): LlmProvider | undefined => {
    const profile = profiles.get(profileName);
    if (!profile) {
      failure.set(profileName, `route names unknown provider profile "${profileName}".`);
      return undefined;
    }
    const key = `${profileName}::${model || profile.model}`;
    if (instances.has(key)) {
      const existing = instances.get(key);
      if (existing) return existing;
      return undefined;
    }
    const built = providerFromProfile(profile, model, env);
    instances.set(key, built.provider ?? null);
    if (!built.provider && built.reason) failure.set(profileName, built.reason);
    return built.provider;
  };

  const routeFor = (task: RouteTask): { provider: string; model: string; fallback?: string; fallbackProvider?: LlmProvider } => {
    const route = config.routing?.[task];
    const profileName = route?.provider ?? 'primary';
    const profile = profiles.get(profileName) ?? config.provider;
    const fast = config.provider.fastModel?.trim();
    const model = route?.model
      ?? config.models?.[task]?.trim()
      ?? (task === 'review' || task === 'security' || task === 'architecture' || task === 'database' || task === 'business-logic' || task === 'api-contract' || task === 'reliability' || task === 'maintainability'
        ? profile.model
        : (fast || profile.model));
    const fallbackName = route?.fallback;
    const fallbackProfile = fallbackName ? profiles.get(fallbackName) : undefined;
    const sameProvider = fallbackProfile && fallbackProfile.id === profile.id && fallbackProfile.baseUrl === profile.baseUrl;
    const crossProvider = fallbackProfile && !sameProvider;
    const contentLeaves = config.ai.sendRepositoryContent;
    const fallbackAllowed = Boolean(fallbackProfile)
      && (!crossProvider || route?.allowCrossProviderFallback === true || !contentLeaves);
    const fallbackProvider = fallbackAllowed && fallbackProfile
      ? instanceFor(fallbackName ?? '', profiles.get(fallbackName ?? '')?.model ?? model)
      : undefined;
    if (fallbackName && fallbackProfile && !fallbackAllowed) {
      failure.set(`fallback:${task}`, `fallback from "${profileName}" to "${fallbackName}" refused: repository content is sent to providers and routing.${task}.allowCrossProviderFallback is not true.`);
    }
    return { provider: profileName, model, ...(fallbackName ? { fallback: fallbackName } : {}), ...(fallbackProvider ? { fallbackProvider } : {}) };
  };

  const models: Partial<Record<RouteTask, string>> = {};
  const routes: Partial<Record<RouteTask, { provider: string; model: string; fallback?: string }>> = {};
  const tasks: Partial<Record<AiTask, LlmProvider>> = {};
  const reviewerModels: Partial<Record<RouteTask, string>> = {};

  const build = (task: RouteTask): LlmProvider | undefined => {
    const route = routeFor(task);
    models[task] = route.model;
    routes[task] = { provider: route.provider, model: route.model, ...(route.fallback ? { fallback: route.fallback } : {}) };
    const primary = instanceFor(route.provider, route.model);
    if (!primary) return undefined;
    return withFallback(primary, route.fallbackProvider, (reason) => {
      failure.set(`fallback-used:${task}`, `${route.provider} failed (${reason}); ${route.fallback ?? 'fallback'} answered.`);
    });
  };

  for (const task of ['review', 'verify', 'fix', 'chat'] as const) {
    const instance = build(task);
    if (instance) tasks[task] = instance;
  }
  for (const task of ROUTE_TASKS) {
    if (task === 'review' || task === 'verify' || task === 'fix' || task === 'chat') continue;
    const instance = build(task);
    if (instance) {
      // Reviewer-specific instances are exposed through the same task map and
      // through model names; the review session selects by reviewer id.
      reviewerModels[task] = models[task];
      tasks[task as AiTask] = instance;
    }
  }

  if (!tasks.review) {
    const why = [...new Set([...failure.values(), ...reasons])].join(' ');
    return {
      apiKeyPresent,
      ...(Object.keys(models).length ? { models } : {}),
      ...(Object.keys(routes).length ? { routes } : {}),
      reason: why || 'No usable AI provider was configured; the review runs deterministically.',
    };
  }

  return {
    provider: tasks.review,
    ...(tasks.verify ?? tasks.fix ?? tasks.chat ? { fastProvider: tasks.verify ?? tasks.fix ?? tasks.chat } : {}),
    apiKeyPresent,
    ...(Object.keys(models).length ? { models } : {}),
    ...(Object.keys(reviewerModels).length ? { reviewerModels } : {}),
    ...(Object.keys(routes).length ? { routes } : {}),
    ...(failure.size ? { reason: [...failure.values()].join(' ') } : {}),
    tasks,
  };
}
