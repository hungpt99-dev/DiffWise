import type { Finding, RiskAssessment, RiskFactor, TestAnalysis, FileChange, Evidence } from '../types';
import { isMigrationFile } from './languages';
import { clamp } from '../util/text';

export interface RiskInput {
  findings: Finding[];
  changes: FileChange[];
  tests: TestAnalysis;
  affectedComponents: number;
  documentationFindings: number;
  changedLines: number;
}

/**
 * Transparent weighted-factor risk model.
 *
 * Every point in the final score is attributable to a factor with evidence, and
 * each factor is capped so a single noisy category cannot dominate. The score is
 * not a probability and the report says so.
 */
export function assessRisk(input: RiskInput): RiskAssessment {
  const { findings, changes, tests, affectedComponents, documentationFindings } = input;
  const factors: RiskFactor[] = [];
  const count = (pred: (f: Finding) => boolean): number => findings.filter(pred).length;

  const contractFindings = findings.filter((f) => f.category === 'api-contract');
  const contractPoints = clamp(contractFindings.length * 12, 0, 24);
  if (contractPoints > 0) {
    factors.push({
      id: 'contract',
      label: 'Public contract changes',
      points: contractPoints,
      maxPoints: 24,
      explanation: `${contractFindings.length} finding(s) change or remove an interface other code relies on.`,
      evidence: contractFindings.slice(0, 3).map(toEvidence),
    });
  }

  const securityCritical = count((f) => f.category === 'security' && (f.severity === 'critical' || f.severity === 'high'));
  const securityPoints = clamp(securityCritical * 15, 0, 30);
  if (securityPoints > 0) {
    factors.push({
      id: 'security',
      label: 'Security exposure',
      points: securityPoints,
      maxPoints: 30,
      explanation: `${securityCritical} high/critical security finding(s) in added code.`,
      evidence: findings.filter((f) => f.category === 'security' && (f.severity === 'critical' || f.severity === 'high')).slice(0, 3).map(toEvidence),
    });
  }

  const dataChange = changes.some((c) => isMigrationFile(c.path)
    || c.hunks.some((h) => h.lines.some((l) => l.kind === 'add' && /\b(UPDATE|INSERT|DELETE|ALTER|DROP|TRUNCATE)\b|\.(save|update|delete)\s*\(/.test(l.text))));
  const dbFindings = findings.filter((f) => f.category === 'database' || f.category === 'concurrency');
  const dataPoints = clamp((dataChange ? 10 : 0) + dbFindings.length * 4, 0, 20);
  if (dataPoints > 0) {
    factors.push({
      id: 'data',
      label: 'Persistent data and concurrency',
      points: dataPoints,
      maxPoints: 20,
      explanation: `${dataChange ? 'The change writes persistent data. ' : ''}${dbFindings.length} database/concurrency finding(s); failures here corrupt state rather than only failing a request.`,
      evidence: dbFindings.slice(0, 3).map(toEvidence),
    });
  }

  const blastPoints = clamp(Math.round(Math.log2(affectedComponents + 1) * 4), 0, 16);
  if (blastPoints > 0) {
    factors.push({
      id: 'blast-radius',
      label: 'Blast radius',
      points: blastPoints,
      maxPoints: 16,
      explanation: `${affectedComponents} other file(s) import the changed modules (direct and transitive).`,
      evidence: [{
        kind: 'graph',
        note: `${affectedComponents} impacted files resolved through the static import graph.`,
        source: 'deterministic',
      }],
    });
  }

  const uncoveredRatio = changes.length === 0 ? 0 : tests.uncoveredChanges.length / changes.filter((c) => /\.(ts|tsx|js|jsx|py|java|go|kt|rb|php|cs|rs)$/.test(c.path)).length || 0;
  const testPoints = clamp(Math.round(uncoveredRatio * 14), 0, 14);
  if (testPoints > 0) {
    factors.push({
      id: 'test-gap',
      label: 'Unverified behaviour',
      points: testPoints,
      maxPoints: 14,
      explanation: `${tests.uncoveredChanges.length} changed source file(s) have no associated test file. Static association only; no coverage run was used.`,
      evidence: tests.uncoveredChanges.slice(0, 3).map((f) => ({
        kind: 'test' as const, file: f, note: 'No test file maps to this source file.', source: 'deterministic' as const,
      })),
    });
  }

  const docPoints = clamp(documentationFindings * 4, 0, 8);
  if (docPoints > 0) {
    factors.push({
      id: 'documentation',
      label: 'Documentation drift',
      points: docPoints,
      maxPoints: 8,
      explanation: `${documentationFindings} documentation finding(s) where the document no longer matches the implementation.`,
      evidence: [],
    });
  }

  const highFindings = findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
  const severityPoints = clamp(
    findings.filter((f) => f.severity === 'critical').length * 6 + findings.filter((f) => f.severity === 'high').length * 3,
    0, 18,
  );
  if (severityPoints > 0) {
    factors.push({
      id: 'findings',
      label: 'Finding severity',
      points: severityPoints,
      maxPoints: 18,
      explanation: `${highFindings.length} critical/high finding(s) across all categories (capped to avoid double counting).`,
      evidence: highFindings.slice(0, 3).map(toEvidence),
    });
  }

  const testsUpdated = changes.some((c) => /\.(test|spec)\.|_test\.|Tests?\./.test(c.path));
  if (testsUpdated) {
    factors.push({
      id: 'tests-updated',
      label: 'Verification included in the change',
      points: -6,
      maxPoints: 6,
      explanation: 'The change modifies test files as well, which lowers (but does not remove) regression risk.',
      evidence: [],
    });
  }

  const score = clamp(factors.reduce((n, f) => n + f.points, 0), 0, 100);
  const level: RiskAssessment['level'] = score < 20 ? 'low' : score < 45 ? 'moderate' : score < 70 ? 'high' : 'severe';
  const top = [...factors].filter((f) => f.points > 0).sort((a, b) => b.points - a.points).slice(0, 3);

  return {
    score,
    level,
    summary: top.length
      ? `${level.toUpperCase()} (${score}/100). Main contributors: ${top.map((f) => `${f.label.toLowerCase()} (+${f.points})`).join(', ')}.`
      : `LOW (${score}/100). No risk factor scored above zero: no contract changes, no security or data findings, and the change is narrow.`,
    factors,
    method: 'Weighted factor model over deterministic evidence: each factor is capped, contributions are listed, and the total is clamped to 0-100. It is a prioritisation aid, not a probability of failure. AI findings contribute only through the same category weights, never as a raw model score.',
  };
}

function toEvidence(f: Finding): Evidence {
  return {
    kind: 'diff',
    file: f.file,
    line: f.range.start,
    snippet: `${f.severity} · ${f.title}`,
    note: f.id,
    source: f.source === 'ai' ? 'ai' : 'deterministic',
  };
}
