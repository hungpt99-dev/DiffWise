/**
 * Policy file loading.
 *
 * Four layers, each optional:
 *
 *   organization  $DIFFWISE_ORG_POLICY, or ~/.config/diffwise/org-policy.{json,yaml}
 *   repository    .diffwise/policy.{json,yaml}
 *   directory     .diffwise/policies/*.{json,yaml}   (each declares `appliesTo`)
 *   file          .diffwise/policies/files/*.{json,yaml} (each declares `appliesTo`)
 *
 * Files are untrusted: they are parsed, validated by `normalizePolicyLayer`, and a
 * file that does not parse becomes a reported layer error, never a silent skip.
 */
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import yaml from 'js-yaml';
import type { PolicyLayerInput, PolicyLayerKind } from '@diffwise/core';

export interface PolicyFileProblem {
  path: string;
  message: string;
}

export interface LoadedPolicyFiles {
  layers: PolicyLayerInput[];
  problems: PolicyFileProblem[];
  /** Files that were read, for the report's context-source list. */
  sources: string[];
}

function parseDocument(text: string, path: string): unknown {
  if (path.endsWith('.json')) return JSON.parse(text) as unknown;
  return yaml.load(text);
}

async function readLayer(path: string, kind: PolicyLayerKind, defaultAppliesTo: string, out: LoadedPolicyFiles): Promise<void> {
  try {
    const text = await readFile(path, 'utf8');
    const raw = parseDocument(text, path);
    out.sources.push(path);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      out.problems.push({ path, message: 'policy file must contain an object' });
      return;
    }
    const record = raw as Record<string, unknown>;
    const appliesTo = typeof record.appliesTo === 'string' ? record.appliesTo : defaultAppliesTo;
    const { appliesTo: _ignored, ...policy } = record;
    void _ignored;
    out.layers.push({ kind, source: path, appliesTo, value: policy });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    out.problems.push({ path, message: (err as Error).message });
  }
}

async function listPolicyDir(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && /\.(json|ya?ml)$/i.test(e.name) && !e.name.startsWith('.'))
      .map((e) => join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * `appliesTo` for a directory layer defaults to the package/module the file
 * sits in, so `services/billing/.diffwise/policy.json` governs `services/billing/**`.
 */
function defaultAppliesToFor(dir: string, root: string): string {
  const rel = dir.startsWith(root) ? dir.slice(root.length).replace(/^[/\\]/, '') : '';
  if (!rel) return '**';
  return `${rel.replace(/\\/g, '/')}/**`;
}

export async function loadPolicyFiles(root: string, env: NodeJS.ProcessEnv = process.env): Promise<LoadedPolicyFiles> {
  const out: LoadedPolicyFiles = { layers: [], problems: [], sources: [] };

  const orgPath = env.DIFFWISE_ORG_POLICY;
  if (orgPath) {
    await readLayer(orgPath, 'organization', '**', out);
  } else {
    for (const ext of ['json', 'yaml', 'yml']) {
      const candidate = join(homedir(), '.config', 'diffwise', `org-policy.${ext}`);
      const before = out.sources.length;
      await readLayer(candidate, 'organization', '**', out);
      if (out.sources.length > before) break;
    }
  }

  for (const ext of ['json', 'yaml', 'yml']) {
    const candidate = join(root, '.diffwise', `policy.${ext}`);
    const before = out.sources.length;
    await readLayer(candidate, 'repository', '**', out);
    if (out.sources.length > before) break;
  }

  for (const path of await listPolicyDir(join(root, '.diffwise', 'policies'))) {
    const name = basename(path);
    const kind: PolicyLayerKind = name.startsWith('file-') ? 'file' : 'directory';
    const appliesTo = kind === 'file' ? '**' : `**`;
    await readLayer(path, kind, appliesTo, out);
  }

  for (const path of await listPolicyDir(join(root, '.diffwise', 'policies', 'files'))) {
    await readLayer(path, 'file', '**', out);
  }

  // Nested policies: `<dir>/.diffwise/policy.{json,yaml}` for monorepos.
  for (const dir of await findNestedPolicyDirs(root)) {
    for (const ext of ['json', 'yaml', 'yml']) {
      await readLayer(join(dir, '.diffwise', `policy.${ext}`), 'directory', defaultAppliesToFor(dir, root), out);
    }
  }

  return out;
}

async function findNestedPolicyDirs(root: string, depth = 0): Promise<string[]> {
  if (depth > 2) return [];
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.diffwise' || entry.name.startsWith('.')) continue;
    const child = join(root, entry.name);
    try {
      const inner = await readdir(child);
      if (inner.includes('.diffwise')) out.push(child);
    } catch {
      continue;
    }
    out.push(...await findNestedPolicyDirs(child, depth + 1));
  }
  return out;
}
