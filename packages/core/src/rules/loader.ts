/**
 * Rule pack loading.
 *
 * A pack is a directory containing `pack.yaml` (or `.yml`/`.json`) and any
 * number of rule files under it. Packs are untrusted input: paths are resolved
 * inside the pack directory, symlinks that escape it are refused, regexes are
 * screened, and every problem is reported with the file that caused it.
 *
 * Loading never throws for a bad pack — it returns the issues so `diffwise rules
 * validate` can print them and a review can record "this pack did not load".
 */
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import yaml from 'js-yaml';
import {
  satisfiesVersion,
  validateRuleDefinition,
  type RuleDefinition,
  type RuleProvenance,
  type RuleValidationIssue,
} from './definition';

export interface RulePackMeta {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Pack dependencies, e.g. `security@^1.0.0`. */
  requires?: string[];
  author?: string;
  license?: string;
}

export interface LoadedRulePack extends RulePackMeta {
  /** Directory the pack was loaded from. */
  path: string;
  rules: RuleDefinition[];
  issues: RuleValidationIssue[];
  /** True when a dependency was missing or incompatible. */
  blocked?: string;
}

export interface LoadRulePacksResult {
  packs: LoadedRulePack[];
  issues: RuleValidationIssue[];
}

const RULE_FILE = /\.(ya?ml|json)$/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDocument(text: string, path: string): unknown {
  if (path.endsWith('.json')) return JSON.parse(text) as unknown;
  return yaml.load(text);
}

/** True when `child` resolves inside `parent`. */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function readJsonOrYaml(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8');
  return parseDocument(text, path);
}

/** Resolve a path inside the pack, refusing escapes. */
async function safeResolve(root: string, candidate: string): Promise<string | null> {
  const absolute = resolve(root, candidate);
  if (!isInside(root, absolute)) return null;
  try {
    const real = await realpath(absolute);
    return isInside(root, real) ? real : null;
  } catch {
    return null;
  }
}

async function collectRuleFiles(dir: string, root: string, out: string[], depth = 0): Promise<void> {
  if (depth > 6) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      await collectRuleFiles(full, root, out, depth + 1);
      continue;
    }
    if (!entry.isFile() || !RULE_FILE.test(entry.name)) continue;
    if (entry.name.startsWith('pack.')) continue;
    const safe = await safeResolve(root, relative(root, full));
    if (!safe) continue;
    out.push(safe);
  }
}

async function findPackMeta(dir: string): Promise<{ meta: RulePackMeta; file: string } | null> {
  for (const name of ['pack.yaml', 'pack.yml', 'pack.json']) {
    const candidate = join(dir, name);
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      const raw = await readJsonOrYaml(candidate);
      if (!isObject(raw)) return null;
      const id = typeof raw.id === 'string' ? raw.id : '';
      const version = typeof raw.version === 'string' ? raw.version : '';
      if (!id || !version) return null;
      return {
        file: candidate,
        meta: {
          id,
          version,
          name: typeof raw.name === 'string' ? raw.name : id,
          ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
          ...(Array.isArray(raw.requires) ? { requires: raw.requires.filter((r): r is string => typeof r === 'string') } : {}),
          ...(typeof raw.author === 'string' ? { author: raw.author } : {}),
          ...(typeof raw.license === 'string' ? { license: raw.license } : {}),
        },
      };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Load one pack directory. If `pack.yaml` is absent the directory is treated as
 * a bare collection of rule files with an id derived from the directory name,
 * which keeps small in-repo rule folders usable.
 */
export async function loadRulePack(dir: string): Promise<LoadedRulePack> {
  const issues: RuleValidationIssue[] = [];
  const root = await realpath(dir);
  const found = await findPackMeta(root);
  const meta: RulePackMeta = found?.meta ?? {
    id: normalize(dir).split(/[\\/]/).filter(Boolean).pop()?.toLowerCase().replace(/[^a-z0-9.-]/g, '-') ?? 'rules',
    name: normalize(dir).split(/[\\/]/).filter(Boolean).pop() ?? 'rules',
    version: '0.0.0',
  };
  if (!found) {
    issues.push({
      level: 'warning',
      path: dir,
      message: 'no pack.yaml found; the pack id and version were derived from the directory name',
    });
  }

  const files: string[] = [];
  await collectRuleFiles(root, root, files);

  const rules: RuleDefinition[] = [];
  for (const file of files) {
    let raw: unknown;
    try {
      raw = await readJsonOrYaml(file);
    } catch (err) {
      issues.push({ level: 'error', path: file, message: `could not be parsed: ${(err as Error).message}` });
      continue;
    }
    const provenance: RuleProvenance = {
      pack: meta.id,
      packVersion: meta.version,
      path: relative(root, file),
    };
    // A file may hold one rule, a list of rules, or `{ rules: [...] }`.
    const candidates: unknown[] = Array.isArray(raw)
      ? raw
      : isObject(raw) && Array.isArray(raw.rules)
        ? (raw.rules as unknown[])
        : [raw];
    for (const candidate of candidates) {
      const definition = validateRuleDefinition(candidate, file, provenance, issues);
      if (definition) rules.push(definition);
    }
  }

  const seen = new Map<string, RuleDefinition>();
  for (const rule of rules) {
    const existing = seen.get(rule.id);
    if (existing) {
      issues.push({
        level: 'error',
        path: rule.provenance.path ?? dir,
        message: `duplicate rule id "${rule.id}" (also defined in ${existing.provenance.path ?? 'another file'}); the later definition wins`,
      });
    }
    seen.set(rule.id, rule);
  }

  return { ...meta, path: root, rules: [...seen.values()], issues };
}

/** Apply `extends` inheritance and pack dependency checks. */
export function linkRulePacks(packs: LoadedRulePack[]): LoadRulePacksResult {
  const issues: RuleValidationIssue[] = [];
  const byId = new Map(packs.map((p) => [p.id, p]));

  for (const pack of packs) {
    for (const requirement of pack.requires ?? []) {
      const [depId, depRange] = requirement.split('@');
      const dep = depId ? byId.get(depId) : undefined;
      if (!dep) {
        pack.blocked = `required pack "${depId ?? requirement}" is not installed`;
        issues.push({ level: 'error', path: pack.path, message: pack.blocked });
        continue;
      }
      if (!satisfiesVersion(dep.version, depRange)) {
        pack.blocked = `required pack "${depId}" version ${dep.version} does not satisfy ${depRange ?? 'any'}`;
        issues.push({ level: 'error', path: pack.path, message: pack.blocked });
      }
    }
  }

  // Rule inheritance: copy the parent detection unless the child overrides it.
  const allRules = new Map<string, RuleDefinition>();
  for (const pack of packs) for (const rule of pack.rules) allRules.set(rule.id, rule);
  for (const pack of packs) {
    pack.rules = pack.rules.map((rule) => {
      if (!rule.extends) return rule;
      const parent = allRules.get(rule.extends);
      if (!parent) {
        issues.push({ level: 'error', path: rule.provenance.path ?? pack.path, message: `rule "${rule.id}" extends unknown rule "${rule.extends}"` });
        return rule;
      }
      const merged: RuleDefinition = { ...parent, ...rule, provenance: rule.provenance, extends: rule.extends };
      if (rule.inheritsDetection) merged.detection = parent.detection;
      return merged;
    });
  }

  return { packs, issues: [...issues, ...packs.flatMap((p) => p.issues)] };
}

/** Load several pack directories and link them. */
export async function loadRulePacks(dirs: string[]): Promise<LoadRulePacksResult> {
  const packs: LoadedRulePack[] = [];
  const issues: RuleValidationIssue[] = [];
  for (const dir of dirs) {
    try {
      const info = await stat(dir);
      if (!info.isDirectory()) {
        issues.push({ level: 'error', path: dir, message: 'not a directory' });
        continue;
      }
      packs.push(await loadRulePack(dir));
    } catch (err) {
      issues.push({ level: 'error', path: dir, message: `could not be read: ${(err as Error).message}` });
    }
  }
  return linkRulePacks(packs);
}

/**
 * Load every pack under `<repo>/.diffwise/rules/`.
 *
 * Named directories are loaded first (so a pack can be installed by path), then
 * anything in the repository folder. Duplicate ids keep the first definition.
 */
export async function loadRepositoryRulePacks(root: string, extraDirs: string[] = []): Promise<LoadRulePacksResult> {
  const base = join(root, '.diffwise', 'rules');
  const dirs = [...extraDirs];
  try {
    const entries = await readdir(base, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(join(base, entry.name));
    }
    // Rule files directly inside `.diffwise/rules/` form one implicit pack.
    if (entries.some((e) => e.isFile() && RULE_FILE.test(e.name))) dirs.push(base);
  } catch {
    // No rule directory: nothing to load, which is not an error.
  }
  const seen = new Set<string>();
  const unique = dirs.filter((d) => {
    const key = resolve(d);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return loadRulePacks(unique);
}

/** Serialise a pack back to YAML for `diffwise rules export`. */
export function exportRulePack(pack: LoadedRulePack): string {
  return yaml.dump(
    {
      id: pack.id,
      name: pack.name,
      version: pack.version,
      ...(pack.description ? { description: pack.description } : {}),
      ...(pack.requires?.length ? { requires: pack.requires } : {}),
      rules: pack.rules.map((rule) => ({
        id: rule.id,
        name: rule.name,
        version: rule.version,
        category: rule.category,
        severity: rule.severity,
        confidence: rule.confidence,
        enabled: rule.enabled,
        mode: rule.mode,
        languages: rule.languages,
        ...(rule.frameworks ? { frameworks: rule.frameworks } : {}),
        ...(rule.files ? { files: rule.files } : {}),
        description: rule.description,
        detection: rule.detection,
        evidence: rule.evidence,
        recommendation: rule.recommendation,
        ...(rule.references ? { references: rule.references } : {}),
        ...(rule.tags ? { tags: rule.tags } : {}),
      })),
    },
    { lineWidth: 120, noRefs: true },
  );
}

export { dirname };
