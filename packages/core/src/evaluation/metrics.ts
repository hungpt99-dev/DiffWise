/**
 * Evaluation metrics.
 *
 * Everything here is arithmetic over a labelled dataset. There is no smoothing,
 * no extrapolation and no "estimated recall". A number that cannot be computed
 * from the data is left undefined rather than approximated.
 */
import { SEVERITY_ORDER } from '../types';
import type { EvaluationCase, EvaluationMetrics, EvaluationReport, CaseMatch, CaseResult } from './types';
import type { Finding } from '../types';

export function overlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/**
 * Match produced findings to the labelled expectations of one case.
 *
 * A match requires the same file, the same category and an overlapping line
 * window. Severity is compared separately: finding the defect at the wrong
 * severity is a different failure from missing it, and is reported as such.
 */
export function matchCase(
  testCase: EvaluationCase,
  findings: Finding[],
): { matches: CaseMatch[]; unexpected: CaseResult['unexpected']; forbiddenProduced: CaseResult['forbiddenProduced'] } {
  const used = new Set<string>();
  const matches: CaseMatch[] = [];

  for (const expected of testCase.expected) {
    const window = expected.lines ?? { start: 1, end: Number.MAX_SAFE_INTEGER };
    const candidates = findings.filter((f) =>
      !used.has(f.id)
      && f.file === expected.file
      && f.category === expected.category
      && overlap(f.range, window));
    if (candidates.length === 0) {
      matches.push({ expectedId: expected.id, status: 'missed', note: `no ${expected.category} finding overlapped ${expected.file}:${window.start}-${window.end}` });
      continue;
    }
    const best = candidates.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])[0] as Finding;
    used.add(best.id);
    const severityOk = SEVERITY_ORDER[best.severity] <= SEVERITY_ORDER[expected.severity];
    const verified = best.verification ? (best.verification.status === 'CONFIRMED' || best.verification.status === 'LIKELY') : true;
    if (expected.mustVerify && !verified) {
      matches.push({
        expectedId: expected.id, status: 'unverified', findingId: best.id,
        note: `found but ${best.verification?.status ?? 'unverified'} rather than confirmed/likely`,
      });
      continue;
    }
    matches.push({
      expectedId: expected.id,
      status: severityOk ? 'matched' : 'wrong-severity',
      findingId: best.id,
      note: severityOk
        ? `matched ${best.id} at ${best.severity}`
        : `found at ${best.severity} but the fixture is labelled ${expected.severity}`,
    });
  }

  const unexpected = findings
    .filter((f) => !used.has(f.id))
    .map((f) => ({ findingId: f.id, title: f.title, file: f.file, severity: f.severity, category: f.category }));

  const forbiddenProduced: CaseResult['forbiddenProduced'] = [];
  for (const forbidden of testCase.forbidden ?? []) {
    const window = forbidden.lines ?? { start: 1, end: Number.MAX_SAFE_INTEGER };
    const hit = findings.find((f) => f.file === forbidden.file && overlap(f.range, window));
    if (hit) forbiddenProduced.push({ id: forbidden.id, findingId: hit.id, reason: forbidden.reason });
  }

  return { matches, unexpected, forbiddenProduced };
}

export function computeMetrics(results: CaseResult[]): EvaluationMetrics {
  const expected = results.reduce((n, r) => n + r.expected, 0);
  const found = results.reduce((n, r) => n + r.found, 0);
  const matched = results.reduce((n, r) => n + r.matches.filter((m) => m.status === 'matched').length, 0);
  const wrongSeverity = results.reduce((n, r) => n + r.matches.filter((m) => m.status === 'wrong-severity').length, 0);
  const unverified = results.reduce((n, r) => n + r.matches.filter((m) => m.status === 'unverified').length, 0);
  const forbiddenViolations = results.reduce((n, r) => n + r.forbiddenProduced.length, 0);
  // A defect found at the wrong severity is still found. Counting it as a miss
  // would double-penalise the same finding, so detection and severity accuracy
  // are reported separately.
  const detected = matched + wrongSeverity;

  const precision = found > 0 ? round(detected / found) : undefined;
  const recall = expected > 0 ? round(detected / expected) : undefined;
  const f1 = precision !== undefined && recall !== undefined && precision + recall > 0
    ? round((2 * precision * recall) / (precision + recall))
    : undefined;

  return {
    cases: results.length,
    casesFailed: results.filter((r) => r.error).length,
    expected,
    found,
    detected,
    matched,
    ...(precision !== undefined ? { precision } : {}),
    ...(recall !== undefined ? { recall } : {}),
    ...(f1 !== undefined ? { f1 } : {}),
    ...(precision !== undefined ? { falsePositiveRate: round(1 - precision) } : {}),
    ...(detected > 0 ? { severityAccuracy: round(matched / detected) } : {}),
    ...(detected + unverified > 0 ? { verificationRate: round(detected / (detected + unverified)) } : {}),
    forbiddenViolations,
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * The sentence that must accompany every metric. Recall is only meaningful on a
 * dataset that is complete for its fixtures; precision says nothing about
 * defects nobody wrote down.
 */
export function scopeStatement(report: Pick<EvaluationReport, 'dataset' | 'metrics'>): string {
  const { metrics, dataset } = report;
  const base = `Measured on ${metrics.cases} labelled case(s) from dataset "${dataset.id}" (${metrics.expected} expected finding(s)).`;
  const caveat = 'Precision counts only findings that no expectation covers; on fixtures with deliberately extra noise those findings are not necessarily false positives. Recall is bounded by what the dataset labels, so it is not a claim about real-world defects that nobody recorded.';
  const forbidden = metrics.forbiddenViolations > 0
    ? ` ${metrics.forbiddenViolations} forbidden finding(s) were produced, which is a hard failure.`
    : ' No forbidden finding was produced.';
  return `${base} ${caveat}${forbidden}`;
}

export function emptyCaseResult(testCase: EvaluationCase, error: string): CaseResult {
  return {
    caseId: testCase.id,
    name: testCase.name,
    expected: testCase.expected.length,
    found: 0,
    matched: 0,
    matches: [],
    unexpected: [],
    forbiddenProduced: [],
    durationMs: 0,
    error,
  };
}
