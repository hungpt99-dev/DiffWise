/**
 * Rule registry and execution.
 *
 * One place decides which rules run, applies policy (enable/disable, severity
 * override, suppression, minimum severity) and records what each rule did.
 * Built-in TypeScript rules and external declarative rules are treated
 * identically from here on: the only difference is where the predicate lives.
 */
import type { FindingCategory, Severity } from '../types';
import { SEVERITY_ORDER } from '../types';
import { matchesAnyGlob } from '../util/glob';
import type { ReviewPolicy } from '../policy/types';
import { isSuppressed } from '../policy/resolve';
import type { CandidateFinding, Rule, RuleContext } from './types';
import type { RuleDefinition, RuleMode } from './definition';
import { runDeclarativeRule } from './declarative';
import type { LoadedRulePack } from './loader';

export type RuleStatus = 'ran' | 'disabled' | 'suppressed' | 'failed' | 'skipped';

export interface RuleDescriptor {
  id: string;
  name: string;
  version: string;
  category: FindingCategory;
  /** Declared severity; built-in rules decide severity per finding. */
  severity: Severity | 'per-finding';
  mode: RuleMode;
  pack: string;
  packVersion?: string;
  enabled: boolean;
  languages: string[] | 'any';
  files?: string[];
  requiresEvidence: boolean;
  description: string;
  source: 'builtin' | 'pack';
  path?: string;
  detection?: string;
  priority?: number;
  exclude?: string[];
  enforcement?: 'mandatory' | 'advisory';
  blocksGate?: boolean;
  references?: Array<{ title: string; url?: string }>;
  examples?: Array<{ bad: string; good?: string; note?: string }>;
}

export interface RuleExecutionRecord {
  id: string;
  name: string;
  pack: string;
  mode: RuleMode;
  status: RuleStatus;
  findings: number;
  durationMs: number;
  error?: string;
  reason?: string;
}

export interface RuleRunResult {
  findings: CandidateFinding[];
  records: RuleExecutionRecord[];
  /** Number of findings removed by policy (suppression, severity floor). */
  suppressed: number;
  overridden: number;
}

export interface RunRuleSetOptions {
  builtinRules: Rule[];
  packs?: LoadedRulePack[];
  policy?: ReviewPolicy;
  now?: Date;
  /** Ids the caller wants explained even if they do not run. */
  limit?: number;
}

/** Describe a built-in rule (a function with an id and a category). */
export function describeBuiltin(rule: Rule, meta?: Partial<RuleDescriptor>): RuleDescriptor {
  return {
    id: rule.id,
    name: meta?.name ?? rule.id,
    version: meta?.version ?? '1.0.0',
    category: rule.category,
    severity: 'per-finding',
    mode: 'deterministic',
    pack: 'builtin',
    enabled: true,
    languages: 'any',
    requiresEvidence: true,
    description: meta?.description ?? `Built-in deterministic rule ${rule.id}.`,
    source: 'builtin',
    ...(meta?.files ? { files: meta.files } : {}),
    ...(meta?.references ? { references: meta.references } : {}),
  };
}

export function describeDeclarative(definition: RuleDefinition, enabled: boolean): RuleDescriptor {
  return {
    id: definition.id,
    name: definition.name,
    version: definition.version,
    category: definition.category,
    severity: definition.severity,
    mode: definition.mode,
    pack: definition.provenance.pack,
    ...(definition.provenance.packVersion ? { packVersion: definition.provenance.packVersion } : {}),
    enabled,
    languages: definition.languages === 'any' ? 'any' : [...definition.languages],
    ...(definition.files ? { files: definition.files } : {}),
    requiresEvidence: definition.evidence.required,
    description: definition.description,
    source: 'pack',
    ...(definition.provenance.path ? { path: definition.provenance.path } : {}),
    detection: definition.detection.type,
    ...(definition.priority !== undefined ? { priority: definition.priority } : {}),
    ...(definition.exclude ? { exclude: definition.exclude } : {}),
    ...(definition.enforcement ? { enforcement: definition.enforcement } : {}),
    ...(definition.blocksGate ? { blocksGate: definition.blocksGate } : {}),
    ...(definition.references ? { references: definition.references } : {}),
    ...(definition.examples ? { examples: definition.examples } : {}),
  };
}

/** Every rule the platform knows about, whether or not it is enabled. */
export function listRules(options: { builtinRules: Rule[]; packs?: LoadedRulePack[]; policy?: ReviewPolicy }): RuleDescriptor[] {
  const policy = options.policy;
  const out: RuleDescriptor[] = options.builtinRules.map((rule) => {
    const enabledByPolicy = policy?.rules.enable[rule.id];
    return describeBuiltin(rule, enabledByPolicy === false ? { enabled: false } as Partial<RuleDescriptor> : undefined);
  });
  for (const pack of options.packs ?? []) {
    for (const rule of pack.rules) {
      const enabled = rule.enabled && !pack.blocked;
      out.push(describeDeclarative(rule, enabled));
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function applyPolicyToFinding(finding: CandidateFinding, policy: ReviewPolicy, now: Date): { finding: CandidateFinding | null; suppressed: boolean; overridden: boolean } {
  const suppression = isSuppressed(policy, finding.ruleId, finding.file, now);
  if (suppression) return { finding: null, suppressed: true, overridden: false };

  const floor = policy.rules.minSeverity;
  if (SEVERITY_ORDER[finding.severity] > SEVERITY_ORDER[floor]) {
    return { finding: null, suppressed: true, overridden: false };
  }
  const override = policy.rules.severityOverride[finding.ruleId];
  if (override && override !== finding.severity) {
    return { finding: { ...finding, severity: override, tags: [...finding.tags, `severity-overridden:${finding.severity}->${override}`] }, suppressed: false, overridden: true };
  }
  return { finding, suppressed: false, overridden: false };
}

/**
 * Execute every enabled rule with per-rule error isolation.
 *
 * A rule that throws does not abort the review; it is recorded as failed and
 * the report marks the deterministic stage degraded. That is the honest
 * outcome: the analysis did not fully run.
 */
export function runRuleSet(ctx: RuleContext, options: RunRuleSetOptions): RuleRunResult {
  const policy = options.policy;
  const now = options.now ?? ctx.now ?? new Date();
  const findings: CandidateFinding[] = [];
  const records: RuleExecutionRecord[] = [];
  let suppressed = 0;
  let overridden = 0;

  const finish = (raw: CandidateFinding[]): void => {
    for (const finding of raw) {
      if (policy) {
        const adjusted = applyPolicyToFinding(finding, policy, now);
        if (adjusted.suppressed) { suppressed += 1; continue; }
        if (adjusted.overridden) overridden += 1;
        if (adjusted.finding) findings.push(adjusted.finding);
      } else {
        findings.push(finding);
      }
    }
  };

  for (const rule of options.builtinRules) {
    const policyEnabled = policy?.rules.enable[rule.id];
    if (policyEnabled === false) {
      records.push({ id: rule.id, name: rule.id, pack: 'builtin', mode: 'deterministic', status: 'disabled', findings: 0, durationMs: 0, reason: 'disabled by policy' });
      continue;
    }
    const t0 = Date.now();
    try {
      const produced = rule.run(ctx);
      finish(produced);
      records.push({ id: rule.id, name: rule.id, pack: 'builtin', mode: 'deterministic', status: 'ran', findings: produced.length, durationMs: Date.now() - t0 });
    } catch (err) {
      records.push({
        id: rule.id, name: rule.id, pack: 'builtin', mode: 'deterministic', status: 'failed',
        findings: 0, durationMs: Date.now() - t0, error: (err as Error).message,
      });
    }
  }

  for (const pack of options.packs ?? []) {
    if (pack.blocked) {
      for (const rule of pack.rules) {
        records.push({ id: rule.id, name: rule.name, pack: pack.id, mode: rule.mode, status: 'skipped', findings: 0, durationMs: 0, reason: pack.blocked });
      }
      continue;
    }
    for (const rule of pack.rules) {
      const policyEnabled = policy?.rules.enable[rule.id];
      const enabled = rule.enabled && policyEnabled !== false;
      if (!enabled) {
        records.push({
          id: rule.id, name: rule.name, pack: pack.id, mode: rule.mode, status: 'disabled', findings: 0, durationMs: 0,
          reason: policyEnabled === false ? 'disabled by policy' : 'disabled in the rule definition',
        });
        continue;
      }
      if (rule.mode !== 'deterministic') {
        // AI-assisted and hybrid rules are executed by the AI layer, not here.
        records.push({
          id: rule.id, name: rule.name, pack: pack.id, mode: rule.mode, status: 'skipped', findings: 0, durationMs: 0,
          reason: `${rule.mode} rules are evaluated by the AI reviewer stage, not the deterministic engine`,
        });
        continue;
      }
      const t0 = Date.now();
      const result = runDeclarativeRule(rule, ctx);
      if (result.skipped) {
        records.push({ id: rule.id, name: rule.name, pack: pack.id, mode: rule.mode, status: 'skipped', findings: 0, durationMs: Date.now() - t0, reason: result.skipped });
        continue;
      }
      finish(result.findings);
      records.push({ id: rule.id, name: rule.name, pack: pack.id, mode: rule.mode, status: 'ran', findings: result.findings.length, durationMs: Date.now() - t0 });
    }
  }

  return { findings, records, suppressed, overridden };
}

/**
 * Reject findings whose rule is not installed and whose evidence cannot be
 * reproduced. Used after loading external packs in a CI context where a
 * malformed pack must not silently disable a required rule.
 */
export function missingRequiredPacks(packs: LoadedRulePack[], policy: ReviewPolicy): string[] {
  const installed = new Map(packs.map((p) => [p.id, p]));
  const missing: string[] = [];
  for (const requirement of policy.rulePacks.require) {
    const [id, range] = requirement.split('@');
    const pack = id ? installed.get(id) : undefined;
    if (!pack) { missing.push(requirement); continue; }
    if (pack.blocked) { missing.push(`${requirement} (${pack.blocked})`); continue; }
    if (range && pack.version !== range && !pack.version.startsWith(`${range.replace(/^\^/, '')}`)) {
      missing.push(`${requirement} (installed ${pack.version})`);
    }
  }
  return missing;
}

/** Is this file excluded by policy? */
export function isExcluded(policy: ReviewPolicy, file: string): boolean {
  return policy.exclude.globs.length > 0 && matchesAnyGlob(file, policy.exclude.globs);
}
