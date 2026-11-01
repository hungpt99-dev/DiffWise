/**
 * `diffwise doctor` — environment validation.
 *
 * Every check answers a question a developer would otherwise discover through a
 * confusing failure later. Checks never contain secrets; the provider check
 * reports only whether the named environment variable is set.
 */
import { access, constants, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { GitClient } from '@diffwise/core';
import { testProvider } from '@diffwise/ai';
import type { DiffWiseService } from './service';
import { CONFIG_FILE } from './config';
import { storeDir } from './repo';

const execFileAsync = promisify(execFile);

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
  root: string;
}

export interface DoctorOptions {
  /** Also send a tiny request to the configured model. */
  connect?: boolean;
}

async function gitVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['--version']);
    return stdout.trim();
  } catch {
    return null;
  }
}

async function findMcpConfig(root: string): Promise<string | null> {
  const candidates = ['.mcp.json', '.vscode/mcp.json', join('.diffwise', 'mcp.json')];
  for (const rel of candidates) {
    try {
      const text = await readFile(join(root, rel), 'utf8');
      if (/diffwise/i.test(text)) return rel;
    } catch {
      // absent
    }
  }
  return null;
}

export async function runDoctor(service: DiffWiseService, options: DoctorOptions = {}): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];

  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    id: 'node',
    label: 'Node.js runtime',
    status: major >= 20 ? 'pass' : 'fail',
    detail: `v${process.versions.node} on ${process.platform}-${process.arch}`,
    ...(major >= 20 ? {} : { hint: 'DiffWise requires Node.js 20.11 or newer.' }),
  });

  const git = await gitVersion();
  checks.push({
    id: 'git',
    label: 'Git availability',
    status: git ? 'pass' : 'fail',
    detail: git ?? 'git was not found on PATH',
    ...(git ? {} : { hint: 'Install git and make sure it is on PATH.' }),
  });

  let branch = 'unknown';
  let dirty = 0;
  try {
    const client = new GitClient(service.root);
    await client.assertRepo();
    const info = await client.info();
    branch = info.branch;
    const { changes } = await client.diff({ mode: 'working', label: 'Working tree' });
    dirty = changes.length;
    checks.push({
      id: 'repository',
      label: 'Git repository',
      status: 'pass',
      detail: `${info.name} on ${branch} at ${info.headCommit.slice(0, 8)} (${info.fileCount} tracked files)`,
    });
    checks.push({
      id: 'working-tree',
      label: 'Working tree',
      status: 'pass',
      detail: dirty === 0 ? 'clean' : `${dirty} changed file(s) available to review`,
    });
  } catch (err) {
    checks.push({
      id: 'repository',
      label: 'Git repository',
      status: 'fail',
      detail: (err as Error).message,
      hint: 'Run DiffWise inside a git repository, or pass --repo <path>.',
    });
  }

  checks.push({
    id: 'config',
    label: 'Configuration',
    status: service.configPath ? 'pass' : 'warn',
    detail: service.configPath
      ? `loaded ${service.configPath}`
      : `no ${CONFIG_FILE} found; defaults are in use`,
    ...(service.configPath ? {} : { hint: 'Run "diffwise init" to write a starter configuration.' }),
  });
  for (const warning of service.configWarnings) {
    checks.push({ id: 'config-warning', label: 'Configuration warning', status: 'warn', detail: warning });
  }

  try {
    await access(storeDir(service.root), constants.W_OK);
    checks.push({ id: 'permissions', label: 'Report directory', status: 'pass', detail: `${storeDir(service.root)} is writable` });
  } catch {
    checks.push({
      id: 'permissions',
      label: 'Report directory',
      status: 'fail',
      detail: `${storeDir(service.root)} is not writable`,
      hint: 'Fix the directory permissions or set a different --repo.',
    });
  }

  const resolved = service.providers();
  const p = service.config.provider;
  if (!service.config.ai.enabled) {
    checks.push({ id: 'provider', label: 'AI provider', status: 'skip', detail: 'AI is disabled in config (ai.enabled=false).' });
  } else if (p.id === 'none') {
    checks.push({ id: 'provider', label: 'AI provider', status: 'skip', detail: 'provider.id is "none"; deterministic analysis only.' });
  } else {
    checks.push({
      id: 'provider',
      label: 'AI provider configuration',
      status: resolved.provider ? 'pass' : 'warn',
      detail: `${p.id} · ${p.model} · key from ${p.apiKeyEnvVar}: ${resolved.apiKeyPresent ? 'present' : 'missing'}`,
      ...(resolved.provider ? {} : { hint: `Export ${p.apiKeyEnvVar} to enable AI analysis, chat and fix generation. Reviews still work without it.` }),
    });
    if (options.connect && resolved.provider) {
      const started = Date.now();
      const ping = await testProvider(resolved.provider);
      checks.push({
        id: 'model-connectivity',
        label: 'Model connectivity',
        status: ping.ok ? 'pass' : 'warn',
        detail: ping.ok ? `${ping.model} responded in ${ping.latencyMs}ms` : ping.message,
        ...(ping.ok ? {} : { hint: 'Check baseUrl, model name and network access. Deterministic analysis is unaffected.' }),
      });
      void started;
    } else if (options.connect) {
      checks.push({ id: 'model-connectivity', label: 'Model connectivity', status: 'skip', detail: 'No provider is configured.' });
    }
  }

  const mcp = await findMcpConfig(service.root);
  checks.push({
    id: 'mcp',
    label: 'MCP configuration',
    status: mcp ? 'pass' : 'skip',
    detail: mcp ? `${mcp} references DiffWise` : 'no DiffWise MCP entry in .mcp.json or .vscode/mcp.json',
    ...(mcp ? {} : { hint: 'Optional. Add "diffwise-mcp" as a stdio server so coding agents can call DiffWise.' }),
  });

  const verification = service.config.verification.command;
  checks.push({
    id: 'verification',
    label: 'Verification command',
    status: verification ? 'pass' : 'skip',
    detail: verification || 'not configured (diffwise verify will report not-run)',
    ...(verification ? {} : { hint: 'Set verification.command in .diffwise/config.json, e.g. "npm test".' }),
  });

  return {
    ok: checks.every((c) => c.status !== 'fail'),
    checks,
    root: service.root,
  };
}
