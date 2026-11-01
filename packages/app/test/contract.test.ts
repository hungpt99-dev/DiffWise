import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  REPORT_SCHEMA_VERSION, buildReviewEnvelope, validateReport, migrateReport, ReportValidationError,
  parseReport,
} from '@diffwise/core';
import type { ReviewReport } from '@diffwise/core';
import { cleanup, demoReport, makeDemoRepo } from './helpers';

/**
 * Contract tests. A report is persisted on disk and read by newer builds, so
 * validation and migration are product behaviour, not test scaffolding.
 */
let report: ReviewReport;
let root: string;

beforeAll(async () => {
  root = await makeDemoRepo();
  report = await demoReport(root);
}, 120_000);

afterAll(async () => {
  if (root) await cleanup(root);
});

describe('canonical report contract', () => {
  it('emits the current schema version and production metadata', () => {
    expect(report.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(report.execution.tool).toBeTruthy();
    expect(report.execution.nodeVersion).toBe(process.version);
    expect(report.execution.indexedFiles).toBeGreaterThan(0);
    expect(Array.isArray(report.verification)).toBe(true);
  });

  it('validates a real pipeline report', () => {
    const result = validateReport(report);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.version).toBe(REPORT_SCHEMA_VERSION);
  });

  it('rejects a report whose finding has no evidence', () => {
    const broken = structuredClone(report);
    broken.findings[0]!.evidence = [];
    const result = validateReport(broken);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.path.includes('evidence'))).toBe(true);
  });

  it('rejects absolute paths and unparseable timestamps', () => {
    const broken = structuredClone(report);
    broken.changes[0]!.path = '/etc/passwd';
    broken.createdAt = 'not-a-date';
    const issues = validateReport(broken).issues.map((i) => i.path);
    expect(issues).toContain('$.changes[0].path');
    expect(issues).toContain('$.createdAt');
  });

  it('rejects a fix that points at a finding which does not exist', () => {
    const broken = structuredClone(report);
    if (broken.fixes.length === 0) broken.fixes.push({ ...report.fixes[0]! });
    broken.fixes[0]!.findingId = 'DW-doesnotexist';
    const result = validateReport(broken);
    expect(result.issues.some((i) => i.message.includes('unknown finding'))).toBe(true);
  });

  it('migrates a version-1 report and keeps every finding', () => {
    const legacy = structuredClone(report) as unknown as Record<string, unknown>;
    legacy.schemaVersion = 1;
    delete legacy.execution;
    delete legacy.verification;
    const migrated = migrateReport(legacy);
    expect(migrated.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(migrated.execution.tool).toBe('diffwise-legacy');
    expect(migrated.execution.toolVersion).toBe('unknown');
    expect(migrated.verification).toEqual([]);
    expect(migrated.findings.length).toBe(report.findings.length);
  });

  it('refuses a report written by a newer schema', () => {
    const future = { ...structuredClone(report) as unknown as Record<string, unknown>, schemaVersion: 99 };
    expect(() => migrateReport(future)).toThrow(ReportValidationError);
    expect(() => migrateReport(future)).toThrow(/newer schema/);
  });

  it('round-trips through JSON without losing stable ids', () => {
    const parsed = parseReport(JSON.stringify(report));
    expect(parsed.findings.map((f) => f.id)).toEqual(report.findings.map((f) => f.id));
    expect(parsed.id).toBe(report.id);
  });
});

describe('machine-readable envelope', () => {
  it('reports counts that match the underlying report', () => {
    const env = buildReviewEnvelope(report);
    expect(env.schemaVersion).toBe('1.0');
    expect(env.reviewId).toBe(report.id);
    expect(env.summary.filesChanged).toBe(report.changes.length);
    expect(env.summary.findings).toBe(report.findings.length);
    const sum = env.summary.critical + env.summary.high + env.summary.medium + env.summary.low + env.summary.info;
    expect(sum).toBe(report.findings.length);
    expect(env.summary.linesAdded).toBe(report.changes.reduce((n, c) => n + c.additions, 0));
  });

  it('keeps the risk score explainable in the envelope', () => {
    const env = buildReviewEnvelope(report);
    expect(env.risk.factors.length).toBe(report.risk.factors.length);
    expect(env.risk.method).toMatch(/factor/i);
    expect(env.risk.score).toBe(report.risk.score);
  });

  it('is JSON-serialisable and free of absolute repository paths in findings', () => {
    const json = JSON.stringify(buildReviewEnvelope(report));
    expect(json.length).toBeGreaterThan(1000);
    for (const finding of buildReviewEnvelope(report).findings) {
      expect(finding.file.startsWith('/')).toBe(false);
    }
  });
});
