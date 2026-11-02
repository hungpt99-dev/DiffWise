/**
 * Rule management.
 *
 * The review engine already loads declarative rules from `.diffwise/rules`.
 * This module is the write side of that contract: create, edit, disable, delete,
 * import, export and test a rule without hand-editing YAML. Every write goes
 * through the same validator the engine uses, so a rule the editor accepts is a
 * rule the review can run — there is no second rule schema.
 *
 * Custom rules live in one managed pack (`custom`) with one file per rule. That
 * keeps a user edit from rewriting an imported organisation pack, and it makes
 * "delete this rule" a file deletion rather than a YAML surgery.
 */
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import type { Confidence, FindingCategory, Language, Severity } from '../types';
import { detectLanguage } from '../analysis/languages';
import { matchesAnyGlob } from '../util/glob';
import { regexRisk, validateRuleDefinition, type RuleDefinition, type RuleDetection, type RuleValidationIssue } from './definition';
import { loadRulePacks, type LoadedRulePack } from './loader';
import { runDeclarativeRule } from './declarative';
import type { RuleContext } from './types';

export const CUSTOM_PACK_ID = 'custom';
export const CUSTOM_RULES_DIR = '.diffwise/rules/custom';
export const RULE_CATEGORIES: FindingCategory[] = [
  'architecture', 'security', 'performance', 'database', 'concurrency', 'api-contract',
  'maintainability', 'reliability', 'error-handling', 'tests', 'documentation',
  'correctness', 'resources', 'configuration',
];

/** What a rule editor submits. Unknown fields are rejected by validation. */
export interface RuleDraft {
  id: string;
  name: string;
  version?: string;
  category: FindingCategory;
  severity: Severity;
  confidence?: Confidence;
  description: string;
  recommendation: string;
  files?: string[];
  exclude?: string[];
  languages?: Language[] | 'any';
  frameworks?: string[];
  priority?: number;
  enabled?: boolean;
  enforcement?: 'mandatory' | 'advisory';
  blocksGate?: boolean;
  detection: RuleDetection;
  tags?: string[];
}

export interface ManagedRule {
  id: string;
  name: string;
  category: FindingCategory;
  severity: Severity;
  confidence: Confidence;
  enabled: boolean;
  priority: number;
  enforcement: 'mandatory' | 'advisory';
  blocksGate: boolean;
  files: string[];
  exclude: string[];
  languages: Language[] | 'any';
  description: string;
  recommendation: string;
  detection: RuleDetection;
  pack: string;
  path?: string;
  builtin: boolean;
  editable: boolean;
}

export interface RuleTestMatch {
  file: string;
  line: number;
  endLine: number;
  snippet: string;
  note: string;
}

export interface RuleTestResult {
  ruleId: string;
  valid: boolean;
  issues: RuleValidationIssue[];
  matches: RuleTestMatch[];
  filesScanned: number;
  filesMatched: number;
  /** Files whose language or scope excludes them from this rule. */
  skipped: number;
  durationMs: number;
}

export interface RuleStoreOptions {
  /** Repository root. */
  root: string;
  /** Overrides the managed pack directory, for tests. */
  dir?: string;
}

function managedDir(root: string, dir?: string): string {
  return dir ? resolve(root, dir) : join(root, CUSTOM_RULES_DIR);
}

function fileNameFor(id: string): string {
  return `${id.replace(/[^a-z0-9.-]/g, '-')}.yaml`;
}

function asIssueList(issues: RuleValidationIssue[]): RuleValidationIssue[] {
  return [...issues].sort((a, b) => (a.level === b.level ? a.message.localeCompare(b.message) : a.level === 'error' ? -1 : 1));
}

/** Validate a draft through the engine's own validator, without writing it. */
export function validateDraft(draft: RuleDraft, path = '<draft>'): { definition: RuleDefinition | null; issues: RuleValidationIssue[] } {
  const issues: RuleValidationIssue[] = [];
  const definition = validateRuleDefinition(
    {
      ...draft,
      version: draft.version ?? '1.0.0',
      enabled: draft.enabled ?? true,
      confidence: draft.confidence ?? 'medium',
      languages: draft.languages ?? 'any',
      evidence: { required: true },
    },
    path,
    { pack: CUSTOM_PACK_ID, packVersion: '1.0.0', path },
    issues,
  );
  for (const value of draft.files ?? []) {
    if (value.trim().length === 0) issues.push({ level: 'error', path, message: 'files contains an empty glob' });
  }
  if (draft.detection.type === 'pattern') {
    const risk = regexRisk(draft.detection.pattern);
    if (risk.level === 'rejected' && !issues.some((i) => i.message.includes('detected'))) {
      issues.push({ level: 'error', path, message: `detection.pattern was rejected: ${risk.reason ?? 'unsafe regular expression'}` });
    }
  }
  return { definition, issues: asIssueList(issues) };
}

/** Serialise a definition to the YAML written on disk. */
export function ruleToYaml(rule: RuleDefinition): string {
  return yaml.dump(
    {
      id: rule.id,
      name: rule.name,
      version: rule.version,
      category: rule.category,
      severity: rule.severity,
      confidence: rule.confidence,
      enabled: rule.enabled,
      mode: rule.mode,
      languages: rule.languages,
      ...(rule.frameworks?.length ? { frameworks: rule.frameworks } : {}),
      ...(rule.files?.length ? { files: rule.files } : {}),
      ...(rule.exclude?.length ? { exclude: rule.exclude } : {}),
      ...(rule.priority !== undefined ? { priority: rule.priority } : {}),
      ...(rule.enforcement ? { enforcement: rule.enforcement } : {}),
      ...(typeof rule.blocksGate === 'boolean' ? { blocksGate: rule.blocksGate } : {}),
      description: rule.description,
      detection: rule.detection,
      evidence: rule.evidence,
      recommendation: rule.recommendation,
      ...(rule.references?.length ? { references: rule.references } : {}),
      ...(rule.examples?.length ? { examples: rule.examples } : {}),
      ...(rule.tags?.length ? { tags: rule.tags } : {}),
    },
    { lineWidth: 110, noRefs: true },
  );
}

export function describeManaged(rule: RuleDefinition, builtin = false): ManagedRule {
  const priority = rule.priority ?? (builtin ? 1000 : 100);
  return {
    id: rule.id,
    name: rule.name,
    category: rule.category,
    severity: rule.severity,
    confidence: rule.confidence,
    enabled: rule.enabled,
    priority,
    enforcement: rule.enforcement ?? 'mandatory',
    blocksGate: rule.blocksGate ?? false,
    files: rule.files ?? [],
    exclude: rule.exclude ?? [],
    languages: rule.languages,
    description: rule.description,
    recommendation: rule.recommendation,
    detection: rule.detection,
    pack: rule.provenance.pack,
    ...(rule.provenance.path ? { path: rule.provenance.path } : {}),
    builtin,
    editable: !builtin,
  };
}

export class RuleStore {
  private readonly dir: string;

  constructor(private readonly options: RuleStoreOptions) {
    this.dir = managedDir(options.root, options.dir);
  }

  get directory(): string { return this.dir; }

  private async pack(): Promise<LoadedRulePack> {
    const loaded = await loadRulePacks([this.dir]);
    const pack = loaded.packs[0];
    if (pack) return pack;
    return {
      id: CUSTOM_PACK_ID,
      name: 'Custom rules',
      version: '1.0.0',
      path: this.dir,
      rules: [],
      issues: loaded.issues,
    };
  }

  /** Every custom rule, including invalid definitions (they carry issues). */
  async list(): Promise<{ rules: ManagedRule[]; issues: RuleValidationIssue[] }> {
    const pack = await this.pack();
    return {
      rules: pack.rules.map((rule) => describeManaged(rule)).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)),
      issues: pack.issues,
    };
  }

  async get(id: string): Promise<ManagedRule | null> {
    const { rules } = await this.list();
    return rules.find((rule) => rule.id === id) ?? null;
  }

  /** Create a rule. Refuses to overwrite an existing custom rule. */
  async create(draft: RuleDraft): Promise<{ rule?: ManagedRule; issues: RuleValidationIssue[] }> {
    const existing = await this.get(draft.id);
    if (existing) {
      return { issues: [{ level: 'error', path: draft.id, message: `rule "${draft.id}" already exists; update it instead` }] };
    }
    return this.write(draft);
  }

  /** Update a custom rule in place. Built-ins are never editable. */
  async update(id: string, draft: RuleDraft): Promise<{ rule?: ManagedRule; issues: RuleValidationIssue[] }> {
    const existing = await this.get(id);
    if (!existing) {
      return { issues: [{ level: 'error', path: id, message: `no custom rule "${id}"` }] };
    }
    if (draft.id !== id) {
      return { issues: [{ level: 'error', path: id, message: 'the rule id cannot change; create a new rule instead' }] };
    }
    return this.write(draft, existing);
  }

  private async write(draft: RuleDraft, previous?: ManagedRule): Promise<{ rule?: ManagedRule; issues: RuleValidationIssue[] }> {
    const path = previous?.path ?? join(CUSTOM_RULES_DIR, fileNameFor(draft.id));
    const { definition, issues } = validateDraft(draft, path);
    if (!definition) return { issues };
    const errors = issues.filter((issue) => issue.level === 'error');
    if (errors.length > 0) return { issues };
    await mkdir(this.dir, { recursive: true });
    const target = join(this.dir, fileNameFor(draft.id));
    await writeFile(target, ruleToYaml(definition), 'utf8');
    // A rename never happens (ids are immutable), so there is no stale file to
    // remove. The reload is what proves the file is loadable by the engine.
    const reloaded = await this.get(definition.id);
    if (!reloaded) {
      return { issues: [...issues, { level: 'error', path, message: 'rule was written but could not be loaded back' }] };
    }
    return { rule: reloaded, issues };
  }

  async setEnabled(id: string, enabled: boolean): Promise<{ rule?: ManagedRule; issues: RuleValidationIssue[] }> {
    const rule = await this.get(id);
    if (!rule) return { issues: [{ level: 'error', path: id, message: `no custom rule "${id}"` }] };
    return this.write({ ...managedToDraft(rule), enabled }, rule);
  }

  async remove(id: string): Promise<{ removed: boolean; issues: RuleValidationIssue[] }> {
    const rule = await this.get(id);
    if (!rule) return { removed: false, issues: [{ level: 'error', path: id, message: `no custom rule "${id}"` }] };
    const file = join(this.dir, fileNameFor(id));
    try {
      await unlink(file);
      return { removed: true, issues: [] };
    } catch (err) {
      return { removed: false, issues: [{ level: 'error', path: file, message: (err as Error).message }] };
    }
  }

  /**
   * Import a rule pack file or a single rule.
   *
   * Import is an upsert by id, but it validates first: a partially invalid
   * import writes nothing, so the store never holds a half-imported pack.
   */
  async import(source: string): Promise<{ imported: ManagedRule[]; issues: RuleValidationIssue[] }> {
    let raw: unknown;
    try {
      raw = yaml.load(source);
    } catch (err) {
      return { imported: [], issues: [{ level: 'error', path: '<import>', message: `not valid YAML: ${(err as Error).message}` }] };
    }
    const list = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object' && Array.isArray((raw as { rules?: unknown[] }).rules)
        ? (raw as { rules: unknown[] }).rules
        : [raw];
    const drafts: RuleDraft[] = [];
    const issues: RuleValidationIssue[] = [];
    for (const candidate of list) {
      if (!candidate || typeof candidate !== 'object') {
        issues.push({ level: 'error', path: '<import>', message: 'import entry is not an object' });
        continue;
      }
      const record = candidate as Record<string, unknown>;
      const draft = record as unknown as RuleDraft;
      // A pack export has no provenance; validation ignores it anyway.
      const check = validateDraft(draft, `<import:${String(record.id ?? '?')}>`);
      issues.push(...check.issues);
      if (!check.definition) continue;
      drafts.push({
        ...draft,
        version: check.definition.version,
        confidence: check.definition.confidence,
        enabled: check.definition.enabled,
        languages: check.definition.languages,
      });
    }
    if (issues.some((issue) => issue.level === 'error')) return { imported: [], issues };
    const imported: ManagedRule[] = [];
    for (const draft of drafts) {
      const result = await this.createOrReplace(draft);
      issues.push(...result.issues);
      if (result.rule) imported.push(result.rule);
    }
    return { imported, issues };
  }

  /** Upsert semantics used by import only. */
  private async createOrReplace(draft: RuleDraft): Promise<{ rule?: ManagedRule; issues: RuleValidationIssue[] }> {
    const existing = await this.get(draft.id);
    return existing ? this.write(draft, existing) : this.write(draft);
  }

  /** YAML for every custom rule, or one rule when `id` is given. */
  async export(id?: string): Promise<{ yaml: string; count: number }> {
    const { rules } = await this.list();
    const selected = id ? rules.filter((rule) => rule.id === id) : rules;
    if (selected.length === 0) return { yaml: '', count: 0 };
    if (id && selected[0]) {
      const definition = (await this.pack()).rules.find((rule) => rule.id === id);
      return { yaml: definition ? ruleToYaml(definition) : '', count: definition ? 1 : 0 };
    }
    return {
      yaml: yaml.dump(
        {
          id: CUSTOM_PACK_ID,
          name: 'Custom rules',
          version: '1.0.0',
          rules: (await this.pack()).rules.map((rule) => yaml.load(ruleToYaml(rule))),
        },
        { lineWidth: 110, noRefs: true },
      ),
      count: selected.length,
    };
  }
}

export function managedToDraft(rule: ManagedRule): RuleDraft {
  return {
    id: rule.id,
    name: rule.name,
    category: rule.category,
    severity: rule.severity,
    confidence: rule.confidence,
    description: rule.description,
    recommendation: rule.recommendation,
    detection: rule.detection,
    files: rule.files,
    exclude: rule.exclude,
    languages: rule.languages,
    priority: rule.priority,
    enabled: rule.enabled,
    enforcement: rule.enforcement,
    blocksGate: rule.blocksGate,
  };
}

/** A FileChange whose every line is an addition, so `scope: added` rules see it. */
function syntheticChange(path: string, content: string) {
  const lines = content.split(/\r\n|\n|\r/);
  return {
    path,
    status: 'modified' as const,
    additions: lines.length,
    deletions: 0,
    binary: false,
    language: detectLanguage(path),
    patch: '',
    hunks: [{
      oldStart: 1, oldLines: 0, newStart: 1, newLines: lines.length, header: '@@ -0,0 +1 @@',
      lines: lines.map((text, index) => ({ kind: 'add' as const, text, newLine: index + 1 })),
    }],
  };
}

export interface TestRuleOptions {
  /** Repository files. Only files inside the rule's scope are scanned. */
  files: Map<string, string>;
  /** Cap to keep an interactive test bounded. */
  maxFiles?: number;
  maxMatches?: number;
}

/**
 * Run one rule against repository files without a review.
 *
 * This is the "test before enabling" path: identical detector, identical
 * context shape, no persistence and no model. It reports what it scanned and
 * what it skipped, because a rule that silently matches nothing is usually a
 * rule with the wrong scope, not a clean repository.
 */
export function testRule(draft: RuleDraft, options: TestRuleOptions): RuleTestResult {
  const started = Date.now();
  const { definition, issues } = validateDraft(draft);
  if (!definition) {
    return { ruleId: draft.id, valid: false, issues, matches: [], filesScanned: 0, filesMatched: 0, skipped: 0, durationMs: Date.now() - started };
  }
  const maxFiles = options.maxFiles ?? 800;
  const maxMatches = options.maxMatches ?? 50;
  const selected: Array<[string, string]> = [];
  let skipped = 0;
  for (const [path, content] of options.files) {
    if (selected.length >= maxFiles) break;
    if (definition.files && definition.files.length > 0 && !matchesAnyGlob(path, definition.files)) { skipped += 1; continue; }
    if (definition.exclude && definition.exclude.length > 0 && matchesAnyGlob(path, definition.exclude)) { skipped += 1; continue; }
    const language = detectLanguage(path);
    const languageOk = definition.languages === 'any'
      || definition.languages.includes(language)
      || (language === 'tsx' && definition.languages.includes('typescript'))
      || (language === 'jsx' && definition.languages.includes('javascript'));
    if (!languageOk) { skipped += 1; continue; }
    selected.push([path, content]);
  }
  const changes = selected.map(([path, content]) => syntheticChange(path, content));
  const contents = new Map(selected);
  const ctx: RuleContext = {
    changes,
    contents,
    oldContents: new Map(selected.map(([path]) => [path, null])),
    repoFiles: options.files,
    symbols: [],
    docs: [],
    docTexts: new Map(),
    tests: { files: [], uncoveredChanges: [], uncoveredSymbols: [], deletedTests: [], suggestions: [] },
    graph: {
      edges: [], importers: {}, changedFiles: changes.map((c) => c.path), directlyImpacted: [],
      indirectlyImpacted: [], impactDepth: {}, cycles: [], newCoupling: [], removedCoupling: [],
      boundaryChanges: [], modules: [], fileCount: options.files.size, edgeCount: 0,
    },
    settings: {
      maxFiles, maxFileBytes: 400_000, maxEvidenceSnippets: 40, ignoreGlobs: [],
      aiEnabled: false, sendRepositoryContent: false, providerId: 'none',
    },
    now: new Date(),
  };
  const result = runDeclarativeRule(definition, ctx);
  const matches = result.findings.slice(0, maxMatches).map((finding) => ({
    file: finding.file,
    line: finding.range.start,
    endLine: finding.range.end,
    snippet: finding.evidence[0]?.snippet ?? '',
    note: finding.evidence[0]?.note ?? finding.title,
  }));
  return {
    ruleId: definition.id,
    valid: true,
    issues,
    matches,
    filesScanned: changes.length,
    filesMatched: new Set(matches.map((m) => m.file)).size,
    skipped,
    durationMs: Date.now() - started,
  };
}

/**
 * Conflicts a rule manager must surface.
 *
 * Two definitions of one id, a policy enable that names an unknown rule, and a
 * severity override that contradicts a mandatory rule's floor are all real
 * configuration bugs that otherwise fail silently.
 */
export function detectRuleConflicts(input: {
  builtinIds: string[];
  packs: LoadedRulePack[];
  policy?: { enable?: Record<string, boolean>; severityOverride?: Record<string, Severity>; suppress?: Array<{ ruleId: string }> };
}): Array<{ level: 'error' | 'warning'; id: string; message: string }> {
  const out: Array<{ level: 'error' | 'warning'; id: string; message: string }> = [];
  const seen = new Map<string, string>();
  for (const pack of input.packs) {
    for (const rule of pack.rules) {
      const previous = seen.get(rule.id);
      if (previous && previous !== pack.id) {
        out.push({ level: 'error', id: rule.id, message: `defined in both "${previous}" and "${pack.id}"; the last loaded pack wins` });
      }
      seen.set(rule.id, pack.id);
    }
  }
  const known = new Set([...input.builtinIds, ...seen.keys()]);
  for (const id of Object.keys(input.policy?.enable ?? {})) {
    if (!known.has(id)) out.push({ level: 'warning', id, message: 'policy enables a rule that is not installed' });
  }
  for (const id of Object.keys(input.policy?.severityOverride ?? {})) {
    if (!known.has(id)) out.push({ level: 'warning', id, message: 'policy overrides a severity for a rule that is not installed' });
  }
  for (const suppression of input.policy?.suppress ?? []) {
    if (!known.has(suppression.ruleId) && suppression.ruleId !== '*') {
      out.push({ level: 'warning', id: suppression.ruleId, message: 'policy suppresses a rule that is not installed' });
    }
  }
  return out;
}

/** Category metadata for the rule manager UI. */
export const RULE_CATEGORY_META: Array<{ id: FindingCategory; label: string; description: string }> = [
  { id: 'architecture', label: 'Architecture', description: 'Layering, boundaries and dependency direction.' },
  { id: 'security', label: 'Security', description: 'Authentication, authorization, injection and secrets.' },
  { id: 'performance', label: 'Performance', description: 'Cost that grows with input or blocks a shared resource.' },
  { id: 'database', label: 'Database', description: 'Queries, transactions, migrations and data integrity.' },
  { id: 'concurrency', label: 'Concurrency', description: 'Races, locks, idempotency and ordering.' },
  { id: 'api-contract', label: 'API design', description: 'Breaking changes to endpoints and payloads.' },
  { id: 'maintainability', label: 'Maintainability', description: 'Coupling, duplication and readability with a cost.' },
  { id: 'reliability', label: 'Reliability', description: 'Failure handling, timeouts and retries.' },
  { id: 'error-handling', label: 'Error handling', description: 'Swallowed errors, wrong error types, lost context.' },
  { id: 'tests', label: 'Testing', description: 'Missing, weak or deleted tests.' },
  { id: 'documentation', label: 'Documentation', description: 'Documentation that no longer matches the code.' },
  { id: 'correctness', label: 'Business logic', description: 'Domain invariants and calculation defects.' },
  { id: 'resources', label: 'Resources', description: 'Leaked handles, listeners and unbounded buffers.' },
  { id: 'configuration', label: 'Configuration', description: 'Environment, feature flags and deployment settings.' },
];

/** Read every tracked file under a root, bounded, for the rule tester. */
export async function readRepositoryFiles(input: {
  root: string;
  paths: string[];
  ignoreGlobs?: string[];
  maxFiles?: number;
  maxFileBytes?: number;
}): Promise<Map<string, string>> {
  const maxFiles = input.maxFiles ?? 1200;
  const maxFileBytes = input.maxFileBytes ?? 400_000;
  const files = new Map<string, string>();
  const ignored = input.ignoreGlobs ?? ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'];
  for (const path of input.paths) {
    if (files.size >= maxFiles) break;
    if (matchesAnyGlob(path, ignored)) continue;
    try {
      const content = await readFile(join(input.root, path), 'utf8');
      if (content.length <= maxFileBytes) files.set(path.replace(/\\/g, '/'), content);
    } catch {
      // Binary or unreadable files are simply not testable inputs.
    }
  }
  return files;
}
