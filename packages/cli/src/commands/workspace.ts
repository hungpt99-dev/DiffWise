/**
 * Workspace commands: rules CRUD, documentation sources, MCP connections and
 * AI provider profiles.
 *
 * These are the CLI equivalents of the VS Code management panels. Both call the
 * same application functions, so a rule created in the editor and a rule created
 * by CI are the same object with the same validation.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FindingCategory, Severity } from '@diffwise/core';
import {
  callMcpTool, createOrUpdateRule, deleteRule, exportRules, importRules, listMcpStatus, listMcpTools,
  loadWorkspaceState, removeMcpServer, removeProviderProfile, saveDocumentationSources, saveProviderProfile,
  setMcpEnabled, setProviderRouting, setRuleEnabled, testMcpServer, testRuleAgainstRepository, upsertMcpServer,
} from '@diffwise/app';
import type { RouteTask } from '@diffwise/app';
import type { CommandContext } from '../context';
import { EXIT } from '../exit';
import { flagBool, flagNumber, flagString } from '../args';

function printJson(ctx: CommandContext, value: unknown): number {
  ctx.out.stdout(JSON.stringify(value, null, 2));
  return EXIT.OK;
}

function listFlag(value: string | undefined): string[] {
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
}

function keyValues(values: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values) {
    const index = value.indexOf('=');
    if (index <= 0) continue;
    out[value.slice(0, index)] = value.slice(index + 1);
  }
  return out;
}

function repeated(ctx: CommandContext, name: string): string[] {
  const raw = ctx.argv.flags[name];
  if (raw === undefined) return [];
  return (Array.isArray(raw) ? raw : [raw]).filter((item): item is string => typeof item === 'string');
}

/**
 * Extend the existing `rules` command. Keeping one command with subcommands is
 * the documented CLI contract; a second top-level command would split discovery.
 */
export async function rulesManageCommand(ctx: CommandContext): Promise<number | null> {
  const sub = ctx.argv.positionals[0] ?? '';
  if (!['create', 'update', 'remove', 'enable', 'disable', 'test', 'export', 'import', 'add'].includes(sub)) return null;
  const root = ctx.root;

  if (sub === 'import' || sub === 'add') {
    const target = ctx.argv.positionals[1];
    if (!target) { ctx.out.error(`Usage: diffwise rules ${sub} <file.yaml>`); return EXIT.USAGE; }
    const source = await readFile(resolve(root, target), 'utf8');
    const result = await importRules(root, source);
    if (ctx.json) return printJson(ctx, result);
    for (const issue of result.issues) ctx.out.stdout(`${issue.level}: ${issue.message} (${issue.path})`);
    ctx.out.stdout(`Imported ${result.imported.length} rule(s).`);
    return result.issues.some((issue) => issue.level === 'error') ? EXIT.USAGE : EXIT.OK;
  }

  if (sub === 'create' || sub === 'update') {
    const draft = ruleDraftFromFlags(ctx);
    if ('error' in draft) { ctx.out.error(draft.error); return EXIT.USAGE; }
    const result = await createOrUpdateRule(root, draft, sub === 'update' ? 'update' : 'create');
    if (ctx.json) return printJson(ctx, result);
    for (const issue of result.issues) ctx.out.stdout(`${issue.level}: ${issue.message} (${issue.path})`);
    if (!result.rule) {
      ctx.out.error(`Rule was not ${sub === 'update' ? 'updated' : 'created'}.`);
      return EXIT.USAGE;
    }
    ctx.out.stdout(`${sub === 'update' ? 'Updated' : 'Created'} rule ${result.rule.id} in .diffwise/rules/custom.`);
    ctx.out.stdout(`Test it against this repository with: diffwise rules test ${result.rule.id}`);
    return EXIT.OK;
  }

  if (sub === 'remove') {
    const id = ctx.argv.positionals[1];
    if (!id) { ctx.out.error('Usage: diffwise rules remove <id>'); return EXIT.USAGE; }
    const result = await deleteRule(root, id);
    if (ctx.json) return printJson(ctx, result);
    for (const issue of result.issues) ctx.out.error(`${issue.level}: ${issue.message}`);
    ctx.out.stdout(result.removed ? `Removed ${id}.` : `${id} was not removed.`);
    return result.removed ? EXIT.OK : EXIT.NOT_FOUND;
  }

  if (sub === 'enable' || sub === 'disable') {
    const id = ctx.argv.positionals[1];
    if (!id) { ctx.out.error(`Usage: diffwise rules ${sub} <id>`); return EXIT.USAGE; }
    const enabled = sub === 'enable';
    const result = await setRuleEnabled(root, id, enabled);
    if (ctx.json) return printJson(ctx, result);
    for (const issue of result.issues) ctx.out.error(`${issue.level}: ${issue.message}`);
    if (!result.rule) return EXIT.NOT_FOUND;
    ctx.out.stdout(`${enabled ? 'Enabled' : 'Disabled'} ${id}.`);
    return EXIT.OK;
  }

  if (sub === 'test') {
    const id = ctx.argv.positionals[1];
    if (!id) { ctx.out.error('Usage: diffwise rules test <id> [--max-files N]'); return EXIT.USAGE; }
    const state = await loadWorkspaceState(root);
    const rule = state.rules.custom.find((entry) => entry.id === id);
    if (!rule) { ctx.out.error(`No custom rule "${id}". Run "diffwise rules list".`); return EXIT.NOT_FOUND; }
    const { managedToDraft } = await import('@diffwise/core');
    const result = await testRuleAgainstRepository(root, managedToDraft(rule), flagNumber(ctx.argv.flags, 'max-files') ?? 400);
    if (ctx.json) return printJson(ctx, result);
    ctx.out.stdout(`Rule ${result.ruleId}: ${result.matches.length} match(es) in ${result.filesMatched} file(s) (${result.filesScanned} scanned, ${result.skipped} skipped by scope).`);
    for (const match of result.matches.slice(0, 20)) {
      ctx.out.stdout(`  ${match.file}:${match.line}  ${match.snippet.trim().slice(0, 140)}`);
    }
    if (result.matches.length === 0) ctx.out.stdout('  No match. Check the scope and the pattern before enabling it.');
    for (const issue of result.issues) ctx.out.stdout(`${issue.level}: ${issue.message}`);
    return result.valid ? EXIT.OK : EXIT.USAGE;
  }

  if (sub === 'export') {
    const id = ctx.argv.positionals[1];
    const result = await exportRules(root, id);
    const out = flagString(ctx.argv.flags, 'out');
    if (out) {
      await writeFile(resolve(root, out), result.yaml, 'utf8');
      if (!ctx.json) ctx.out.stdout(`Exported ${result.count} rule(s) to ${out}.`);
      return EXIT.OK;
    }
    if (ctx.json) return printJson(ctx, result);
    ctx.out.stdout(result.yaml || 'No custom rules to export.');
    return EXIT.OK;
  }
  return null;
}

function ruleDraftFromFlags(ctx: CommandContext):
  | import('@diffwise/core').RuleDraft
  | { error: string } {
  const id = ctx.argv.positionals[1];
  const name = flagString(ctx.argv.flags, 'name');
  const category = flagString(ctx.argv.flags, 'category') as FindingCategory | undefined;
  const severity = (flagString(ctx.argv.flags, 'severity') ?? 'medium') as Severity;
  const pattern = flagString(ctx.argv.flags, 'pattern');
  const absence = flagString(ctx.argv.flags, 'absence');
  const forbidden = flagString(ctx.argv.flags, 'forbidden-import');
  if (!id) return { error: 'a rule id is required: rules create <id> --name ... --category ... --pattern ...' };
  if (!name) return { error: '--name is required' };
  if (!category) return { error: `--category is required (one of: architecture, security, performance, database, concurrency, api-contract, maintainability, reliability, error-handling, tests, documentation, correctness, resources, configuration)` };
  if (!pattern && !absence && !forbidden) return { error: 'one detection is required: --pattern, --absence or --forbidden-import' };
  const detection = pattern
    ? { type: 'pattern' as const, pattern, scope: (flagString(ctx.argv.flags, 'scope') === 'file' ? 'file' : 'added') as 'file' | 'added', ...(flagString(ctx.argv.flags, 'must-not-match') ? { mustNotMatch: flagString(ctx.argv.flags, 'must-not-match') as string } : {}) }
    : absence
      ? { type: 'absence' as const, required: absence, message: flagString(ctx.argv.flags, 'message') ?? `Required pattern is missing: ${absence}` }
      : { type: 'forbidden-import' as const, from: forbidden as string };
  const languages = listFlag(flagString(ctx.argv.flags, 'languages'));
  return {
    id,
    name,
    category,
    severity,
    ...(flagString(ctx.argv.flags, 'confidence') ? { confidence: flagString(ctx.argv.flags, 'confidence') as import('@diffwise/core').Confidence } : {}),
    description: flagString(ctx.argv.flags, 'description') ?? name,
    recommendation: flagString(ctx.argv.flags, 'recommendation') ?? 'Follow the engineering standard this rule encodes.',
    detection,
    ...(listFlag(flagString(ctx.argv.flags, 'files')).length ? { files: listFlag(flagString(ctx.argv.flags, 'files')) } : {}),
    ...(listFlag(flagString(ctx.argv.flags, 'exclude')).length ? { exclude: listFlag(flagString(ctx.argv.flags, 'exclude')) } : {}),
    ...(languages.length ? { languages: languages as import('@diffwise/core').Language[] } : {}),
    ...(flagNumber(ctx.argv.flags, 'priority') !== undefined ? { priority: flagNumber(ctx.argv.flags, 'priority') as number } : {}),
    ...(flagString(ctx.argv.flags, 'enforcement') ? { enforcement: flagString(ctx.argv.flags, 'enforcement') as 'mandatory' | 'advisory' } : {}),
    ...(flagBool(ctx.argv.flags, 'gate') ? { blocksGate: true } : {}),
  };
}

export async function docsCommand(ctx: CommandContext): Promise<number> {
  const sub = ctx.argv.positionals[0] ?? 'list';
  const root = ctx.root;
  if (sub === 'list' || sub === 'index') {
    const state = await loadWorkspaceState(root);
    if (ctx.json) return printJson(ctx, { sources: state.documentation.sources, index: state.documentation.indexed });
    ctx.out.stdout('Documentation sources:');
    if (state.documentation.sources.length === 0) ctx.out.stdout('  (none configured; every documentation file in the repository is considered)');
    for (const source of state.documentation.sources) {
      ctx.out.stdout(`  ${source.enabled === false ? '✗' : '✓'} ${source.path.padEnd(36)} ${(source.category ?? 'auto').padEnd(14)} priority ${source.priority ?? 'auto'}`);
    }
    const index = state.documentation.indexed;
    ctx.out.stdout('');
    if (index) {
      ctx.out.stdout(`Index: ${index.documents} document(s), ${index.sections} section(s), ${index.bytes} bytes, ${index.duplicates} duplicate(s).`);
      const categories = Object.entries(index.categories).sort((a, b) => b[1] - a[1]).slice(0, 8);
      if (categories.length) ctx.out.stdout(`Categories: ${categories.map(([key, value]) => `${key}=${value}`).join(', ')}`);
    } else {
      ctx.out.stdout('Index: not built (no worktree documentation was readable).');
    }
    return EXIT.OK;
  }
  if (sub === 'add' || sub === 'update') {
    const path = ctx.argv.positionals[1];
    if (!path) { ctx.out.error('Usage: diffwise docs add <path-or-glob> [--category CAT] [--priority N]'); return EXIT.USAGE; }
    const state = await loadWorkspaceState(root);
    const sources = [...state.documentation.sources];
    const index = sources.findIndex((source) => source.path === path);
    const source = {
      path,
      ...(flagString(ctx.argv.flags, 'category') ? { category: flagString(ctx.argv.flags, 'category') as import('@diffwise/core').DocumentCategory } : {}),
      ...(flagNumber(ctx.argv.flags, 'priority') !== undefined ? { priority: flagNumber(ctx.argv.flags, 'priority') as number } : {}),
      enabled: true,
      ...(listFlag(flagString(ctx.argv.flags, 'modules')).length ? { modules: listFlag(flagString(ctx.argv.flags, 'modules')) } : {}),
    };
    if (index >= 0) sources[index] = { ...sources[index], ...source };
    else sources.push(source);
    await saveDocumentationSources(root, sources);
    if (ctx.json) return printJson(ctx, { sources });
    ctx.out.stdout(`Documentation source ${index >= 0 ? 'updated' : 'added'}: ${path}`);
    return EXIT.OK;
  }
  if (sub === 'remove' || sub === 'enable' || sub === 'disable') {
    const path = ctx.argv.positionals[1];
    if (!path) { ctx.out.error(`Usage: diffwise docs ${sub} <path>`); return EXIT.USAGE; }
    const state = await loadWorkspaceState(root);
    const sources = sub === 'remove'
      ? state.documentation.sources.filter((source) => source.path !== path)
      : state.documentation.sources.map((source) => (source.path === path ? { ...source, enabled: sub === 'enable' } : source));
    await saveDocumentationSources(root, sources);
    if (ctx.json) return printJson(ctx, { sources });
    ctx.out.stdout(`${sub === 'remove' ? 'Removed' : sub === 'enable' ? 'Enabled' : 'Disabled'} ${path}.`);
    return EXIT.OK;
  }
  ctx.out.error(`Unknown subcommand "docs ${sub}". Try: list, index, add, remove, enable, disable.`);
  return EXIT.USAGE;
}

export async function mcpCommand(ctx: CommandContext): Promise<number> {
  const sub = ctx.argv.positionals[0] ?? 'list';
  const root = ctx.root;
  if (sub === 'list' || sub === 'status') {
    const state = await loadWorkspaceState(root);
    const connected = sub === 'status' ? await listMcpStatus(root) : { statuses: [], warnings: [] };
    const byName = new Map(connected.statuses.map((status) => [status.name, status]));
    if (ctx.json) return printJson(ctx, { servers: state.mcp.servers, statuses: connected.statuses, warnings: [...state.mcp.warnings, ...connected.warnings] });
    ctx.out.stdout(`${state.mcp.servers.length} MCP connection(s) in ${state.mcp.path}:`);
    if (state.mcp.servers.length === 0) ctx.out.stdout('  (none configured; DiffWise does not connect to any external MCP server)');
    for (const server of state.mcp.servers) {
      const status = byName.get(server.name);
      const detail = status ? `${status.state}${status.message ? ` — ${status.message}` : ''}` : (server.enabled ? 'configured' : 'disabled');
      ctx.out.stdout(`  ${server.enabled ? '✓' : '✗'} ${server.name.padEnd(22)} ${server.transport.padEnd(6)} ${detail}`);
      ctx.out.stdout(`      read-only ${server.permissions.readOnly ? 'yes' : 'no'}, tools ${server.permissions.allowedTools.length ? server.permissions.allowedTools.join(',') : 'all read-only'}, context ${server.context?.tool ?? 'none'}`);
    }
    for (const warning of [...state.mcp.warnings, ...connected.warnings]) ctx.out.stdout(`  ! ${warning}`);
    return EXIT.OK;
  }

  if (sub === 'add' || sub === 'update') {
    const name = ctx.argv.positionals[1];
    if (!name) { ctx.out.error('Usage: diffwise mcp add <name> --transport stdio --command <cmd> [--args "a b"] | --url <url>'); return EXIT.USAGE; }
    const transport = flagString(ctx.argv.flags, 'transport') === 'http' ? 'http' as const : 'stdio' as const;
    const command = flagString(ctx.argv.flags, 'command');
    const url = flagString(ctx.argv.flags, 'url');
    if (transport === 'stdio' && !command) { ctx.out.error('--command is required for a stdio connection'); return EXIT.USAGE; }
    if (transport === 'http' && !url) { ctx.out.error('--url is required for an HTTP connection'); return EXIT.USAGE; }
    const args = (flagString(ctx.argv.flags, 'args') ?? '').split(' ').map((part) => part.trim()).filter(Boolean);
    const result = await upsertMcpServer(root, {
      name,
      transport,
      enabled: true,
      ...(transport === 'stdio' ? { command, args } : { url }),
      permissions: {
        readOnly: !flagBool(ctx.argv.flags, 'allow-write'),
        allowedTools: listFlag(flagString(ctx.argv.flags, 'allow-tools')),
        allowedResources: listFlag(flagString(ctx.argv.flags, 'allow-resources')),
        contextTools: listFlag(flagString(ctx.argv.flags, 'context-tools')),
        maxOutputBytes: flagNumber(ctx.argv.flags, 'max-output') ?? 24_000,
        timeoutMs: flagNumber(ctx.argv.flags, 'timeout') ?? 20_000,
        allowWrite: flagBool(ctx.argv.flags, 'allow-write'),
      },
      ...(flagString(ctx.argv.flags, 'context-tool') || flagString(ctx.argv.flags, 'context-resource')
        ? {
          context: {
            ...(flagString(ctx.argv.flags, 'context-tool') ? { tool: flagString(ctx.argv.flags, 'context-tool') as string } : {}),
            ...(flagString(ctx.argv.flags, 'context-resource') ? { resource: flagString(ctx.argv.flags, 'context-resource') as string } : {}),
            arguments: JSON.parse(flagString(ctx.argv.flags, 'context-args') ?? '{}') as Record<string, unknown>,
          },
        }
        : {}),
    });
    if (ctx.json) return printJson(ctx, result);
    for (const warning of result.warnings) ctx.out.stdout(`! ${warning}`);
    ctx.out.stdout(`${sub === 'add' ? 'Added' : 'Updated'} MCP connection ${name}.`);
    return EXIT.OK;
  }

  if (sub === 'remove' || sub === 'enable' || sub === 'disable') {
    const name = ctx.argv.positionals[1];
    if (!name) { ctx.out.error(`Usage: diffwise mcp ${sub} <name>`); return EXIT.USAGE; }
    if (sub === 'remove') await removeMcpServer(root, name);
    else await setMcpEnabled(root, name, sub === 'enable');
    ctx.out.stdout(`${sub === 'remove' ? 'Removed' : sub === 'enable' ? 'Enabled' : 'Disabled'} ${name}.`);
    return EXIT.OK;
  }

  if (sub === 'test') {
    const name = ctx.argv.positionals[1];
    if (!name) { ctx.out.error('Usage: diffwise mcp test <name>'); return EXIT.USAGE; }
    const status = await testMcpServer(root, name);
    if (ctx.json) return printJson(ctx, status);
    if ('error' in status) { ctx.out.error(status.error); return EXIT.NOT_FOUND; }
    ctx.out.stdout(`${status.name}: ${status.state}${status.message ? ` — ${status.message}` : ''}`);
    ctx.out.stdout(`  tools ${status.tools}, resources ${status.resources}, prompts ${status.prompts}`);
    return status.state === 'ok' ? EXIT.OK : EXIT.INTERNAL;
  }

  if (sub === 'tools') {
    const name = ctx.argv.positionals[1];
    if (!name) { ctx.out.error('Usage: diffwise mcp tools <name>'); return EXIT.USAGE; }
    const result = await listMcpTools(root, name);
    if (ctx.json) return printJson(ctx, result);
    if (result.error) { ctx.out.error(result.error); return EXIT.INTERNAL; }
    for (const tool of result.tools) {
      ctx.out.stdout(`  ${tool.name.padEnd(30)} ${tool.readOnly ? 'read-only' : 'write'}${tool.destructive ? ' destructive' : ''}  ${(tool.description ?? '').slice(0, 100)}`);
    }
    return EXIT.OK;
  }

  if (sub === 'call') {
    const name = ctx.argv.positionals[1];
    const tool = ctx.argv.positionals[2];
    if (!name || !tool) { ctx.out.error('Usage: diffwise mcp call <server> <tool> [--args JSON] [--approve-write]'); return EXIT.USAGE; }
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(flagString(ctx.argv.flags, 'args') ?? '{}') as Record<string, unknown>; } catch { ctx.out.error('--args must be valid JSON'); return EXIT.USAGE; }
    const result = await callMcpTool(root, name, tool, args, { approved: flagBool(ctx.argv.flags, 'approve-write') });
    if (ctx.json) return printJson(ctx, result);
    if (!result.ok) { ctx.out.error(result.error ?? 'call failed'); return EXIT.INTERNAL; }
    ctx.out.stdout(result.text);
    return EXIT.OK;
  }

  ctx.out.error(`Unknown subcommand "mcp ${sub}". Try: list, status, add, update, remove, enable, disable, test, tools, call.`);
  return EXIT.USAGE;
}

export async function providersCommand(ctx: CommandContext): Promise<number> {
  const sub = ctx.argv.positionals[0] ?? 'list';
  const root = ctx.root;
  if (sub === 'list') {
    const state = await loadWorkspaceState(root);
    if (ctx.json) return printJson(ctx, state.providers);
    ctx.out.stdout('AI providers:');
    for (const profile of state.providers.profiles) {
      ctx.out.stdout(`  ${profile.enabled ? '✓' : '✗'} ${profile.name.padEnd(16)} ${profile.id.padEnd(18)} ${profile.model.padEnd(28)} key ${profile.apiKeyPresent ? 'present' : 'missing'} (${profile.apiKeyEnvVar || 'none'})`);
    }
    if (state.providers.routing && Object.keys(state.providers.routing).length) {
      ctx.out.stdout('');
      ctx.out.stdout('Task routing:');
      for (const [task, route] of Object.entries(state.providers.routing)) {
        if (!route) continue;
        ctx.out.stdout(`  ${task.padEnd(16)} ${route.provider ?? 'primary'}/${route.model ?? 'default'}${route.fallback ? ` (fallback ${route.fallback})` : ''}`);
      }
    }
    return EXIT.OK;
  }

  if (sub === 'add' || sub === 'update') {
    const name = ctx.argv.positionals[1] ?? 'primary';
    const id = (flagString(ctx.argv.flags, 'id') ?? 'openai-compatible') as import('@diffwise/ai').ProviderId;
    const state = await loadWorkspaceState(root);
    const existing = state.providers.profiles.find((profile) => profile.name === name);
    const profile = await saveProviderProfile(root, {
      name,
      id,
      baseUrl: flagString(ctx.argv.flags, 'base-url') ?? existing?.baseUrl ?? '',
      model: flagString(ctx.argv.flags, 'model') ?? existing?.model ?? '',
      apiKeyEnvVar: flagString(ctx.argv.flags, 'key-env') ?? existing?.apiKeyEnvVar ?? '',
      ...(flagString(ctx.argv.flags, 'fast-model') ? { fastModel: flagString(ctx.argv.flags, 'fast-model') as string } : {}),
      ...(flagString(ctx.argv.flags, 'api-version') ? { apiVersion: flagString(ctx.argv.flags, 'api-version') as string } : {}),
      ...(flagString(ctx.argv.flags, 'deployment') ? { deployment: flagString(ctx.argv.flags, 'deployment') as string } : {}),
      maxTokens: flagNumber(ctx.argv.flags, 'max-tokens') ?? 8_000,
      temperature: flagNumber(ctx.argv.flags, 'temperature') ?? 0.1,
      timeoutMs: flagNumber(ctx.argv.flags, 'timeout') ?? 180_000,
      ...(repeated(ctx, 'header').length ? { extraHeaders: keyValues(repeated(ctx, 'header')) } : {}),
      ...(flagBool(ctx.argv.flags, 'disabled') ? { enabled: false } : {}),
    }, { primary: name === 'primary' || flagBool(ctx.argv.flags, 'primary') });
    if (ctx.json) return printJson(ctx, profile.providers);
    ctx.out.stdout(`${sub === 'add' ? 'Added' : 'Updated'} provider profile ${name}. Set ${flagString(ctx.argv.flags, 'key-env') ?? 'its key environment variable'} to use it.`);
    return EXIT.OK;
  }

  if (sub === 'remove') {
    const name = ctx.argv.positionals[1];
    if (!name) { ctx.out.error('Usage: diffwise providers remove <name>'); return EXIT.USAGE; }
    const config = await removeProviderProfile(root, name);
    if (ctx.json) return printJson(ctx, config.providers ?? []);
    ctx.out.stdout(`Removed provider profile ${name}.`);
    return EXIT.OK;
  }

  if (sub === 'route') {
    const task = ctx.argv.positionals[1] as RouteTask | undefined;
    if (!task) { ctx.out.error('Usage: diffwise providers route <task> [--provider NAME] [--model MODEL] [--fallback NAME] [--allow-cross-provider] | --clear'); return EXIT.USAGE; }
    const config = await setProviderRouting(root, task, flagBool(ctx.argv.flags, 'clear')
      ? null
      : {
        ...(flagString(ctx.argv.flags, 'provider') ? { provider: flagString(ctx.argv.flags, 'provider') as string } : {}),
        ...(flagString(ctx.argv.flags, 'model') ? { model: flagString(ctx.argv.flags, 'model') as string } : {}),
        ...(flagString(ctx.argv.flags, 'fallback') ? { fallback: flagString(ctx.argv.flags, 'fallback') as string } : {}),
        ...(flagBool(ctx.argv.flags, 'allow-cross-provider') ? { allowCrossProviderFallback: true } : {}),
      });
    if (ctx.json) return printJson(ctx, config.routing ?? {});
    ctx.out.stdout(`Routing for ${task}: ${flagBool(ctx.argv.flags, 'clear') ? 'cleared' : JSON.stringify(config.routing?.[task] ?? {})}`);
    return EXIT.OK;
  }

  ctx.out.error(`Unknown subcommand "providers ${sub}". Try: list, add, update, remove, route.`);
  return EXIT.USAGE;
}
