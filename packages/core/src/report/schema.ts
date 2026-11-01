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
import { VERIFICATION_STATUSES } from '../verification/types';

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
    // Verification is optional only for reports migrated from v2.
    if (finding.verification !== undefined) {
      const v = finding.verification;
      if (!isObject(v)) {
        issues.push({ path: `${at}.verification`, message: 'verification must be an object.' });
      } else {
        push(issues, VERIFICATION_STATUSES.includes(v.status as never), `${at}.verification.status`,
          `verification.status must be one of ${VERIFICATION_STATUSES.join(', ')}.`);
        push(issues, typeof v.method === 'string' && v.method.length > 0, `${at}.verification.method`, 'verification.method is required: a verdict must say how it was reached.');
        push(issues, Array.isArray(v.checks), `${at}.verification.checks`, 'verification.checks must be an array.');
        if (isObject(v.evidenceClasses)) {
          for (const cls of ['static', 'model', 'test', 'runtime', 'human']) {
            push(issues, typeof v.evidenceClasses[cls] === 'number', `${at}.verification.evidenceClasses.${cls}`, 'Expected a number.');
          }
        } else {
          issues.push({ path: `${at}.verification.evidenceClasses`, message: 'Evidence classes are required so a reader can see what supported the verdict.' });
        }
        if (v.status === 'CONFIRMED') {
          push(issues, isObject(v.evidenceClasses) && Number(v.evidenceClasses.human ?? 0) + Number(v.evidenceClasses.test ?? 0) + Number(v.evidenceClasses.static ?? 0) > 0,
            `${at}.verification.evidenceClasses`,
            'A CONFIRMED finding must be supported by static, test, runtime or human evidence — never by model interpretation alone.');
        }
      }
    }
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

  const decisions = Array.isArray(value.decisions) ? value.decisions : [];
  decisions.forEach((decision, i) => {
    if (!isObject(decision)) {
      issues.push({ path: `$.decisions[${i}]`, message: 'Decision must be an object.' });
      return;
    }
    const at = `$.decisions[${i}]`;
    push(issues, typeof decision.actor === 'string' && decision.actor.length > 0, `${at}.actor`, 'A decision must record who made it.');
    push(issues, ['human', 'ai', 'ci'].includes(String(decision.actorKind)), `${at}.actorKind`, 'actorKind must be human | ai | ci.');
    push(issues, typeof decision.at === 'string' && !Number.isNaN(Date.parse(decision.at)), `${at}.at`, 'A decision must record when it was made.');
    if (decision.findingId !== undefined) {
      push(issues, findingIds.has(String(decision.findingId)), `${at}.findingId`, `Decision references unknown finding ${String(decision.findingId)}.`);
    }
    for (const action of ['reject', 'false-positive', 'block', 'request-changes']) {
      if (decision.action === action) {
        push(issues, typeof decision.rationale === 'string' && decision.rationale.trim().length >= 8, `${at}.rationale`,
          `A "${action}" decision requires a rationale.`);
      }
    }
  });

  if (value.state !== undefined) {
    push(issues, ['PENDING', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'BLOCKED', 'SUPERSEDED'].includes(String(value.state)),
      '$.state', 'Invalid review state.');
  }

  if (value.requirements !== undefined) {
    push(issues, Array.isArray(value.requirements), '$.requirements', 'requirements must be an array.');
    (Array.isArray(value.requirements) ? value.requirements : []).forEach((req, i) => {
      if (!isObject(req)) return;
      push(issues, req.trusted === false, `$.requirements[${i}].trusted`, 'Imported requirement content must be marked untrusted.');
      push(issues, typeof req.source === 'string' && typeof req.title === 'string', `$.requirements[${i}]`, 'A requirement needs a source and a title.');
    });
  }

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

  if (version < 3) {
    report.schemaVersion = 3;
    if (!Array.isArray(report.decisions)) report.decisions = [];
    if (!Array.isArray(report.requirements)) report.requirements = [];
    if (!Array.isArray(report.contextSources)) report.contextSources = [];
    if (report.state === undefined) report.state = 'PENDING';
    // A v2 report ran no specialised reviewers and no independent verification.
    // Say so explicitly instead of leaving the fields absent and implying they ran.
    if (!isObject(report.review)) {
      report.review = {
        plan: { reviewers: [], decisions: [], considered: [], maxReviewers: 0, route: { provider: 'none', model: 'none' }, truncated: false },
        reviewerRuns: [],
        totals: { durationMs: 0, tokens: { prompt: 0, completion: 0 }, proposed: 0, accepted: 0, evidenceRejected: 0 },
        cancelled: false,
        skippedReason: 'This review was produced by schema v2, before the reviewer pipeline existed.',
        verification: {
          performed: false, policy: 'none', confirmed: 0, likely: 0, unverified: 0,
          rejected: 0, disputed: 0, corroborated: 0, reproducible: 0,
        },
      };
    }
    // Findings keep `verification: undefined`: claiming a verdict for a review
    // that never verified anything would be a fabrication.
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
