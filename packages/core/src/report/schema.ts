/**
 * Canonical report contract: validation, migration and versioning.
 *
 * The report is the single artefact every interface renders — CLI, web report,
 * MCP, CI and the VS Code extension. Because it is persisted on disk and can be
 * read by a newer build than the one that wrote it, it needs an explicit
 * version, a validator and forward migrations. Nothing here depends on a model
 * provider or on a UI.
 */
import {
  REPORT_SCHEMA_VERSION,
  SEVERITY_ORDER,
  type Finding,
  type ReviewReport,
  type Severity,
} from '../types';

export interface ReportValidationIssue {
  path: string;
  message: string;
}

export interface ReportValidationResult {
  ok: boolean;
  issues: ReportValidationIssue[];
  /** Schema version found in the payload, when it could be determined. */
  version?: number;
}

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
const COMPLETENESS = ['complete', 'partial', 'failed'];
const STATUS_KEYS = ['changedFiles', 'changedSymbols', 'affectedComponents'] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function push(issues: ReportValidationIssue[], condition: boolean, path: string, message: string): void {
  if (!condition) issues.push({ path, message });
}

/**
 * Structural + referential validation.
 *
 * This is deliberately hand-written: the report shape is small, and shipping a
 * JSON-Schema engine in the core engine would be a dependency the product does
 * not need. The tests assert that every finding is traceable to a changed or
 * cited file, which is the property that matters for evidence integrity.
 */
export function validateReport(value: unknown): ReportValidationResult {
  const issues: ReportValidationIssue[] = [];
  if (!isObject(value)) {
    return { ok: false, issues: [{ path: '$', message: 'Report must be a JSON object.' }] };
  }
  const version = typeof value.schemaVersion === 'number' ? value.schemaVersion : undefined;
  push(issues, version === REPORT_SCHEMA_VERSION, '$.schemaVersion',
    `Expected schemaVersion ${REPORT_SCHEMA_VERSION} (got ${String(value.schemaVersion)}). Run migrateReport first.`);

  for (const key of ['id', 'createdAt', 'target', 'repository', 'summary', 'risk', 'stages', 'changes', 'findings', 'tests', 'execution']) {
    push(issues, value[key] !== undefined, `$.${key}`, `Missing required field "${key}".`);
  }
  push(issues, typeof value.id === 'string' && value.id.length > 0, '$.id', 'id must be a non-empty string.');
  push(issues, typeof value.createdAt === 'string' && !Number.isNaN(Date.parse(value.createdAt)), '$.createdAt', 'createdAt must be an ISO timestamp.');

  const summary = value.summary;
  if (isObject(summary)) {
    for (const key of STATUS_KEYS) {
      push(issues, typeof summary[key] === 'number', `$.summary.${key}`, 'Expected a number.');
    }
    push(issues, COMPLETENESS.includes(String(summary.completeness)), '$.summary.completeness',
      'completeness must be complete | partial | failed.');
    const bySeverity = summary.findingsBySeverity;
    if (isObject(bySeverity)) {
      for (const s of SEVERITIES) {
        push(issues, typeof bySeverity[s] === 'number', `$.summary.findingsBySeverity.${s}`, 'Expected a number.');
      }
    } else {
      issues.push({ path: '$.summary.findingsBySeverity', message: 'Missing severity counts.' });
    }
  }

  const risk = value.risk;
  if (isObject(risk)) {
    push(issues, typeof risk.score === 'number' && risk.score >= 0 && risk.score <= 100, '$.risk.score', 'risk.score must be 0-100.');
    push(issues, ['low', 'moderate', 'high', 'severe'].includes(String(risk.level)), '$.risk.level', 'Invalid risk level.');
    push(issues, Array.isArray(risk.factors), '$.risk.factors', 'risk.factors must be an array (the score must stay explainable).');
  }

  const changes = Array.isArray(value.changes) ? value.changes : [];
  const changePaths = new Set<string>();
  changes.forEach((change, i) => {
    if (!isObject(change)) {
      issues.push({ path: `$.changes[${i}]`, message: 'Change must be an object.' });
      return;
    }
    push(issues, typeof change.path === 'string' && !change.path.startsWith('/'), `$.changes[${i}].path`,
      'Change path must be repository-relative.');
    if (typeof change.path === 'string') changePaths.add(change.path);
    push(issues, typeof change.additions === 'number' && typeof change.deletions === 'number',
      `$.changes[${i}]`, 'additions/deletions must be numbers.');
  });

  const findings = Array.isArray(value.findings) ? value.findings : [];
  const findingIds = new Set<string>();
  findings.forEach((finding, i) => {
    if (!isObject(finding)) {
      issues.push({ path: `$.findings[${i}]`, message: 'Finding must be an object.' });
      return;
    }
    const at = `$.findings[${i}]`;
    push(issues, typeof finding.id === 'string' && finding.id.length > 0, `${at}.id`, 'Finding needs a stable id.');
    if (typeof finding.id === 'string') {
      push(issues, !findingIds.has(finding.id), `${at}.id`, `Duplicate finding id ${finding.id}.`);
      findingIds.add(finding.id);
    }
    push(issues, SEVERITIES.includes(finding.severity as Severity), `${at}.severity`, 'Invalid severity.');
    push(issues, typeof finding.file === 'string' && !finding.file.startsWith('/'), `${at}.file`, 'file must be repository-relative.');
    const range = finding.range;
    push(issues, isObject(range) && typeof range.start === 'number' && typeof range.end === 'number' && range.start >= 1 && range.end >= range.start,
      `${at}.range`, 'range must be 1-based with end >= start.');
    const evidence = Array.isArray(finding.evidence) ? finding.evidence : [];
    push(issues, evidence.length > 0, `${at}.evidence`, 'Every finding must carry evidence.');
    evidence.forEach((e, j) => {
      if (!isObject(e)) {
        issues.push({ path: `${at}.evidence[${j}]`, message: 'Evidence must be an object.' });
        return;
      }
      push(issues, typeof e.note === 'string' && e.note.length > 0, `${at}.evidence[${j}].note`, 'Evidence needs a note.');
      if (e.file !== undefined) {
        push(issues, typeof e.file === 'string' && !String(e.file).startsWith('/'),
          `${at}.evidence[${j}].file`, 'Evidence path must be repository-relative.');
      }
      if (e.line !== undefined) {
        push(issues, typeof e.line === 'number' && e.line >= 1, `${at}.evidence[${j}].line`, 'Evidence line must be >= 1.');
      }
    });
  });

  const fixes = Array.isArray(value.fixes) ? value.fixes : [];
  fixes.forEach((fix, i) => {
    if (!isObject(fix)) return;
    push(issues, typeof fix.findingId === 'string' && findingIds.has(fix.findingId), `$.fixes[${i}].findingId`,
      `Fix points at unknown finding ${String(fix.findingId)}.`);
  });

  const applied = Array.isArray(value.appliedFixes) ? value.appliedFixes : [];
  applied.forEach((fix, i) => {
    if (!isObject(fix)) return;
    push(issues, typeof fix.findingId === 'string' && findingIds.has(fix.findingId), `$.appliedFixes[${i}].findingId`,
      'Applied fix must reference an existing finding.');
  });

  const execution = value.execution;
  if (isObject(execution)) {
    for (const key of ['tool', 'toolVersion', 'nodeVersion', 'platform']) {
      push(issues, typeof execution[key] === 'string' && String(execution[key]).length > 0, `$.execution.${key}`, 'Expected a non-empty string.');
    }
  }

  return { ok: issues.length === 0, issues, ...(version !== undefined ? { version } : {}) };
}

export class ReportValidationError extends Error {
  constructor(readonly issues: ReportValidationIssue[]) {
    super(`Report failed validation: ${issues.slice(0, 5).map((i) => `${i.path} ${i.message}`).join('; ')}${issues.length > 5 ? ` (+${issues.length - 5} more)` : ''}`);
    this.name = 'ReportValidationError';
  }
}

export function assertReport(value: unknown): asserts value is ReviewReport {
  const result = validateReport(value);
  if (!result.ok) throw new ReportValidationError(result.issues);
}

/**
 * Bring any report written by a previous schema version up to the current one.
 *
 * Migrations only add information that can be derived honestly. Where a value
 * cannot be known (for example the tool version of a legacy review), it is
 * recorded as `unknown` rather than guessed.
 */
export function migrateReport(value: unknown): ReviewReport {
  if (!isObject(value)) throw new ReportValidationError([{ path: '$', message: 'Report must be a JSON object.' }]);
  const version = typeof value.schemaVersion === 'number' ? value.schemaVersion : 1;
  if (version > REPORT_SCHEMA_VERSION) {
    throw new ReportValidationError([{
      path: '$.schemaVersion',
      message: `Report was written by a newer schema (v${version}). Upgrade DiffWise to read it.`,
    }]);
  }
  const report = { ...value } as Record<string, unknown>;

  if (version < 2) {
    report.schemaVersion = 2;
    if (!isObject(report.execution)) {
      report.execution = {
        tool: 'diffwise-legacy',
        toolVersion: 'unknown',
        command: 'unknown',
        cwd: String((report.repository as Record<string, unknown> | undefined)?.root ?? ''),
        nodeVersion: 'unknown',
        platform: 'unknown',
        indexedFiles: 0,
      };
    }
    if (!Array.isArray(report.verification)) report.verification = [];
    if (!Array.isArray(report.appliedFixes)) report.appliedFixes = [];
    if (!Array.isArray(report.fixes)) report.fixes = [];
    if (!Array.isArray(report.knowledge)) report.knowledge = [];
  }

  const result = validateReport(report);
  if (!result.ok) throw new ReportValidationError(result.issues);
  return report as unknown as ReviewReport;
}

/** Parse a persisted report, migrating it when necessary. */
export function parseReport(text: string): ReviewReport {
  return migrateReport(JSON.parse(text) as unknown);
}

export function severityRank(severity: Severity): number {
  return SEVERITY_ORDER[severity];
}

/** Findings at or above a threshold, used by CLI filters and CI quality gates. */
export function findingsAtOrAbove(findings: Finding[], threshold: Severity): Finding[] {
  const max = SEVERITY_ORDER[threshold];
  return findings.filter((f) => SEVERITY_ORDER[f.severity] <= max);
}
