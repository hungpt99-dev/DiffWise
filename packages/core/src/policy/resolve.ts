/**
 * Policy validation and precedence resolution.
 *
 * Layers are applied org → repository → directory → file. Objects merge deeply,
 * arrays append (order preserved), and every supplied leaf is recorded in
 * `provenance` so the UI can answer "who asked for this?".
 *
 * Unknown keys are reported as warnings rather than ignored silently: a typo in
 * a policy file that quietly does nothing is a security problem.
 */
import type { Severity } from '../types';
import {
  DEFAULT_POLICY,
  POLICY_SCHEMA_VERSION,
  type EffectivePolicy,
  type EffectivePolicySnapshot,
  type ForbiddenPattern,
  type PolicyLayerInput,
  type PolicyLayerState,
  type ReviewPolicy,
  type SuppressionRule,
  type VerificationCommandSpec,
} from './types';
import type { ReviewerId } from '../review/types';
import { REVIEWER_IDS } from '../review/types';
import { matchesAnyGlob } from '../util/glob';

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === 'string');
  return out.length === value.length ? out : out;
}

function asSeverity(value: unknown): Severity | undefined {
  return SEVERITIES.includes(value as Severity) ? (value as Severity) : undefined;
}

function warnUnknown(warnings: string[], scope: string, object: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) warnings.push(`${scope}.${key} is not a recognised field and was ignored`);
  }
}

const REVIEWER_SET = new Set<string>(REVIEWER_IDS);

/** Validate and coerce one layer. Never throws: problems become warnings/errors. */
export function normalizePolicyLayer(raw: unknown, source: string): { value: Partial<ReviewPolicy>; warnings: string[]; error?: string } {
  const warnings: string[] = [];
  if (!isObject(raw)) return { value: {}, warnings, error: `${source} does not contain a JSON/YAML object` };
  warnUnknown(warnings, source, raw, [
    'schemaVersion', 'rulePacks', 'rules', 'reviewers', 'verification', 'risk', 'approvals',
    'security', 'qualityGate', 'documentation', 'tests', 'exclude', 'integrations',
  ]);

  const out: Partial<ReviewPolicy> = {};
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== POLICY_SCHEMA_VERSION) {
    warnings.push(`${source}: schemaVersion ${String(raw.schemaVersion)} differs from ${POLICY_SCHEMA_VERSION}; loaded best-effort`);
  }

  if (isObject(raw.rulePacks)) {
    warnUnknown(warnings, `${source}.rulePacks`, raw.rulePacks, ['require', 'disable']);
    out.rulePacks = {
      ...(asStringArray(raw.rulePacks.require) ? { require: asStringArray(raw.rulePacks.require) as string[] } : {}),
      ...(asStringArray(raw.rulePacks.disable) ? { disable: asStringArray(raw.rulePacks.disable) as string[] } : {}),
    } as ReviewPolicy['rulePacks'];
  }

  if (isObject(raw.rules)) {
    warnUnknown(warnings, `${source}.rules`, raw.rules, ['enable', 'severityOverride', 'suppress', 'minSeverity']);
    const rules: Partial<ReviewPolicy['rules']> = {};
    if (isObject(raw.rules.enable)) {
      const enable: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(raw.rules.enable)) {
        const b = asBoolean(value);
        if (b === undefined) warnings.push(`${source}.rules.enable.${key} is not a boolean`);
        else enable[key] = b;
      }
      rules.enable = enable;
    }
    if (isObject(raw.rules.severityOverride)) {
      const override: Record<string, Severity> = {};
      for (const [key, value] of Object.entries(raw.rules.severityOverride)) {
        const sev = asSeverity(value);
        if (!sev) warnings.push(`${source}.rules.severityOverride.${key} is not a severity`);
        else override[key] = sev;
      }
      rules.severityOverride = override;
    }
    if (Array.isArray(raw.rules.suppress)) {
      const suppressions: SuppressionRule[] = [];
      for (const [index, item] of raw.rules.suppress.entries()) {
        if (!isObject(item)) { warnings.push(`${source}.rules.suppress[${index}] is not an object`); continue; }
        const ruleId = asString(item.ruleId);
        const reason = asString(item.reason);
        const expiresAt = asString(item.expiresAt);
        const approvedBy = asString(item.approvedBy);
        if (!ruleId || !reason || !expiresAt || !approvedBy) {
          warnings.push(`${source}.rules.suppress[${index}] needs ruleId, reason, expiresAt and approvedBy`);
          continue;
        }
        if (Number.isNaN(Date.parse(expiresAt))) {
          warnings.push(`${source}.rules.suppress[${index}].expiresAt is not a date`);
          continue;
        }
        suppressions.push({
          ruleId,
          reason,
          expiresAt,
          approvedBy,
          ...(asStringArray(item.files) ? { files: asStringArray(item.files) as string[] } : {}),
        });
      }
      rules.suppress = suppressions;
    }
    const minSeverity = asSeverity(raw.rules.minSeverity);
    if (minSeverity) rules.minSeverity = minSeverity;
    out.rules = rules as ReviewPolicy['rules'];
  }

  if (isObject(raw.reviewers)) {
    warnUnknown(warnings, `${source}.reviewers`, raw.reviewers, ['enabled', 'disabled', 'maxReviewers', 'fullSweep', 'skills']);
    const reviewers: Partial<ReviewPolicy['reviewers']> = {};
    for (const key of ['enabled', 'disabled'] as const) {
      const list = asStringArray(raw.reviewers[key]);
      if (!list) continue;
      const invalid = list.filter((id) => !REVIEWER_SET.has(id));
      for (const id of invalid) warnings.push(`${source}.reviewers.${key} references unknown reviewer "${id}"`);
      reviewers[key] = list.filter((id) => REVIEWER_SET.has(id)) as ReviewerId[];
    }
    const max = asNumber(raw.reviewers.maxReviewers);
    if (max !== undefined) reviewers.maxReviewers = Math.max(1, Math.min(REVIEWER_IDS.length, Math.trunc(max)));
    const sweep = asBoolean(raw.reviewers.fullSweep);
    if (sweep !== undefined) reviewers.fullSweep = sweep;
    const skills = asStringArray(raw.reviewers.skills);
    if (skills) reviewers.skills = skills;
    out.reviewers = reviewers as ReviewPolicy['reviewers'];
  }

  if (isObject(raw.verification)) {
    warnUnknown(warnings, `${source}.verification`, raw.verification, [
      'minimumStatus', 'aiVerification', 'independentVerifiers', 'commands', 'requireApproval', 'sandbox', 'defaultTimeoutMs',
    ]);
    const v: Partial<ReviewPolicy['verification']> = {};
    const min = raw.verification.minimumStatus;
    if (min === 'CONFIRMED' || min === 'LIKELY' || min === 'UNVERIFIED') v.minimumStatus = min;
    const ai = asBoolean(raw.verification.aiVerification);
    if (ai !== undefined) v.aiVerification = ai;
    const indep = asNumber(raw.verification.independentVerifiers);
    if (indep !== undefined) v.independentVerifiers = Math.max(0, Math.min(3, Math.trunc(indep)));
    const approval = asBoolean(raw.verification.requireApproval);
    if (approval !== undefined) v.requireApproval = approval;
    const sandbox = asString(raw.verification.sandbox);
    if (sandbox === 'none' || sandbox === 'docker' || sandbox === 'nsjail' || sandbox === 'custom') v.sandbox = sandbox;
    const timeout = asNumber(raw.verification.defaultTimeoutMs);
    if (timeout !== undefined) v.defaultTimeoutMs = Math.max(1000, Math.trunc(timeout));
    if (Array.isArray(raw.verification.commands)) {
      const commands: VerificationCommandSpec[] = [];
      for (const [index, item] of raw.verification.commands.entries()) {
        if (!isObject(item)) { warnings.push(`${source}.verification.commands[${index}] is not an object`); continue; }
        const id = asString(item.id);
        const command = asString(item.command);
        const level = asString(item.level) as VerificationCommandSpec['level'] | undefined;
        if (!id || !command) { warnings.push(`${source}.verification.commands[${index}] needs id and command`); continue; }
        if (!level) { warnings.push(`${source}.verification.commands[${index}] needs a level`); continue; }
        commands.push({
          id,
          label: asString(item.label) ?? id,
          level,
          command,
          timeoutMs: asNumber(item.timeoutMs) ?? DEFAULT_POLICY.verification.defaultTimeoutMs,
          runAfterFix: asBoolean(item.runAfterFix) ?? false,
          requiresNetwork: asBoolean(item.requiresNetwork) ?? false,
          ...(asStringArray(item.requiresEnv) ? { requiresEnv: asStringArray(item.requiresEnv) as string[] } : {}),
        });
      }
      v.commands = commands;
    }
    out.verification = v as ReviewPolicy['verification'];
  }

  if (isObject(raw.risk)) {
    warnUnknown(warnings, `${source}.risk`, raw.risk, ['weights', 'thresholds']);
    const risk: Partial<ReviewPolicy['risk']> = {};
    if (isObject(raw.risk.weights)) {
      const weights: Record<string, number> = {};
      for (const [key, value] of Object.entries(raw.risk.weights)) {
        const n = asNumber(value);
        if (n === undefined) warnings.push(`${source}.risk.weights.${key} is not a number`);
        else weights[key] = n;
      }
      risk.weights = weights;
    }
    if (isObject(raw.risk.thresholds)) {
      const thresholds = { ...DEFAULT_POLICY.risk.thresholds };
      for (const key of ['moderate', 'high', 'severe'] as const) {
        const n = asNumber(raw.risk.thresholds[key]);
        if (n !== undefined) thresholds[key] = n;
      }
      if (!(thresholds.moderate < thresholds.high && thresholds.high < thresholds.severe)) {
        warnings.push(`${source}.risk.thresholds must increase: moderate < high < severe`);
      } else {
        risk.thresholds = thresholds;
      }
    }
    out.risk = risk as ReviewPolicy['risk'];
  }

  if (isObject(raw.approvals)) {
    warnUnknown(warnings, `${source}.approvals`, raw.approvals, ['requiredApprovals', 'requiredRoles', 'ownerPaths']);
    const approvals: Partial<ReviewPolicy['approvals']> = {};
    if (isObject(raw.approvals.requiredApprovals)) {
      const counts = { ...DEFAULT_POLICY.approvals.requiredApprovals };
      for (const key of ['low', 'moderate', 'high', 'severe'] as const) {
        const n = asNumber(raw.approvals.requiredApprovals[key]);
        if (n !== undefined) counts[key] = Math.max(0, Math.trunc(n));
      }
      approvals.requiredApprovals = counts;
    }
    if (isObject(raw.approvals.requiredRoles)) {
      const roles: ReviewPolicy['approvals']['requiredRoles'] = { ...DEFAULT_POLICY.approvals.requiredRoles };
      for (const key of ['low', 'moderate', 'high', 'severe'] as const) {
        const list = asStringArray(raw.approvals.requiredRoles[key]);
        if (list) roles[key] = list;
      }
      approvals.requiredRoles = roles;
    }
    if (Array.isArray(raw.approvals.ownerPaths)) {
      const owners: ReviewPolicy['approvals']['ownerPaths'] = [];
      for (const [index, item] of raw.approvals.ownerPaths.entries()) {
        if (!isObject(item)) { warnings.push(`${source}.approvals.ownerPaths[${index}] is not an object`); continue; }
        const glob = asString(item.glob);
        const role = asString(item.role);
        if (!glob || !role) { warnings.push(`${source}.approvals.ownerPaths[${index}] needs glob and role`); continue; }
        owners.push({ glob, role, reason: asString(item.reason) ?? `${glob} requires ${role} review` });
      }
      approvals.ownerPaths = owners;
    }
    out.approvals = approvals as ReviewPolicy['approvals'];
  }

  if (isObject(raw.security)) {
    warnUnknown(warnings, `${source}.security`, raw.security, ['forbiddenPatterns', 'blockingSeverity']);
    const security: Partial<ReviewPolicy['security']> = {};
    if (Array.isArray(raw.security.forbiddenPatterns)) {
      const patterns: ForbiddenPattern[] = [];
      for (const [index, item] of raw.security.forbiddenPatterns.entries()) {
        if (!isObject(item)) { warnings.push(`${source}.security.forbiddenPatterns[${index}] is not an object`); continue; }
        const id = asString(item.id);
        const pattern = asString(item.pattern);
        const message = asString(item.message);
        if (!id || !pattern || !message) { warnings.push(`${source}.security.forbiddenPatterns[${index}] needs id, pattern and message`); continue; }
        try {
          new RegExp(pattern);
        } catch {
          warnings.push(`${source}.security.forbiddenPatterns[${index}].pattern is not a valid regular expression`);
          continue;
        }
        patterns.push({
          id,
          pattern,
          message,
          severity: asSeverity(item.severity) ?? 'high',
          ...(asStringArray(item.files) ? { files: asStringArray(item.files) as string[] } : {}),
        });
      }
      security.forbiddenPatterns = patterns;
    }
    const blocking = asSeverity(raw.security.blockingSeverity);
    if (blocking) security.blockingSeverity = blocking;
    out.security = security as ReviewPolicy['security'];
  }

  if (isObject(raw.qualityGate)) {
    warnUnknown(warnings, `${source}.qualityGate`, raw.qualityGate, ['failOn']);
    const failOn = raw.qualityGate.failOn === 'none' ? 'none' : asSeverity(raw.qualityGate.failOn);
    if (failOn) out.qualityGate = { failOn };
  }

  if (isObject(raw.documentation)) {
    warnUnknown(warnings, `${source}.documentation`, raw.documentation, ['requireUpdatedDocs', 'requiredPaths']);
    const docs: Partial<ReviewPolicy['documentation']> = {};
    const require = asBoolean(raw.documentation.requireUpdatedDocs);
    if (require !== undefined) docs.requireUpdatedDocs = require;
    const paths = asStringArray(raw.documentation.requiredPaths);
    if (paths) docs.requiredPaths = paths;
    out.documentation = docs as ReviewPolicy['documentation'];
  }

  if (isObject(raw.tests)) {
    warnUnknown(warnings, `${source}.tests`, raw.tests, ['requireCoverageFor', 'requiredCommands']);
    const tests: Partial<ReviewPolicy['tests']> = {};
    const globs = asStringArray(raw.tests.requireCoverageFor);
    if (globs) tests.requireCoverageFor = globs;
    const required = asStringArray(raw.tests.requiredCommands);
    if (required) tests.requiredCommands = required;
    out.tests = tests as ReviewPolicy['tests'];
  }

  if (isObject(raw.exclude)) {
    warnUnknown(warnings, `${source}.exclude`, raw.exclude, ['globs']);
    const globs = asStringArray(raw.exclude.globs);
    if (globs) out.exclude = { globs };
  }

  if (isObject(raw.integrations)) {
    warnUnknown(warnings, `${source}.integrations`, raw.integrations, ['enabled']);
    const enabled = asStringArray(raw.integrations.enabled);
    if (enabled) out.integrations = { enabled };
  }

  return { value: out, warnings };
}

const LAYER_ORDER: Record<PolicyLayerState['kind'], number> = { organization: 0, repository: 1, directory: 2, file: 3 };

function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>, path: string, provenance: Record<string, string>, layer: string): void {
  for (const [key, value] of Object.entries(source)) {
    const full = path ? `${path}.${key}` : key;
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      const existing = target[key];
      if (Array.isArray(existing)) target[key] = [...existing, ...value];
      else target[key] = [...value];
      provenance[full] = layer;
      continue;
    }
    if (isObject(value)) {
      const existing = target[key];
      const base = isObject(existing) ? existing : {};
      const next: Record<string, unknown> = { ...base };
      mergeInto(next, value, full, provenance, layer);
      target[key] = next;
      continue;
    }
    target[key] = value;
    provenance[full] = layer;
  }
}

/**
 * Resolve layers for a set of changed paths.
 *
 * Directory and file layers apply only when their `appliesTo` glob matches at
 * least one changed file, so a monorepo policy for `services/billing/**` does
 * not silently govern an unrelated package.
 */
export function resolvePolicy(layers: PolicyLayerInput[], changedPaths: string[] = []): EffectivePolicy {
  const warnings: string[] = [];
  const states: PolicyLayerState[] = [];
  const ordered = [...layers].sort((a, b) => LAYER_ORDER[a.kind] - LAYER_ORDER[b.kind]);
  const merged: Record<string, unknown> = JSON.parse(JSON.stringify(DEFAULT_POLICY)) as Record<string, unknown>;
  const provenance: Record<string, string> = {};

  const seed = (value: unknown, path: string): void => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) { provenance[path] = 'default'; return; }
      for (const [key, child] of entries) seed(child, path ? `${path}.${key}` : key);
      return;
    }
    provenance[path] = 'default';
  };
  seed(DEFAULT_POLICY, '');

  for (const layer of ordered) {
    const applicable = layer.kind === 'organization'
      || layer.kind === 'repository'
      || layer.appliesTo === '*'
      || layer.appliesTo === '**'
      || changedPaths.length === 0
      || changedPaths.some((p) => matchesAnyGlob(p, [layer.appliesTo]));
    const label = layer.source;
    if (!applicable) {
      states.push({ kind: layer.kind, source: layer.source, appliesTo: layer.appliesTo, loaded: false, contributed: [], error: 'no changed file matches this layer' });
      continue;
    }
    const normalized = normalizePolicyLayer(layer.value, layer.source);
    warnings.push(...normalized.warnings);
    if (normalized.error) {
      states.push({ kind: layer.kind, source: layer.source, appliesTo: layer.appliesTo, loaded: false, contributed: [], error: normalized.error });
      continue;
    }
    const localProvenance: Record<string, string> = {};
    mergeInto(merged, normalized.value as Record<string, unknown>, '', localProvenance, label);
    for (const [key, value] of Object.entries(localProvenance)) provenance[key] = value;
    states.push({
      kind: layer.kind,
      source: layer.source,
      appliesTo: layer.appliesTo,
      loaded: true,
      contributed: Object.keys(normalized.value as Record<string, unknown>),
    });
  }

  const policy = merged as unknown as ReviewPolicy;
  policy.schemaVersion = POLICY_SCHEMA_VERSION;

  // Invariants a policy cannot break, regardless of layers.
  if (policy.verification.requireApproval === false) {
    warnings.push('verification.requireApproval was forced to true: a verification command is never executed without an explicit approval');
    policy.verification.requireApproval = true;
  }
  if (policy.approvals.requiredApprovals.severe < 1) {
    warnings.push('approvals.requiredApprovals.severe was raised to 1: a severe-risk change always requires a human approval');
    policy.approvals.requiredApprovals.severe = 1;
  }
  const effectiveSuppressions = activeSuppressions(policy, warnings);
  policy.rules.suppress = effectiveSuppressions;

  return { policy, provenance, layers: states, warnings };
}

/** Drop expired suppressions and report them. */
export function activeSuppressions(policy: ReviewPolicy, warnings: string[] = [], now: Date = new Date()): SuppressionRule[] {
  const active: SuppressionRule[] = [];
  for (const suppression of policy.rules.suppress) {
    const expires = Date.parse(suppression.expiresAt);
    if (Number.isNaN(expires)) {
      warnings.push(`suppression for ${suppression.ruleId} has an unparsable expiry and was ignored`);
      continue;
    }
    if (expires <= now.getTime()) {
      warnings.push(`suppression for ${suppression.ruleId} expired on ${suppression.expiresAt} and was ignored`);
      continue;
    }
    active.push(suppression);
  }
  return active;
}

export function snapshotPolicy(effective: EffectivePolicy): EffectivePolicySnapshot {
  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    policy: effective.policy,
    provenance: { ...effective.provenance },
    layers: effective.layers.map((l) => ({
      kind: l.kind,
      source: l.source,
      appliesTo: l.appliesTo,
      loaded: l.loaded,
      ...(l.error ? { error: l.error } : {}),
    })),
    warnings: [...effective.warnings],
  };
}

/** Is a rule suppressed for a file by an active, unexpired suppression? */
export function isSuppressed(policy: ReviewPolicy, ruleId: string, file: string, now: Date = new Date()): SuppressionRule | null {
  for (const suppression of policy.rules.suppress) {
    if (suppression.ruleId !== ruleId && suppression.ruleId !== '*') continue;
    if (Date.parse(suppression.expiresAt) <= now.getTime()) continue;
    if (suppression.files && suppression.files.length > 0 && !matchesAnyGlob(file, suppression.files)) continue;
    return suppression;
  }
  return null;
}
