/**
 * Declarative rule definitions.
 *
 * Rules are data, so a team can add, override, disable, version and test them
 * without touching DiffWise source. Validation is strict about the things that
 * make a rule unsafe or unrunnable (bad regex, unknown category, missing
 * evidence policy) and reports every problem with the file it came from.
 */
import type { Confidence, FindingCategory, Language, Severity } from '../types';

export type RuleMode = 'deterministic' | 'ai-assisted' | 'hybrid';

export type DetectionKind = 'pattern' | 'ast' | 'absence' | 'forbidden-import';

export interface PatternDetection {
  type: 'pattern';
  /** Regular expression source. Validated at load time. */
  pattern: string;
  flags?: string;
  /** `added` (default) scans added lines only; `file` scans the whole file. */
  scope?: 'added' | 'file';
  /** A second regex that must match within `window` lines of the first. */
  mustAlsoMatch?: string;
  /** A regex that, if it matches inside the window, suppresses the finding. */
  mustNotMatch?: string;
  /** Lines of context for mustAlsoMatch/mustNotMatch. Default 6. */
  window?: number;
}

export interface AstDetection {
  type: 'ast';
  /** The syntactic shape to find. */
  node: 'call' | 'new' | 'method' | 'property' | 'decorator' | 'import';
  /** Name pattern matched against the callee/method/property/decorator name. */
  name?: string;
  /** Receiver pattern for `call`/`method` (e.g. `this`, `repository`). */
  receiver?: string;
  /** Only inside a class member carrying this decorator (e.g. `Transactional`). */
  withinDecorator?: string;
  /** Only inside a class. */
  withinClass?: boolean;
  /** Only for imports: module specifier pattern. */
  from?: string;
}

export interface AbsenceDetection {
  type: 'absence';
  /** Regex that must appear somewhere in a matching file. */
  required: string;
  /** Message shown when it is missing. */
  message: string;
}

export interface ForbiddenImportDetection {
  type: 'forbidden-import';
  /** Module specifier regex, e.g. `^@app/legacy/`. */
  from: string;
}

export type RuleDetection = PatternDetection | AstDetection | AbsenceDetection | ForbiddenImportDetection;

export interface RuleExample {
  bad: string;
  good?: string;
  note?: string;
}

export interface RuleReference {
  title: string;
  url?: string;
}

export interface RuleProvenance {
  /** `builtin`, or the pack id. */
  pack: string;
  packVersion?: string;
  /** File the definition was loaded from. */
  path?: string;
}

export interface RuleDefinition {
  id: string;
  name: string;
  version: string;
  category: FindingCategory;
  severity: Severity;
  confidence: Confidence;
  enabled: boolean;
  mode: RuleMode;
  /** Languages the rule understands. `any` means the pattern applies to all text. */
  languages: Language[] | 'any';
  frameworks?: string[];
  /** File globs the rule applies to. Empty means every analysable file. */
  files?: string[];
  description: string;
  detection: RuleDetection;
  evidence: { required: boolean; note?: string };
  recommendation: string;
  /** True when the rule inherits `detection` from the rule named by `extends`. */
  inheritsDetection?: boolean;
  references?: RuleReference[];
  examples?: RuleExample[];
  tags?: string[];
  /** Rule ids or pack ids that must be loaded for this rule to run. */
  requires?: string[];
  /** Rule this one overrides (inheritance). */
  extends?: string;
  provenance: RuleProvenance;
}

export interface RuleValidationIssue {
  level: 'error' | 'warning';
  path: string;
  message: string;
}

export interface RuleValidationResult {
  rules: RuleDefinition[];
  issues: RuleValidationIssue[];
  /** Pack-level metadata discovered while validating. */
  pack?: { id: string; version: string; name?: string; description?: string; requires?: string[] };
}

const CATEGORIES: FindingCategory[] = [
  'correctness', 'security', 'performance', 'reliability', 'concurrency', 'database', 'api-contract',
  'maintainability', 'architecture', 'tests', 'documentation', 'error-handling', 'resources', 'configuration',
];
const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
const CONFIDENCES: Confidence[] = ['verified', 'high', 'medium', 'low'];
const LANGUAGES: Language[] = [
  'typescript', 'tsx', 'javascript', 'jsx', 'python', 'java', 'kotlin', 'go', 'rust', 'csharp', 'ruby', 'php',
  'sql', 'json', 'yaml', 'markdown', 'other',
];
const MODES: RuleMode[] = ['deterministic', 'ai-assisted', 'hybrid'];

const KNOWN_KEYS = new Set([
  'id', 'name', 'version', 'category', 'severity', 'confidence', 'enabled', 'mode', 'languages', 'frameworks',
  'files', 'description', 'detection', 'evidence', 'recommendation', 'references', 'examples', 'tags', 'requires',
  'extends', 'pack', 'author', 'license',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function strList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

function safeRegex(source: string, flags: string | undefined, path: string, field: string, issues: RuleValidationIssue[]): RegExp | null {
  try {
    // `g` and `y` make `test` stateful; never allow them in a rule.
    const cleaned = (flags ?? '').replace(/[gy]/g, '');
    return new RegExp(source, cleaned);
  } catch (err) {
    issues.push({ level: 'error', path, message: `${field} is not a valid regular expression: ${(err as Error).message}` });
    return null;
  }
}

function screenRegex(source: string, path: string, field: string, issues: RuleValidationIssue[]): boolean {
  const risk = regexRisk(source);
  if (risk.level === 'rejected') {
    issues.push({ level: 'error', path, message: `${field} was rejected: ${risk.reason}` });
    return false;
  }
  if (risk.level === 'suspicious') {
    issues.push({ level: 'warning', path, message: `${field} may be slow: ${risk.reason}` });
  }
  return true;
}

function validateDetection(raw: unknown, path: string, issues: RuleValidationIssue[]): RuleDetection | null {
  if (!isObject(raw)) {
    issues.push({ level: 'error', path, message: 'detection must be an object' });
    return null;
  }
  const type = str(raw.type);
  if (type === 'pattern') {
    const pattern = str(raw.pattern);
    if (!pattern) {
      issues.push({ level: 'error', path, message: 'detection.pattern is required' });
      return null;
    }
    if (!safeRegex(pattern, str(raw.flags), path, 'detection.pattern', issues)) return null;
    if (!screenRegex(pattern, path, 'detection.pattern', issues)) return null;
    if (str(raw.mustAlsoMatch) && !safeRegex(str(raw.mustAlsoMatch) as string, undefined, path, 'detection.mustAlsoMatch', issues)) return null;
    if (str(raw.mustNotMatch) && !safeRegex(str(raw.mustNotMatch) as string, undefined, path, 'detection.mustNotMatch', issues)) return null;
    const scope = str(raw.scope);
    if (scope && scope !== 'added' && scope !== 'file') {
      issues.push({ level: 'error', path, message: 'detection.scope must be "added" or "file"' });
      return null;
    }
    return {
      type: 'pattern',
      pattern,
      ...(str(raw.flags) ? { flags: str(raw.flags) } : {}),
      ...(scope ? { scope: scope as 'added' | 'file' } : {}),
      ...(str(raw.mustAlsoMatch) ? { mustAlsoMatch: str(raw.mustAlsoMatch) } : {}),
      ...(str(raw.mustNotMatch) ? { mustNotMatch: str(raw.mustNotMatch) } : {}),
      ...(typeof raw.window === 'number' ? { window: Math.max(0, Math.trunc(raw.window)) } : {}),
    };
  }
  if (type === 'ast') {
    const node = str(raw.node);
    if (!node || !['call', 'new', 'method', 'property', 'decorator', 'import'].includes(node)) {
      issues.push({ level: 'error', path, message: 'detection.node must be call|new|method|property|decorator|import' });
      return null;
    }
    return {
      type: 'ast',
      node: node as AstDetection['node'],
      ...(str(raw.name) ? { name: str(raw.name) } : {}),
      ...(str(raw.receiver) ? { receiver: str(raw.receiver) } : {}),
      ...(str(raw.withinDecorator) ? { withinDecorator: str(raw.withinDecorator) } : {}),
      ...(typeof raw.withinClass === 'boolean' ? { withinClass: raw.withinClass } : {}),
      ...(str(raw.from) ? { from: str(raw.from) } : {}),
    };
  }
  if (type === 'absence') {
    const required = str(raw.required);
    const message = str(raw.message);
    if (!required || !message) {
      issues.push({ level: 'error', path, message: 'absence detection needs required and message' });
      return null;
    }
    if (!safeRegex(required, undefined, path, 'detection.required', issues)) return null;
    return { type: 'absence', required, message };
  }
  if (type === 'forbidden-import') {
    const from = str(raw.from);
    if (!from) {
      issues.push({ level: 'error', path, message: 'forbidden-import needs a from pattern' });
      return null;
    }
    if (!safeRegex(from, undefined, path, 'detection.from', issues)) return null;
    return { type: 'forbidden-import', from };
  }
  issues.push({ level: 'error', path, message: `unknown detection type "${String(type)}"` });
  return null;
}

/**
 * Validate one rule object.
 *
 * Unknown top-level keys are warnings (a forward-compatible rule from a newer
 * DiffWise still loads). Everything that could make a rule silently wrong is an
 * error and the rule is dropped.
 */
export function validateRuleDefinition(
  raw: unknown,
  path: string,
  provenance: RuleProvenance,
  issues: RuleValidationIssue[] = [],
): RuleDefinition | null {
  if (!isObject(raw)) {
    issues.push({ level: 'error', path, message: 'rule is not an object' });
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) issues.push({ level: 'warning', path, message: `unknown field "${key}"` });
  }

  const id = str(raw.id);
  if (!id) { issues.push({ level: 'error', path, message: 'id is required' }); return null; }
  if (!ID_PATTERN.test(id)) {
    issues.push({ level: 'error', path, message: `id "${id}" must be lower-case dot/dash separated (e.g. java.transaction.self-invocation)` });
    return null;
  }
  const name = str(raw.name);
  if (!name) { issues.push({ level: 'error', path, message: 'name is required' }); return null; }
  const version = str(raw.version);
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    issues.push({ level: 'error', path, message: 'version is required and must be semver (x.y.z)' });
    return null;
  }
  const category = str(raw.category) as FindingCategory | undefined;
  if (!category || !CATEGORIES.includes(category)) {
    issues.push({ level: 'error', path, message: `category must be one of: ${CATEGORIES.join(', ')}` });
    return null;
  }
  const severity = (str(raw.severity) ?? 'medium') as Severity;
  if (!SEVERITIES.includes(severity)) {
    issues.push({ level: 'error', path, message: `severity must be one of: ${SEVERITIES.join(', ')}` });
    return null;
  }
  const confidence = (str(raw.confidence) ?? 'medium') as Confidence;
  if (!CONFIDENCES.includes(confidence)) {
    issues.push({ level: 'error', path, message: `confidence must be one of: ${CONFIDENCES.join(', ')}` });
    return null;
  }
  const mode = (str(raw.mode) ?? 'deterministic') as RuleMode;
  if (!MODES.includes(mode)) {
    issues.push({ level: 'error', path, message: `mode must be one of: ${MODES.join(', ')}` });
    return null;
  }

  const languagesRaw = raw.languages;
  let languages: Language[] | 'any' = 'any';
  if (languagesRaw === 'any' || languagesRaw === undefined) {
    languages = 'any';
  } else if (Array.isArray(languagesRaw)) {
    const list = strList(languagesRaw) ?? [];
    const invalid = list.filter((l) => !LANGUAGES.includes(l as Language));
    if (invalid.length) {
      issues.push({ level: 'warning', path, message: `unknown language(s) ignored: ${invalid.join(', ')}` });
    }
    languages = list.filter((l) => LANGUAGES.includes(l as Language)) as Language[];
    if (languages.length === 0) {
      issues.push({ level: 'error', path, message: 'languages must list at least one supported language, or "any"' });
      return null;
    }
  } else {
    issues.push({ level: 'error', path, message: 'languages must be "any" or a list' });
    return null;
  }

  const description = str(raw.description);
  if (!description) { issues.push({ level: 'error', path, message: 'description is required' }); return null; }
  const recommendation = str(raw.recommendation);
  if (!recommendation) { issues.push({ level: 'error', path, message: 'recommendation is required' }); return null; }

  const extendsId = str(raw.extends);
  const detection = raw.detection === undefined && extendsId
    ? ({ type: 'pattern', pattern: '^$' } as RuleDetection)
    : validateDetection(raw.detection, path, issues);
  if (!detection) return null;
  if (raw.detection === undefined && extendsId) {
    issues.push({ level: 'warning', path, message: `detection is inherited from "${extendsId}"` });
  }

  const evidenceRaw = isObject(raw.evidence) ? raw.evidence : {};
  const evidence = {
    required: typeof evidenceRaw.required === 'boolean' ? evidenceRaw.required : true,
    ...(str(evidenceRaw.note) ? { note: str(evidenceRaw.note) as string } : {}),
  };
  if (mode !== 'deterministic' && evidence.required === false) {
    issues.push({ level: 'warning', path, message: 'AI-assisted rules must require evidence; setting evidence.required = true' });
    evidence.required = true;
  }

  if (typeof raw.enabled !== 'boolean') {
    issues.push({ level: 'warning', path, message: 'enabled defaults to true' });
  }

  const references = Array.isArray(raw.references)
    ? raw.references.filter(isObject).flatMap((r) => {
      const title = str(r.title);
      return title ? [{ title, ...(str(r.url) ? { url: str(r.url) as string } : {}) }] : [];
    })
    : undefined;
  const examples = Array.isArray(raw.examples)
    ? raw.examples.filter(isObject).flatMap((e) => {
      const bad = str(e.bad);
      return bad ? [{ bad, ...(str(e.good) ? { good: str(e.good) as string } : {}), ...(str(e.note) ? { note: str(e.note) as string } : {}) }] : [];
    })
    : undefined;

  return {
    id,
    name,
    version,
    category,
    severity,
    confidence,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    mode,
    languages,
    ...(strList(raw.frameworks) ? { frameworks: strList(raw.frameworks) as string[] } : {}),
    ...(strList(raw.files) ? { files: strList(raw.files) as string[] } : {}),
    description,
    detection,
    evidence,
    recommendation,
    ...(references?.length ? { references } : {}),
    ...(examples?.length ? { examples } : {}),
    ...(strList(raw.tags) ? { tags: strList(raw.tags) as string[] } : {}),
    ...(strList(raw.requires) ? { requires: strList(raw.requires) as string[] } : {}),
    ...(extendsId ? { extends: extendsId } : {}),
    ...(raw.detection === undefined && extendsId ? { inheritsDetection: true } : {}),
    provenance,
  };
}

/**
 * Heuristic ReDoS screening for a rule-supplied regular expression.
 *
 * A rule pack is untrusted input that DiffWise compiles into a regex. JavaScript
 * cannot interrupt a runaway regex, so the only safe control is to refuse the
 * shapes that backtrack catastrophically. This is a heuristic, and it is
 * documented as one: a pack author can still write an expensive pattern.
 */
export function regexRisk(pattern: string): { level: 'safe' | 'suspicious' | 'rejected'; reason?: string } {
  if (pattern.length > 600) return { level: 'rejected', reason: 'pattern is longer than 600 characters' };
  if (/\([^()]*[+*]\)[+*]/.test(pattern)) return { level: 'rejected', reason: 'nested quantifier over a group (e.g. (a+)+) can backtrack catastrophically' };
  if (/(\.\*){2,}/.test(pattern)) return { level: 'suspicious', reason: 'repeated .* may be expensive on long lines' };
  if (/\([^()]{40,}\)/.test(pattern)) return { level: 'suspicious', reason: 'very long alternation group may be expensive' };
  return { level: 'safe' };
}
/** Validate a dependency-free subset of semver requirements: `^x.y.z`, `>=x.y.z`, `x.y.z`. */
export function satisfiesVersion(version: string, requirement: string | undefined): boolean {
  if (!requirement) return true;
  const parse = (v: string): [number, number, number] => {
    const parts = v.replace(/^[^\d]*/, '').split('.');
    const num = (index: number): number => Number.parseInt(parts[index] ?? '0', 10) || 0;
    return [num(0), num(1), num(2)];
  };
  const [major, minor, patch] = parse(version);
  const [rMajor, rMinor, rPatch] = parse(requirement);
  if (requirement.startsWith('^')) {
    if (major !== rMajor) return false;
    if (minor !== rMinor) return minor > rMinor;
    return patch >= rPatch;
  }
  if (requirement.startsWith('>=')) {
    if (major !== rMajor) return major > rMajor;
    if (minor !== rMinor) return minor > rMinor;
    return patch >= rPatch;
  }
  return major === rMajor && minor === rMinor && patch === rPatch;
}
