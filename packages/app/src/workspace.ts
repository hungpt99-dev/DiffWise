/**
 * Workspace configuration services.
 *
 * One place that reads and writes the four configuration surfaces the product
 * exposes — rules, documentation sources, MCP connections and AI providers —
 * so the VS Code extension, the CLI and tests perform the same validated
 * operation. No interface edits YAML by hand or invents its own schema.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GitClient, RULES, RULE_CATEGORY_META, RuleStore, buildDocumentationIndex, documentationIndexSummary,
  listRules, readRepositoryFiles, testRule, detectRuleConflicts, loadRepositoryRulePacks,
  type DocumentationSource, type ManagedRule, type RuleDraft, type RuleTestResult, type RuleValidationIssue,
} from '@diffwise/core';
import {
  ROUTE_TASKS, loadConfig, saveConfig, type DiffWiseConfig, type ProviderConfigFile,
  type RouteTask,
} from './config';
import {
  loadMcpConfig, saveMcpConfig, McpManager, emptyPermissions,
  type McpConfig, McpServerConfig, McpServerStatus, McpToolInfo,
} from './mcp';
import { buildPlatform } from './orchestrate';

export interface ProviderSummary {
  name: string;
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  fastModel?: string;
  apiKeyEnvVar: string;
  apiKeyPresent: boolean;
  enabled: boolean;
  primary: boolean;
  capabilities?: { chat: boolean; jsonMode: boolean; streaming: boolean; maxContextTokens?: number };
}

export interface WorkspaceState {
  rules: {
    custom: ManagedRule[];
    builtin: ReturnType<typeof listRules>;
    issues: RuleValidationIssue[];
    conflicts: ReturnType<typeof detectRuleConflicts>;
    categories: typeof import('@diffwise/core').RULE_CATEGORY_META;
    /** Effective policy and where each override came from. */
    policy: {
      layers: Array<{ kind: string; source: string; appliesTo: string; loaded: boolean; error?: string }>;
      provenance: Record<string, string>;
      minSeverity: string;
      ruleOverrides: number;
      warnings: string[];
    };
  };
  documentation: {
    sources: DocumentationSource[];
    maxSections: number;
    maxChars: number;
    indexed: { documents: number; sections: number; bytes: number; duplicates: number; categories: Record<string, number> } | null;
    indexedAt?: string;
  };
  mcp: {
    path: string;
    exists: boolean;
    servers: Array<McpServerConfig & { status?: 'unknown' }>;
    warnings: string[];
    statuses?: McpServerStatus[];
    tools?: McpToolInfo[];
  };
  providers: {
    profiles: ProviderSummary[];
    routing: DiffWiseConfig['routing'];
    models: DiffWiseConfig['models'];
    ai: { enabled: boolean; required: boolean; sendRepositoryContent: boolean };
    warnings: string[];
    tasks: readonly RouteTask[];
  };
}

/** Read the whole workspace configuration without connecting to anything. */
export async function loadWorkspaceState(root: string, config?: DiffWiseConfig): Promise<WorkspaceState> {
  const loaded = config ? { config, warnings: [] as string[] } : await loadConfig(root);
  const ruleStore = new RuleStore({ root });
  const custom = await ruleStore.list();
  const packs = await loadRepositoryRulePacks(root);
  const platform = await buildPlatform({ root, env: {} });
  const descriptors = listRules({ builtinRules: RULES, packs: platform.rulePacks, policy: platform.policy });
  const mcp = await loadMcpConfig(root);
  const profiles: ProviderSummary[] = [];
  const addProfile = (profile: ProviderConfigFile, primary: boolean): void => {
    const name = profile.name ?? (primary ? 'primary' : 'provider');
    profiles.push({
      name,
      id: profile.id,
      label: profile.label ?? providerLabel(profile.id),
      baseUrl: profile.baseUrl,
      model: profile.model,
      ...(profile.fastModel ? { fastModel: profile.fastModel } : {}),
      apiKeyEnvVar: profile.apiKeyEnvVar,
      apiKeyPresent: Boolean(profile.apiKeyEnvVar && process.env[profile.apiKeyEnvVar]),
      enabled: profile.enabled !== false,
      primary,
    });
  };
  addProfile(loaded.config.provider, true);
  for (const profile of loaded.config.providers ?? []) addProfile(profile, false);

  // Indexing the documentation tree on every panel load would make the panel
  // slow on a large repository. It is attempted, bounded, and reported as
  // absent rather than guessed when it fails.
  let documentation: WorkspaceState['documentation'] = {
    sources: loaded.config.documentation?.sources ?? [],
    maxSections: loaded.config.documentation?.maxSections ?? 6,
    maxChars: loaded.config.documentation?.maxChars ?? 6_000,
    indexed: null,
  };
  try {
    const git = new GitClient(root, {});
    const paths = await git.listWorktreeFiles();
    const files = await readRepositoryFiles({
      root,
      paths: paths.filter((path) => /\.(md|mdx|markdown|adoc|asciidoc|rst|txt|ya?ml|json|proto|sql)$/i.test(path)).slice(0, 2_000),
      maxFiles: 400,
    });
    const { buildDocumentationIndex: buildIndex } = { buildDocumentationIndex };
    const index = buildIndex({ files, sources: loaded.config.documentation?.sources });
    const summary = documentationIndexSummary(index);
    documentation = { ...documentation, indexed: summary, indexedAt: summary.generatedAt };
  } catch {
    // A repository without a worktree is still configurable.
  }

  return {
    rules: {
      custom: custom.rules,
      builtin: descriptors,
      issues: [...custom.issues, ...packIssues(packs)],
      conflicts: detectRuleConflicts({
        builtinIds: RULES.map((rule) => rule.id),
        packs: packs.packs,
        policy: {
          enable: platform.policy.rules.enable,
          severityOverride: platform.policy.rules.severityOverride,
          suppress: platform.policy.rules.suppress.map((entry) => ({ ruleId: entry.ruleId })),
        },
      }),
      categories: RULE_CATEGORY_META,
      policy: {
        layers: platform.policySnapshot.layers.map((layer) => ({
          kind: layer.kind, source: layer.source, appliesTo: layer.appliesTo, loaded: layer.loaded,
          ...(layer.error ? { error: layer.error } : {}),
        })),
        provenance: platform.policySnapshot.provenance,
        minSeverity: platform.policy.rules.minSeverity,
        ruleOverrides: Object.keys(platform.policy.rules.enable).length
          + Object.keys(platform.policy.rules.severityOverride).length
          + platform.policy.rules.suppress.length,
        warnings: platform.policySnapshot.warnings,
      },
    },
    documentation,
    mcp: {
      path: mcp.path,
      exists: mcp.exists,
      servers: mcp.config.servers,
      warnings: [...mcp.warnings, ...loaded.warnings],
    },
    providers: {
      profiles,
      routing: loaded.config.routing,
      models: loaded.config.models,
      ai: loaded.config.ai,
      warnings: loaded.warnings,
      tasks: ROUTE_TASKS,
    },
  };
}

function packIssues(packs: Awaited<ReturnType<typeof loadRepositoryRulePacks>>): RuleValidationIssue[] {
  return packs.packs.flatMap((pack) => pack.issues);
}

function providerLabel(id: string): string {
  return id.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

export async function createOrUpdateRule(root: string, draft: RuleDraft, mode: 'create' | 'update' = 'create'): Promise<{ rule?: ManagedRule; issues: RuleValidationIssue[] }> {
  const store = new RuleStore({ root });
  return mode === 'update' ? store.update(draft.id, draft) : store.create(draft);
}

export async function deleteRule(root: string, id: string): Promise<{ removed: boolean; issues: RuleValidationIssue[] }> {
  return new RuleStore({ root }).remove(id);
}

export async function setRuleEnabled(root: string, id: string, enabled: boolean): Promise<{ rule?: ManagedRule; issues: RuleValidationIssue[] }> {
  return new RuleStore({ root }).setEnabled(id, enabled);
}

/** Test a draft or an existing rule against the working tree. */
export async function testRuleAgainstRepository(root: string, draft: RuleDraft, maxFiles = 400): Promise<RuleTestResult> {
  const git = new GitClient(root, {});
  const paths = (await git.listWorktreeFiles()).filter((path) => !/(^|\/)(node_modules|\.git|dist|build|coverage)\//.test(path));
  const files = await readRepositoryFiles({ root, paths, maxFiles, maxFileBytes: 300_000 });
  return testRule(draft, { files, maxFiles });
}

export async function importRules(root: string, source: string): Promise<{ imported: ManagedRule[]; issues: RuleValidationIssue[] }> {
  return new RuleStore({ root }).import(source);
}

export async function exportRules(root: string, id?: string): Promise<{ yaml: string; count: number }> {
  return new RuleStore({ root }).export(id);
}

export async function saveDocumentationSources(
  root: string,
  sources: DocumentationSource[],
  options: { maxSections?: number; maxChars?: number } = {},
): Promise<DiffWiseConfig> {
  const { config } = await loadConfig(root);
  const next: DiffWiseConfig = {
    ...config,
    documentation: {
      sources,
      maxSections: options.maxSections ?? config.documentation?.maxSections ?? 6,
      maxChars: options.maxChars ?? config.documentation?.maxChars ?? 6_000,
    },
  };
  await saveConfig(root, next);
  return next;
}

export async function listMcpStatus(root: string): Promise<{ statuses: McpServerStatus[]; warnings: string[] }> {
  const loaded = await loadMcpConfig(root);
  if (loaded.config.servers.length === 0) return { statuses: [], warnings: loaded.warnings };
  const manager = new McpManager(root, loaded.config);
  try {
    return { statuses: await manager.status(), warnings: loaded.warnings };
  } finally {
    manager.close();
  }
}

export async function listMcpTools(root: string, server: string): Promise<{ tools: McpToolInfo[]; error?: string }> {
  const loaded = await loadMcpConfig(root);
  const manager = new McpManager(root, loaded.config);
  try {
    return { tools: await manager.listTools(server) };
  } catch (err) {
    return { tools: [], error: (err as Error).message };
  } finally {
    manager.close();
  }
}

export async function testMcpServer(root: string, server: string): Promise<McpServerStatus | { error: string }> {
  const loaded = await loadMcpConfig(root);
  const manager = new McpManager(root, loaded.config);
  try {
    const statuses = await manager.status();
    return statuses.find((entry) => entry.name === server) ?? { error: `Unknown MCP server "${server}".` };
  } finally {
    manager.close();
  }
}

export async function upsertMcpServer(root: string, input: Partial<McpServerConfig> & { name: string }): Promise<{ config: McpConfig; warnings: string[] }> {
  const loaded = await loadMcpConfig(root);
  const servers = [...loaded.config.servers];
  const index = servers.findIndex((server) => server.name === input.name);
  const base: McpServerConfig = index >= 0
    ? servers[index]!
    : {
      name: input.name,
      transport: input.transport ?? 'stdio',
      enabled: true,
      permissions: emptyPermissions(),
    };
  const next: McpServerConfig = {
    ...base,
    ...input,
    name: input.name,
    permissions: { ...base.permissions, ...(input.permissions ?? {}) },
    ...(input.context ? { context: input.context } : {}),
  };
  // A configured context tool is useless unless it is also permitted for
  // context; keep the two in sync instead of silently skipping the call.
  if (next.context?.tool && !next.permissions.contextTools.includes(next.context.tool)) {
    next.permissions.contextTools = [...next.permissions.contextTools, next.context.tool];
  }
  // A write-capable tool permission is only meaningful with allowWrite; the
  // permission model is normalised here so a config edited by hand cannot
  // smuggle in an implicit write path.
  if (!next.permissions.allowWrite) next.permissions.readOnly = true;
  if (index >= 0) servers[index] = next;
  else servers.push(next);
  const config: McpConfig = { schemaVersion: loaded.config.schemaVersion, servers };
  await saveMcpConfig(root, config);
  return { config, warnings: loaded.warnings };
}

export async function removeMcpServer(root: string, name: string): Promise<McpConfig> {
  const loaded = await loadMcpConfig(root);
  const config: McpConfig = {
    schemaVersion: loaded.config.schemaVersion,
    servers: loaded.config.servers.filter((server) => server.name !== name),
  };
  await saveMcpConfig(root, config);
  return config;
}

export async function setMcpEnabled(root: string, name: string, enabled: boolean): Promise<McpConfig> {
  const loaded = await loadMcpConfig(root);
  const config: McpConfig = {
    schemaVersion: loaded.config.schemaVersion,
    servers: loaded.config.servers.map((server) => (server.name === name ? { ...server, enabled } : server)),
  };
  await saveMcpConfig(root, config);
  return config;
}

export async function callMcpTool(
  root: string,
  server: string,
  tool: string,
  args: Record<string, unknown>,
  options: { approved?: boolean } = {},
): Promise<{ ok: boolean; text: string; error?: string; truncated?: boolean }> {
  const loaded = await loadMcpConfig(root);
  const manager = new McpManager(root, loaded.config);
  try {
    const result = await manager.callTool(server, tool, args, options);
    return { ok: result.ok, text: result.text, ...(result.error ? { error: result.error } : {}), truncated: result.truncated };
  } finally {
    manager.close();
  }
}

export async function saveProviderProfile(
  root: string,
  profile: ProviderConfigFile & { name: string },
  options: { primary?: boolean } = {},
): Promise<DiffWiseConfig> {
  const { config, warnings } = await loadConfig(root);
  if (options.primary || profile.name === 'primary') {
    // Merge onto the existing primary so a form that omits an optional field
    // (fastModel, deployment, headers) does not erase it.
    const merged: ProviderConfigFile = { ...config.provider, ...profile, name: undefined };
    const next: DiffWiseConfig = { ...config, provider: merged };
    await saveConfig(root, next);
    return next;
  }
  const profiles = [...(config.providers ?? [])];
  const index = profiles.findIndex((entry) => entry.name === profile.name);
  const merged: ProviderConfigFile = { ...(index >= 0 ? profiles[index] : config.provider), ...profile, name: profile.name };
  if (index >= 0) profiles[index] = merged;
  else profiles.push(merged);
  if (profiles.length > 20) throw new Error(`Too many provider profiles (${profiles.length}); remove one first. ${warnings.join(' ')}`);
  const next: DiffWiseConfig = { ...config, providers: profiles };
  await saveConfig(root, next);
  return next;
}

export async function removeProviderProfile(root: string, name: string): Promise<DiffWiseConfig> {
  const { config } = await loadConfig(root);
  if (name === 'primary') throw new Error('The primary provider cannot be removed; replace its configuration instead.');
  const providers = (config.providers ?? []).filter((profile) => profile.name !== name);
  const routing = { ...(config.routing ?? {}) };
  for (const task of Object.keys(routing) as RouteTask[]) {
    const route = routing[task];
    if (!route) continue;
    if (route.provider === name) delete route.provider;
    if (route.fallback === name) delete route.fallback;
  }
  const next: DiffWiseConfig = { ...config, providers, routing };
  await saveConfig(root, next);
  return next;
}

export async function setProviderRouting(
  root: string,
  task: RouteTask,
  route: { provider?: string; model?: string; fallback?: string; allowCrossProviderFallback?: boolean } | null,
): Promise<DiffWiseConfig> {
  const { config } = await loadConfig(root);
  const routing = { ...(config.routing ?? {}) };
  if (route === null) delete routing[task];
  else routing[task] = route;
  const next: DiffWiseConfig = { ...config, routing };
  await saveConfig(root, next);
  return next;
}

/** Read a file for the rule editor without allowing a path escape. */
export async function readWorkspaceFile(root: string, path: string): Promise<{ path: string; content: string } | { error: string }> {
  const normalized = path.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) return { error: 'path escapes the workspace' };
  try {
    return { path: normalized, content: await readFile(join(root, normalized), 'utf8') };
  } catch (err) {
    return { error: (err as Error).message };
  }
}
