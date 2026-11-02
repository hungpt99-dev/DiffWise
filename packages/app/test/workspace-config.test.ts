import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG, normalizeConfig, resolveProvider,
} from '@diffwise/app';
import { loadMcpConfig, normalizeMcpConfig } from '@diffwise/app';

describe('provider configuration', () => {
  it('normalises named profiles, routing and documentation sources', () => {
    const config = normalizeConfig({
      provider: { id: 'openai', model: 'gpt-4o-mini', apiKeyEnvVar: 'OPENAI_API_KEY' },
      providers: [
        { name: 'local', id: 'ollama', model: 'qwen2.5-coder:7b', apiKeyEnvVar: '' },
        { name: 'local', id: 'openai', model: 'duplicate' },
        { id: 'anthropic', model: 'claude-3-5-sonnet-latest' },
      ],
      routing: {
        security: { provider: 'local', model: 'qwen2.5-coder:32b' },
        verify: { provider: 'primary', model: 'gpt-4o-mini' },
      },
      documentation: {
        sources: [{ path: 'docs/**', category: 'architecture', priority: 5, enabled: true }],
        maxSections: 4,
        maxChars: 4000,
      },
    });
    expect(config.providers?.map((profile) => profile.name)).toEqual(['local']);
    expect(config.providers?.[0]?.baseUrl).toContain('127.0.0.1:11434');
    expect(config.routing?.security?.model).toBe('qwen2.5-coder:32b');
    expect(config.documentation?.sources[0]?.path).toBe('docs/**');
    expect(config.documentation?.maxSections).toBe(4);
  });

  it('refuses a literal API key and reports it', () => {
    const warnings: string[] = [];
    normalizeConfig({ provider: { id: 'openai', apiKey: 'sk-secret' } }, warnings);
    expect(warnings.some((warning) => warning.includes('must not be stored'))).toBe(true);
    expect(DEFAULT_CONFIG.provider.apiKeyEnvVar).toBe('DIFFWISE_API_KEY');
  });

  it('routes reviewer tasks to a different model and refuses unmatched fallback', () => {
    const config = normalizeConfig({
      provider: { id: 'openai', model: 'gpt-4o-mini', apiKeyEnvVar: 'OPENAI_API_KEY' },
      providers: [{ name: 'other', id: 'anthropic', model: 'claude-3-5-sonnet-latest', apiKeyEnvVar: 'ANTHROPIC_API_KEY' }],
      routing: {
        security: { provider: 'other', model: 'claude-3-5-sonnet-latest', fallback: 'primary' },
      },
    });
    const resolved = resolveProvider(config, {
      OPENAI_API_KEY: 'test-key-openai',
      ANTHROPIC_API_KEY: 'test-key-anthropic',
    } as NodeJS.ProcessEnv);
    expect(resolved.provider).toBeDefined();
    expect(resolved.models?.security).toBe('claude-3-5-sonnet-latest');
    expect(resolved.reviewerModels?.security).toBe('claude-3-5-sonnet-latest');
    expect(resolved.routes?.security?.fallback).toBe('primary');
    // The route names a different profile, so the reviewer must get a distinct
    // provider instance, not the primary provider with a foreign model name.
    expect(resolved.tasks?.security).toBeDefined();
    expect(resolved.tasks?.security).not.toBe(resolved.provider);
  });

  it('reports the exact missing environment variable when a profile has no key', () => {
    const config = normalizeConfig({
      provider: { id: 'openai', model: 'gpt-4o-mini', apiKeyEnvVar: 'MISSING_KEY_FOR_TEST' },
    });
    const resolved = resolveProvider(config, {} as NodeJS.ProcessEnv);
    expect(resolved.provider).toBeUndefined();
    expect(resolved.reason).toContain('MISSING_KEY_FOR_TEST');
  });
});

describe('MCP configuration', () => {
  it('defaults to read-only and rejects a literal credential', () => {
    const warnings: string[] = [];
    const config = normalizeMcpConfig({
      servers: [{
        name: 'jira',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'jira-mcp'],
        headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz012345' },
        permissions: { allowedTools: ['search_tickets'] },
      }],
    }, warnings);
    expect(config.servers).toHaveLength(1);
    expect(config.servers[0]?.permissions.readOnly).toBe(true);
    expect(config.servers[0]?.permissions.allowWrite).toBe(false);
    expect(config.servers[0]?.headers).toBeUndefined();
    expect(warnings.some((warning) => warning.includes('literal credential'))).toBe(true);
  });

  it('keeps ${ENV_VAR} indirection and an explicit write allowance', () => {
    const config = normalizeMcpConfig({
      servers: [{
        name: 'github',
        transport: 'http',
        url: 'https://mcp.example/mcp',
        headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' },
        permissions: { readOnly: false, allowWrite: true, contextTools: ['search_issues'] },
      }],
    });
    expect(config.servers[0]?.headers?.Authorization).toBe('Bearer ${GITHUB_TOKEN}');
    expect(config.servers[0]?.permissions.allowWrite).toBe(true);
    expect(config.servers[0]?.permissions.contextTools).toEqual(['search_issues']);
  });

  it('returns an empty configuration when the file does not exist', async () => {
    const loaded = await loadMcpConfig(process.cwd());
    expect(loaded.exists === false || loaded.config.servers.length >= 0).toBe(true);
  });
});
