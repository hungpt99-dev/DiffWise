/**
 * Evaluation contracts.
 *
 * A dataset is a set of labelled cases: a repository, a change to review, and
 * the defects that a correct reviewer must find. Metrics are computed against
 * that ground truth and nothing else — DiffWise never reports a recall figure
 * without saying which dataset produced it.
 */
import type { FindingCategory, Severity } from '../types';

export interface ExpectedFinding {
  /** Stable id used in the report, so a miss can be discussed by name. */
  id: string;
  /** Human description of the defect the fixture contains. */
  description: string;
  /** Category the detector must use. */
  category: FindingCategory;
  /** File the defect lives in. */
  file: string;
  /** Acceptable line window, in new-file coordinates. */
  lines?: { start: number; end: number };
  /** Minimum severity that counts as a correct assessment. */
  severity: Severity;
  /** Rule or reviewer expected to find it. Informational, not required to match. */
  detectedBy?: string;
  /** True when the defect must survive verification (not just be proposed). */
  mustVerify?: boolean;
  /** True when a test run is expected to reproduce it. */
  reproducible?: boolean;
}

export interface EvaluationCase {
  id: string;
  name: string;
  description: string;
  /** Repository directory, relative to the dataset root. */
  repository: string;
  target: { mode: 'working' | 'staged' | 'branch' | 'commits' | 'files'; base?: string; head?: string; label: string };
  expected: ExpectedFinding[];
  /** Findings that must NOT be produced (known false-positive traps). */
  forbidden?: Array<{ id: string; description: string; file: string; lines?: { start: number; end: number }; reason: string }>;
  /** Limit analysis to these paths, keeping the fixture small. */
  paths?: string[];
  /**
   * Categories this case does not label. Findings in them are excluded from the
   * precision computation rather than counted as noise — a corpus that only
   * labels defects must say what it deliberately does not label.
   */
  ignoreCategories?: FindingCategory[];
}

export interface EvaluationDataset {
  schemaVersion: number;
  id: string;
  name: string;
  description: string;
  /** How the fixtures are materialised, for reproducibility. */
  builder?: string;
  cases: EvaluationCase[];
}

export interface CaseMatch {
  expectedId: string;
  status: 'matched' | 'missed' | 'wrong-severity' | 'unverified';
  findingId?: string;
  note: string;
}

export interface CaseResult {
  caseId: string;
  name: string;
  expected: number;
  found: number;
  matched: number;
  matches: CaseMatch[];
  /** Findings produced that no expectation accounts for. */
  unexpected: Array<{ findingId: string; title: string; file: string; severity: Severity; category: FindingCategory }>;
  forbiddenProduced: Array<{ id: string; findingId: string; reason: string }>;
  durationMs: number;
  error?: string;
}

export interface EvaluationMetrics {
  cases: number;
  casesFailed: number;
  expected: number;
  found: number;
  /** Expectations whose defect was found, at any severity. */
  detected: number;
  /** Expectations found at the labelled severity or better. */
  matched: number;
  /** detected / found. Undefined when nothing was found. */
  precision?: number;
  /** detected / expected. Only meaningful when the dataset is complete for its cases. */
  recall?: number;
  f1?: number;
  falsePositiveRate?: number;
  /** Share of detected findings whose severity met the labelled severity. */
  severityAccuracy?: number;
  /** Share of detected findings that reached CONFIRMED or LIKELY. */
  verificationRate?: number;
  forbiddenViolations: number;
}

export interface EvaluationReport {
  dataset: { id: string; name: string; cases: number };
  startedAt: string;
  durationMs: number;
  results: CaseResult[];
  metrics: EvaluationMetrics;
  /** Explicit statement of what these numbers do and do not mean. */
  scope: string;
  tool: { name: string; version: string; node: string; platform: string };
}

export const EVALUATION_SCHEMA_VERSION = 1;
