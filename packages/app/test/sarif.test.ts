import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSarif, buildReviewEnvelope, validateSarif } from '@diffwise/core';
import type { ReviewReport } from '@diffwise/core';
import { cleanup, demoReport, makeDemoRepo } from './helpers';

/**
 * SARIF is validated structurally here and consumed by GitHub code scanning in
 * CI (see .github/workflows/diffwise-review.yml).
 */
let report: ReviewReport;
let root: string;

beforeAll(async () => {
  root = await makeDemoRepo();
  report = await demoReport(root);
}, 180_000);

afterAll(async () => {
  if (root) await cleanup(root);
});

describe('SARIF export', () => {
  it('builds a valid SARIF 2.1.0 log for a real report', () => {
    const log = buildSarif(report);
    const validation = validateSarif(log);
    expect(validation.issues).toEqual([]);
    expect(log.version).toBe('2.1.0');
    const run = log.runs[0]!;
    expect(run.tool.driver.name).toBe('DiffWise');
    expect(run.results.length).toBe(report.findings.length);
    expect(run.tool.driver.rules.length).toBeGreaterThan(0);
    expect(run.properties.reviewId).toBe(report.id);
  });

  it('maps severity to SARIF levels and keeps the region grounded', () => {
    const run = buildSarif(report).runs[0]!;
    const critical = report.findings.find((f) => f.severity === 'critical');
    expect(critical).toBeTruthy();
    const result = run.results.find((r) => r.partialFingerprints['diffwiseFindingId/v1'] === critical!.id)!;
    expect(result.level).toBe('error');
    const location = result.locations[0]!.physicalLocation;
    expect(location.artifactLocation.uri).toBe(critical!.file);
    expect(location.region.startLine).toBe(critical!.range.start);

    const low = report.findings.find((f) => f.severity === 'low');
    if (low) {
      const lowResult = run.results.find((r) => r.partialFingerprints['diffwiseFindingId/v1'] === low.id)!;
      expect(lowResult.level).toBe('note');
    }
  });

  it('honours a minimum severity filter', () => {
    const results = buildSarif(report, { minSeverity: 'high' }).runs[0]!.results;
    expect(results.length).toBe(report.findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length);
  });

  it('reports incompleteness in the invocation instead of hiding it', () => {
    const partial: ReviewReport = {
      ...report,
      summary: { ...report.summary, completeness: 'partial', completenessNote: 'AI interpretation failed.' },
    };
    const notifications = buildSarif(partial).runs[0]!.invocations[0]!.toolExecutionNotifications;
    expect(notifications.some((n) => n.message.text.includes('partial'))).toBe(true);
  });

  it('fails structural validation when a result has no location', () => {
    const log = buildSarif(report);
    log.runs[0]!.results[0]!.locations = [];
    const validation = validateSarif(log);
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((i) => i.includes('artifact URI'))).toBe(true);
  });
});

describe('envelope contract version', () => {
  it('pins schemaVersion 1.0 for agents', () => {
    const env = buildReviewEnvelope(report);
    expect(env.schemaVersion).toBe('1.0');
    expect(JSON.parse(JSON.stringify(env)).schemaVersion).toBe('1.0');
  });
});
