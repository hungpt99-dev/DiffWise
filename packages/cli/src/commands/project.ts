/**
 * Project-scoped commands: init, doctor, config, version.
 */
import { access, appendFile, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import {
  CONFIG_FILE, DEFAULT_CONFIG, loadConfig, runDoctor, saveConfig, TOOL_VERSION,
  type DiffWiseConfig,
} from '@diffwise/app';
import { JSON_SCHEMA_VERSION, REPORT_SCHEMA_VERSION } from '@diffwise/core';
import { flagBool, flagString, UsageError } from '../args';
import type { CommandContext } from '../context';
import { EXIT } from '../exit';

const IGNORE_LINES = [
  '.diffwise/reviews/',
  '.diffwise/backups/',
  '.diffwise/transactions/',
  '.diffwise/artefacts/',
  '.diffwise/*.db',
  '.diffwise/*.db-*',
];

export async function initCommand(ctx: CommandContext): Promise<number> {
  const force = flagBool(ctx.argv.flags, 'force');
  const withMcp = flagBool(ctx.argv.flags, 'mcp');
  const configDir = join(ctx.root, '.diffwise');
  const configPath = join(ctx.root, CONFIG_FILE);

  let created = false;
  try {
    await access(configPath, constants.F_OK);
    if (!force) {
      ctx.out.info(`${ctx.out.gray('config')} ${CONFIG_FILE} already exists (use --force to overwrite).`);
    } else {
      await saveConfig(ctx.root, DEFAULT_CONFIG);
      created = true;
    }
  } catch {
    await saveConfig(ctx.root, DEFAULT_CONFIG);
    created = true;
  }

  const gitignore = join(ctx.root, '.gitignore');
  let existing = '';
  try {
    existing = await readFile(gitignore, 'utf8');
  } catch {
    // no .gitignore yet
  }
  const missing = IGNORE_LINES.filter((line) => !existing.split(/\r?\n/).includes(line));
  if (missing.length > 0) {
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    await appendFile(gitignore, `${prefix}${existing ? '\n' : ''}# DiffWise local reports (regenerate with "diffwise review")\n${missing.join('\n')}\n`, 'utf8');
  }

  let mcpPath: string | undefined;
  if (withMcp) {
    mcpPath = join(ctx.root, '.mcp.json');
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(await readFile(mcpPath, 'utf8')) as Record<string, unknown>;
    } catch {
      current = {};
    }
    const servers = (current.mcpServers && typeof current.mcpServers === 'object')
      ? current.mcpServers as Record<string, unknown>
      : {};
    servers.diffwise = { command: 'diffwise-mcp', args: [], env: { DIFFWISE_MCP_ROOT: ctx.root } };
    current.mcpServers = servers;
    await writeFile(mcpPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  }

  // Validate that the directory is usable before reporting success.
  const loaded = await loadConfig(ctx.root);
  const configured = loaded.config as DiffWiseConfig;

  if (ctx.json) {
    ctx.out.stdout(JSON.stringify({
      ok: true,
      root: ctx.root,
      config: CONFIG_FILE,
      created,
      gitignoreUpdated: missing.length > 0,
      mcpConfig: mcpPath ?? null,
      provider: { id: configured.provider.id, model: configured.provider.model, apiKeyEnvVar: configured.provider.apiKeyEnvVar },
    }, null, 2));
    return EXIT.OK;
  }

  ctx.out.stdout([
    ctx.out.bold('DiffWise initialised'),
    `  ${ctx.out.gray('repository')} ${ctx.root}`,
    `  ${ctx.out.gray('config')}     ${created ? 'created' : 'kept'} ${CONFIG_FILE}`,
    `  ${ctx.out.gray('reports')}    .diffwise/reviews (git-ignored)`,
    `  ${ctx.out.gray('provider')}   ${configured.provider.id} · ${configured.provider.model} · key from ${configured.provider.apiKeyEnvVar}`,
    ...(mcpPath ? [`  ${ctx.out.gray('mcp')}        ${'.mcp.json'} now registers diffwise-mcp`] : []),
    '',
    ctx.out.bold('Next'),
    '  diffwise doctor                 validate the environment',
    '  diffwise review                 review the working tree',
    '  diffwise review main..HEAD      review a branch',
    '  diffwise report --serve         open the interactive web report',
    '',
    ctx.out.gray(`Set ${configured.provider.apiKeyEnvVar} to enable AI analysis, chat and fix generation.`),
  ].join('\n'));
  return EXIT.OK;
}

export async function doctorCommand(ctx: CommandContext): Promise<number> {
  const connect = flagBool(ctx.argv.flags, 'connect');
  const result = await runDoctor(ctx.service, { connect });

  if (ctx.json) {
    ctx.out.stdout(JSON.stringify(result, null, 2));
    return result.ok ? EXIT.OK : EXIT.WORKSPACE;
  }

  const icon: Record<string, string> = {
    pass: ctx.out.green('✔'), warn: ctx.out.yellow('!'), fail: ctx.out.red('✖'), skip: ctx.out.gray('–'),
  };
  const lines = [ctx.out.bold(`DiffWise doctor — ${result.root}`), ''];
  for (const check of result.checks) {
    lines.push(`${icon[check.status] ?? '·'} ${check.label}`);
    lines.push(`   ${ctx.out.gray(check.detail)}`);
    if (check.hint) lines.push(`   ${ctx.out.gray('→')} ${check.hint}`);
  }
  lines.push('');
  lines.push(result.ok ? ctx.out.green('Environment is usable.') : ctx.out.red('Environment has blocking problems (see ✖ above).'));
  ctx.out.stdout(lines.join('\n'));
  if (!connect && result.checks.some((c) => c.id === 'provider')) {
    ctx.out.info(ctx.out.gray('Add --connect to test the configured model with a live request.'));
  }
  return result.ok ? EXIT.OK : EXIT.WORKSPACE;
}

export async function configCommand(ctx: CommandContext): Promise<number> {
  const [action = 'list', key, ...rest] = ctx.argv.positionals;
  const loaded = await loadConfig(ctx.root, { ...(ctx.configPath ? { configPath: ctx.configPath } : {}) });

  if (action === 'list' || action === 'show') {
    const provider = ctx.service.providers();
    if (ctx.json) {
      ctx.out.stdout(JSON.stringify({
        path: loaded.path ?? null,
        warnings: loaded.warnings,
        config: loaded.config,
        resolved: { apiKeyPresent: provider.apiKeyPresent, providerAvailable: Boolean(provider.provider) },
      }, null, 2));
      return EXIT.OK;
    }
    const lines = [
      `${ctx.out.bold('Effective configuration')} ${ctx.out.gray(loaded.path ?? '(defaults)')}`,
      ...flatten(loaded.config).map(([path, value]) => `  ${ctx.out.cyan(path.padEnd(38))} ${formatValue(value)}`),
      '',
      `${ctx.out.gray('api key')}  ${loaded.config.provider.apiKeyEnvVar}: ${provider.apiKeyPresent ? ctx.out.green('present') : ctx.out.yellow('missing')}`,
    ];
    for (const warning of loaded.warnings) lines.push(ctx.out.yellow(`warning ${warning}`));
    ctx.out.stdout(lines.join('\n'));
    return EXIT.OK;
  }

  if (action === 'validate') {
    // Validation answers one question: would a review run with this
    // configuration? Errors would fail a run; warnings would only degrade it.
    const issues: Array<{ level: 'error' | 'warning'; path: string; message: string }> = [];
    const cfg = loaded.config;
    if (!loaded.path) {
      issues.push({ level: 'warning', path: CONFIG_FILE, message: 'no configuration file; defaults apply' });
    }
    for (const warning of loaded.warnings) issues.push({ level: 'warning', path: 'config', message: warning });

    if (cfg.provider.id !== 'none') {
      if (!/^https?:\/\//.test(cfg.provider.baseUrl)) {
        issues.push({ level: 'error', path: 'provider.baseUrl', message: `not an http(s) URL: ${cfg.provider.baseUrl}` });
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cfg.provider.apiKeyEnvVar)) {
        issues.push({ level: 'error', path: 'provider.apiKeyEnvVar', message: `not an environment variable name: ${cfg.provider.apiKeyEnvVar}` });
      } else if (!process.env[cfg.provider.apiKeyEnvVar]) {
        issues.push({
          level: 'warning',
          path: 'provider.apiKeyEnvVar',
          message: `${cfg.provider.apiKeyEnvVar} is not set in this environment; the review will run deterministically`,
        });
      }
      if (cfg.ai.enabled && !cfg.provider.model) {
        issues.push({ level: 'error', path: 'provider.model', message: 'AI is enabled but no model is configured' });
      }
    } else if (cfg.ai.enabled) {
      issues.push({ level: 'warning', path: 'ai.enabled', message: 'AI is enabled but provider.id is "none"' });
    }

    if (cfg.cache.enabled && cfg.cache.maxEntries === 0) {
      issues.push({ level: 'warning', path: 'cache.maxEntries', message: 'cache is enabled with a limit of 0 entries' });
    }
    if (cfg.cache.ttlDays === 0) {
      issues.push({ level: 'warning', path: 'cache.ttlDays', message: 'ttlDays 0 disables the cache' });
    }
    for (const [key, price] of Object.entries(cfg.pricing ?? {})) {
      if (!(price.inputPerMTok >= 0) || !(price.outputPerMTok >= 0)) {
        issues.push({ level: 'error', path: `pricing.${key}`, message: 'prices must be non-negative numbers' });
      }
      if (!price.source) {
        issues.push({ level: 'warning', path: `pricing.${key}`, message: 'no source recorded for this price' });
      }
    }

    const errors = issues.filter((i) => i.level === 'error');
    if (ctx.json) {
      ctx.out.stdout(JSON.stringify({
        path: loaded.path ?? null, ok: errors.length === 0, issues, config: cfg,
      }, null, 2));
      return errors.length > 0 ? EXIT.WORKSPACE : EXIT.OK;
    }
    const lines: string[] = [];
    lines.push(`${ctx.out.bold('Configuration')} ${ctx.out.gray(loaded.path ?? '(defaults, no file)')}`);
    if (issues.length === 0) lines.push(`  ${ctx.out.green('valid')} — a review can run with this configuration`);
    for (const issue of issues) {
      const tag = issue.level === 'error' ? ctx.out.red('error  ') : ctx.out.yellow('warning');
      lines.push(`  ${tag} ${ctx.out.cyan(issue.path.padEnd(24))} ${issue.message}`);
    }
    lines.push('', ctx.out.gray('policy and rule packs have their own commands: "diffwise policy effective", "diffwise rules validate"'));
    ctx.out.stdout(lines.join('\n'));
    return errors.length > 0 ? EXIT.WORKSPACE : EXIT.OK;
  }

  if (action === 'get') {
    if (!key) throw new UsageError('config get needs a key, e.g. "diffwise config get provider.model".');
    const value = getPath(loaded.config, key);
    if (value === undefined) throw new UsageError(`Unknown configuration key "${key}".`, 'Run "diffwise config list" to see keys.');
    ctx.out.stdout(typeof value === 'string' ? value : JSON.stringify(value));
    return EXIT.OK;
  }

  if (action === 'set') {
    if (!key || rest.length === 0) throw new UsageError('config set needs a key and a value, e.g. "diffwise config set verification.command \\"npm test\\"".');
    if (key === 'provider.apiKey') {
      throw new UsageError('Secrets are never written to config.json.', `Export ${loaded.config.provider.apiKeyEnvVar} in your environment instead.`);
    }
    const next = structuredClone(loaded.config) as unknown as Record<string, unknown>;
    setPath(next, key, coerce(rest.join(' ')));
    const saved = await saveConfig(ctx.root, next as unknown as DiffWiseConfig, ctx.configPath);
    ctx.out.info(`${ctx.out.green('saved')} ${key} in ${saved}`);
    if (ctx.json) ctx.out.stdout(JSON.stringify({ ok: true, key, path: saved }, null, 2));
    return EXIT.OK;
  }

  throw new UsageError(`Unknown config action "${action}".`, 'Use: diffwise config [list|get <key>|set <key> <value>]');
}

export async function versionCommand(ctx: CommandContext): Promise<number> {
  const info = {
    name: 'diffwise',
    version: TOOL_VERSION,
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    jsonSchemaVersion: JSON_SCHEMA_VERSION,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
  if (ctx.json) {
    ctx.out.stdout(JSON.stringify(info, null, 2));
    return EXIT.OK;
  }
  ctx.out.stdout(`diffwise ${info.version}  ${ctx.out.gray(`(report schema v${info.reportSchemaVersion}, json contract v${info.jsonSchemaVersion})`)}\n${ctx.out.gray(`node ${info.node} · ${info.platform}`)}`);
  return EXIT.OK;
}

function flatten(value: unknown, prefix = ''): Array<[string, unknown]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [[prefix, value]];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) => flatten(child, prefix ? `${prefix}.${key}` : key));
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.length === 0 ? '[]' : value.join(', ');
  if (typeof value === 'string') return value === '' ? '""' : value;
  return String(value);
}

export function getPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Keys that are valid but absent from the defaults, so `config set` can create
 * them without opening the door to arbitrary typos.
 */
const OPTIONAL_KEYS = new Set(['pricing']);

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (typeof next !== 'object' || next === null) throw new UsageError(`Unknown configuration key "${path}".`);
    current = next as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1] as string;
  const creatable = parts.length === 1 && OPTIONAL_KEYS.has(leaf);
  if (!(leaf in current) && !creatable) {
    throw new UsageError(`Unknown configuration key "${path}".`, 'Run "diffwise config list" to see keys.');
  }
  current[leaf] = value;
}

function coerce(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  // Objects and arrays are JSON; anything else is a plain string. Arrays also
  // accept a comma-separated list, which is what people type for globs.
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      if (raw.startsWith('[')) return raw.split(',').map((s) => s.trim()).filter(Boolean);
      throw new UsageError(`Value for this key looks like JSON but does not parse: ${raw.slice(0, 80)}`);
    }
  }
  return raw;
}

export function configKeyHint(key: string): string | undefined {
  return getPath(DEFAULT_CONFIG, key) === undefined ? undefined : key;
}

/** Silence unused-import lint for values used only in type positions. */
void flagString;
