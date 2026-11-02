/**
 * Provider registry.
 *
 * A provider is a wire protocol plus defaults, not a new code path. Most vendors
 * expose an OpenAI-compatible chat-completions API; Anthropic and Gemini have
 * their own shapes. Declaring that here is what keeps provider-specific logic
 * out of the review pipeline and makes an unsupported vendor an explicit error
 * instead of a half-working adapter.
 */
import type { ProviderId } from './types';

export type ProviderProtocol = 'openai' | 'anthropic' | 'gemini' | 'azure-openai' | 'bedrock-openai' | 'none';

export interface ProviderDefinition {
  id: ProviderId;
  label: string;
  protocol: ProviderProtocol;
  /** Default endpoint. Empty when the user must supply one. */
  baseUrl: string;
  /** Default environment variable holding the key, when a key is required. */
  apiKeyEnvVar: string;
  needsKey: boolean;
  /** Default model, only where a stable cheap model exists. */
  defaultModel?: string;
  /** What this adapter actually supports. Never universal feature claims. */
  capabilities: {
    chat: true;
    jsonMode: boolean;
    streaming: false;
    /** Context window is model-specific; the registry leaves it to the model. */
    contextWindow: 'model' | number;
  };
  /** Extra headers the vendor requires (e.g. Anthropic version). */
  headers?: Record<string, string>;
  /** Human notes shown in provider management. */
  notes?: string;
  /** True when the endpoint is assembled from region/project settings. */
  requiresBaseUrl?: boolean;
}

const OPENAI_JSON: ProviderDefinition['capabilities'] = { chat: true, jsonMode: true, streaming: false, contextWindow: 'model' };

export const PROVIDERS: Record<ProviderId, ProviderDefinition> = {
  openai: {
    id: 'openai', label: 'OpenAI', protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1', apiKeyEnvVar: 'OPENAI_API_KEY', needsKey: true,
    defaultModel: 'gpt-4o-mini', capabilities: OPENAI_JSON,
  },
  anthropic: {
    id: 'anthropic', label: 'Anthropic', protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com', apiKeyEnvVar: 'ANTHROPIC_API_KEY', needsKey: true,
    defaultModel: 'claude-3-5-sonnet-latest',
    capabilities: { chat: true, jsonMode: false, streaming: false, contextWindow: 'model' },
    headers: { 'anthropic-version': '2023-06-01' },
  },
  google: {
    id: 'google', label: 'Google Gemini', protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKeyEnvVar: 'GEMINI_API_KEY', needsKey: true,
    defaultModel: 'gemini-1.5-flash',
    capabilities: { chat: true, jsonMode: true, streaming: false, contextWindow: 'model' },
  },
  deepseek: {
    id: 'deepseek', label: 'DeepSeek', protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1', apiKeyEnvVar: 'DEEPSEEK_API_KEY', needsKey: true,
    defaultModel: 'deepseek-chat', capabilities: OPENAI_JSON,
  },
  mistral: {
    id: 'mistral', label: 'Mistral', protocol: 'openai',
    baseUrl: 'https://api.mistral.ai/v1', apiKeyEnvVar: 'MISTRAL_API_KEY', needsKey: true,
    defaultModel: 'mistral-large-latest', capabilities: OPENAI_JSON,
  },
  openrouter: {
    id: 'openrouter', label: 'OpenRouter', protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnvVar: 'OPENROUTER_API_KEY', needsKey: true,
    capabilities: OPENAI_JSON,
    notes: 'Model is a gateway identifier such as anthropic/claude-3.5-sonnet.',
  },
  groq: {
    id: 'groq', label: 'Groq', protocol: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnvVar: 'GROQ_API_KEY', needsKey: true,
    capabilities: OPENAI_JSON,
  },
  together: {
    id: 'together', label: 'Together AI', protocol: 'openai',
    baseUrl: 'https://api.together.xyz/v1', apiKeyEnvVar: 'TOGETHER_API_KEY', needsKey: true,
    capabilities: OPENAI_JSON,
  },
  fireworks: {
    id: 'fireworks', label: 'Fireworks AI', protocol: 'openai',
    baseUrl: 'https://api.fireworks.ai/inference/v1', apiKeyEnvVar: 'FIREWORKS_API_KEY', needsKey: true,
    capabilities: OPENAI_JSON,
  },
  'azure-openai': {
    id: 'azure-openai', label: 'Azure OpenAI', protocol: 'azure-openai',
    baseUrl: '', apiKeyEnvVar: 'AZURE_OPENAI_API_KEY', needsKey: true,
    capabilities: OPENAI_JSON, requiresBaseUrl: true,
    notes: 'Base URL is the resource endpoint (https://<resource>.openai.azure.com). The model is the deployment name; api-version defaults to 2024-10-21.',
  },
  'aws-bedrock': {
    id: 'aws-bedrock', label: 'AWS Bedrock', protocol: 'bedrock-openai',
    baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1', apiKeyEnvVar: 'AWS_BEARER_TOKEN_BEDROCK', needsKey: true,
    capabilities: OPENAI_JSON, requiresBaseUrl: true,
    notes: 'Uses Bedrock\'s OpenAI-compatible endpoint with a Bedrock API key. Change the region in the base URL. SigV4-only deployments are not supported.',
  },
  'google-vertex': {
    id: 'google-vertex', label: 'Google Vertex AI', protocol: 'openai',
    baseUrl: '', apiKeyEnvVar: 'GOOGLE_VERTEX_TOKEN', needsKey: true,
    capabilities: OPENAI_JSON, requiresBaseUrl: true,
    notes: 'Base URL is the project/location OpenAI-compatible endpoint. The token is an OAuth access token (or an API key, where enabled); DiffWise does not mint Google credentials.',
  },
  ollama: {
    id: 'ollama', label: 'Ollama (local)', protocol: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1', apiKeyEnvVar: '', needsKey: false,
    defaultModel: 'qwen2.5-coder:7b', capabilities: OPENAI_JSON,
  },
  lmstudio: {
    id: 'lmstudio', label: 'LM Studio (local)', protocol: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1', apiKeyEnvVar: '', needsKey: false,
    capabilities: OPENAI_JSON,
  },
  vllm: {
    id: 'vllm', label: 'vLLM (self-hosted)', protocol: 'openai',
    baseUrl: 'http://127.0.0.1:8000/v1', apiKeyEnvVar: 'VLLM_API_KEY', needsKey: false,
    capabilities: OPENAI_JSON,
  },
  'openai-compatible': {
    id: 'openai-compatible', label: 'OpenAI-compatible', protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1', apiKeyEnvVar: 'DIFFWISE_API_KEY', needsKey: true,
    defaultModel: 'gpt-4o-mini', capabilities: OPENAI_JSON,
    notes: 'Generic endpoint for gateways and internal proxies.',
  },
  custom: {
    id: 'custom', label: 'Custom provider', protocol: 'openai',
    baseUrl: '', apiKeyEnvVar: 'DIFFWISE_CUSTOM_API_KEY', needsKey: false,
    capabilities: OPENAI_JSON, requiresBaseUrl: true,
    notes: 'Any OpenAI-compatible endpoint with custom headers and model identifier.',
  },
  none: {
    id: 'none', label: 'No provider', protocol: 'none', baseUrl: '', apiKeyEnvVar: '', needsKey: false,
    capabilities: { chat: true, jsonMode: false, streaming: false, contextWindow: 'model' },
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function providerDefinition(id: ProviderId): ProviderDefinition {
  return PROVIDERS[id] ?? PROVIDERS['openai-compatible'];
}

/** Vendor ids whose adapters are implemented and verified by tests. */
export function implementedProviderIds(): ProviderId[] {
  return PROVIDER_IDS.filter((id) => id !== 'none');
}

/** Resolve a partial configuration into a complete provider config. */
export function withProviderDefaults(input: {
  id: ProviderId;
  baseUrl?: string;
  model?: string;
  apiKeyEnvVar?: string;
}): { id: ProviderId; baseUrl: string; model: string; apiKeyEnvVar: string; label: string; notes?: string; needsKey: boolean } {
  const definition = providerDefinition(input.id);
  return {
    id: definition.id,
    baseUrl: input.baseUrl?.trim() || definition.baseUrl,
    model: input.model?.trim() || definition.defaultModel || '',
    apiKeyEnvVar: input.apiKeyEnvVar?.trim() || definition.apiKeyEnvVar,
    label: definition.label,
    ...(definition.notes ? { notes: definition.notes } : {}),
    needsKey: definition.needsKey,
  };
}
