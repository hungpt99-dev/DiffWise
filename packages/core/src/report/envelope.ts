/**
 * Stable, versioned JSON output contract for machine consumers.
 *
 * `ReviewReport` is the full internal artefact (large; includes diffs, symbols
 * and graph edges). Agents and CI need a smaller, stable envelope with an
 * explicit string version. This module owns that projection — the CLI, MCP and
 * the report server all emit it, so an agent written against `schemaVersion:
 * "1.0"` keeps working while the internal model evolves.
 */
import type { Finding, ReviewReport, Severity } from '../types';

export const JSON_SCHEMA_VERSION = '1.0';

export interface ReviewEnvelope {
  schemaVersion: typeof JSON_SCHEMA_VERSION;
  reviewId: string;
  status: 'completed' | 'partial' | 'failed';
  createdAt: string;
  durationMs: number;
  target: {
    mode: string;
    label: string;
    base?: string;
    head?: string;
    paths?: string[];
  };
  repository: {
    name: string;
    branch: string;
    headCommit: string;
    headSubject: string;
    root: string;
    languages: Array<{ language: string; files: number }>;
  };
  summary: {
    filesChanged: number;
    linesAdded: number;
    linesDeleted: number;
    findings: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
    changedSymbols: number;
    affectedComponents: number;
    documentationFindings: number;
    testsExecuted: boolean;
    aiUsed: boolean;
  };
  risk: {
    score: number;
    level: string;
    summary: string;
    method: string;
    factors: Array<{ id: string; label: string; points: number; maxPoints: number; explanation: string }>;
  };
  findings: Finding[];
  architectureImpact: {
    changedFiles: string[];
    directlyImpacted: string[];
    indirectlyImpacted: string[];
    edgeCount: number;
    edges: Array<{ from: string; to: string; kind: string; resolution: string; line: number }>;
    cycles: string[][];
    modules: Array<{ id: string; name: string; changed: boolean; files: number }>;
    conventions: Array<{ id: string; statement: string; supportingFiles: number; totalFiles: number }>;
  };
  documentationImpact: {
    changed: string[];
    findings: Array<{
      id: string; document: string; status: string; title: string; severity: string;
      reason: string; suggestedUpdate: string; confidence: string;
    }>;
  };
  testImpact: {
    related: Array<{ path: string; framework: string; targets: string[]; tests: number }>;
    uncoveredChanges: string[];
    uncoveredSymbols: Array<{ file: string; symbol: string }>;
    deletedTests: string[];
    suggested: Array<{ title: string; file: string; scenarios: string[] }>;
    execution: ReviewReport['tests']['execution'] | null;
    verificationRuns: ReviewReport['verification'];
  };
  recommendations: Array<{ findingId: string; title: string; severity: Severity; action: string; file: string; line: number }>;
  fixes: Array<{
    id: string; findingId: string; label: string; complexity: string;
    applies: boolean; files: string[]; source: string;
  }>;
  provider: ReviewReport['provider'];
  execution: ReviewReport['execution'];
  stages: Array<{ id: string; label: string; status: string; durationMs?: number; error?: string }>;
  completenessNote?: string;
}

function statusOf(report: ReviewReport): ReviewEnvelope['status'] {
  const s = report.summary.completeness;
  return s === 'failed' ? 'failed' : s === 'partial' ? 'partial' : 'completed';
}

export function buildReviewEnvelope(report: ReviewReport): ReviewEnvelope {
  const sum = report.summary.findingsBySeverity;
  const linesAdded = report.changes.reduce((n, c) => n + c.additions, 0);
  const linesDeleted = report.changes.reduce((n, c) => n + c.deletions, 0);
  const graph = report.architecture.graph;
  const documented = new Set(report.documentation.files.map((d) => d.path));

  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    reviewId: report.id,
    status: statusOf(report),
    createdAt: report.createdAt,
    durationMs: report.durationMs,
    target: {
      mode: report.target.mode,
      label: report.target.label,
      ...(report.target.base ? { base: report.target.base } : {}),
      ...(report.target.head ? { head: report.target.head } : {}),
      ...(report.target.paths ? { paths: report.target.paths } : {}),
    },
    repository: {
      name: report.repository.name,
      branch: report.repository.branch,
      headCommit: report.repository.headCommit,
      headSubject: report.repository.headSubject,
      root: report.repository.root,
      languages: report.repository.languages.slice(0, 10),
    },
    summary: {
      filesChanged: report.changes.length,
      linesAdded,
      linesDeleted,
      findings: report.findings.length,
      critical: sum.critical,
      high: sum.high,
      medium: sum.medium,
      low: sum.low,
      info: sum.info,
      changedSymbols: report.symbols.length,
      affectedComponents: report.summary.affectedComponents,
      documentationFindings: report.documentation.findings.length,
      testsExecuted: Boolean(report.tests.execution && report.tests.execution.status !== 'not-run'),
      aiUsed: report.summary.aiUsed,
    },
    risk: {
      score: report.risk.score,
      level: report.risk.level,
      summary: report.risk.summary,
      method: report.risk.method,
      factors: report.risk.factors.map((f) => ({
        id: f.id, label: f.label, points: f.points, maxPoints: f.maxPoints, explanation: f.explanation,
      })),
    },
    findings: report.findings,
    architectureImpact: {
      changedFiles: graph.changedFiles,
      directlyImpacted: graph.directlyImpacted,
      indirectlyImpacted: graph.indirectlyImpacted,
      edgeCount: graph.edgeCount,
      edges: graph.edges.slice(0, 2000).map((e) => ({ from: e.from, to: e.to, kind: e.kind, resolution: e.resolution, line: e.line })),
      cycles: graph.cycles,
      modules: graph.modules.map((m) => ({ id: m.id, name: m.name, changed: m.changed, files: m.files.length })),
      conventions: report.architecture.conventions.map((c) => ({
        id: c.id, statement: c.statement, supportingFiles: c.supportingFiles, totalFiles: c.totalFiles,
      })),
    },
    documentationImpact: {
      changed: report.changes.filter((c) => documented.has(c.path)).map((c) => c.path),
      findings: report.documentation.findings.map((d) => ({
        id: d.id, document: d.document, status: d.status, title: d.title, severity: d.severity,
        reason: d.reason, suggestedUpdate: d.suggestedUpdate, confidence: d.confidence,
      })),
    },
    testImpact: {
      related: report.tests.files
        .filter((t) => t.targets.some((target) => report.changes.some((c) => c.path === target)))
        .map((t) => ({ path: t.path, framework: t.framework, targets: t.targets, tests: t.testCount })),
      uncoveredChanges: report.tests.uncoveredChanges,
      uncoveredSymbols: report.tests.uncoveredSymbols,
      deletedTests: report.tests.deletedTests,
      suggested: report.tests.suggestions.map((s) => ({ title: s.title, file: s.file, scenarios: s.scenarios })),
      execution: report.tests.execution ?? null,
      verificationRuns: report.verification,
    },
    recommendations: report.findings.slice(0, 20).map((f) => ({
      findingId: f.id, title: f.title, severity: f.severity, action: f.recommendation, file: f.file, line: f.range.start,
    })),
    fixes: report.fixes.map((f) => ({
      id: f.id, findingId: f.findingId, label: f.label, complexity: f.complexity,
      applies: f.patch?.validation.applies ?? false, files: f.filesAffected, source: f.source,
    })),
    provider: report.provider,
    execution: report.execution,
    stages: report.stages.map((s) => ({
      id: s.id, label: s.label, status: s.status,
      ...(s.durationMs !== undefined ? { durationMs: s.durationMs } : {}),
      ...(s.error ? { error: s.error } : {}),
    })),
    ...(report.summary.completenessNote ? { completenessNote: report.summary.completenessNote } : {}),
  };
}
