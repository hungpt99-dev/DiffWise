/**
 * Evaluation runner.
 *
 * Runs the real pipeline over each labelled fixture. No provider is required:
 * the deterministic rules and the verification engine run exactly as they do in
 * production, which is what makes the numbers meaningful.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { runReview } from '../analysis/pipeline';
import type { ReviewReport } from '../types';
import { computeMetrics, emptyCaseResult, matchCase, scopeStatement } from './metrics';
import type { CaseResult, EvaluationCase, EvaluationDataset, EvaluationReport } from './types';
import { EVALUATION_SCHEMA_VERSION } from './types';

export interface EvaluationOptions {
  datasetPath: string;
  /** Run the AI reviewers too. Requires a provider-aware runner. */
  review?: (testCase: EvaluationCase, root: string) => Promise<ReviewReport>;
  log?(message: string): void;
}

/** Load and validate a dataset file (`dataset.json`). */
export async function loadDataset(path: string): Promise<{ dataset: EvaluationDataset; root: string }> {
  const file = path.endsWith('.json') ? path : join(path, 'dataset.json');
  const root = resolve(file, '..');
  const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
  if (typeof raw !== 'object' || raw === null) throw new Error(`${file} does not contain an object`);
  const dataset = raw as EvaluationDataset;
  if (dataset.schemaVersion !== EVALUATION_SCHEMA_VERSION) {
    throw new Error(`${file}: schemaVersion ${String(dataset.schemaVersion)} is not ${EVALUATION_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(dataset.cases) || dataset.cases.length === 0) throw new Error(`${file}: no cases`);
  for (const testCase of dataset.cases) {
    if (!testCase.id || !testCase.repository) throw new Error(`${file}: a case is missing id or repository`);
    if (!Array.isArray(testCase.expected)) throw new Error(`${file}: case ${testCase.id} has no expected findings`);
  }
  return { dataset, root };
}

function repoPath(root: string, repository: string): string {
  return isAbsolute(repository) ? repository : join(root, repository);
}

/**
 * Run the dataset.
 *
 * A case that throws is recorded as failed rather than skipped: a dataset that
 * silently drops its hard cases reports a better score than it earned.
 */
export async function runEvaluation(options: EvaluationOptions): Promise<EvaluationReport> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const { dataset, root } = await loadDataset(options.datasetPath);
  const results: CaseResult[] = [];

  for (const testCase of dataset.cases) {
    const caseStart = Date.now();
    const dir = repoPath(root, testCase.repository);
    try {
      options.log?.(`case ${testCase.id}: ${testCase.name}`);
      const report = options.review
        ? await options.review(testCase, dir)
        : await runReview({
          root: dir,
          target: testCase.target,
          settings: { aiEnabled: false },
          persist: false,
        });

      const ignored = new Set(testCase.ignoreCategories ?? []);
      const findings = report.findings
        .filter((f) => (testCase.paths?.length ? testCase.paths.some((p) => f.file === p || f.file.startsWith(p)) : true))
        .filter((f) => !ignored.has(f.category));

      const { matches, unexpected, forbiddenProduced } = matchCase(testCase, findings);
      results.push({
        caseId: testCase.id,
        name: testCase.name,
        expected: testCase.expected.length,
        found: findings.length,
        matched: matches.filter((m) => m.status === 'matched').length,
        matches,
        unexpected,
        forbiddenProduced,
        durationMs: Date.now() - caseStart,
      });
    } catch (err) {
      results.push({ ...emptyCaseResult(testCase, (err as Error).message), durationMs: Date.now() - caseStart });
    }
  }

  const metrics = computeMetrics(results);
  const report: Omit<EvaluationReport, 'scope'> = {
    dataset: { id: dataset.id, name: dataset.name, cases: dataset.cases.length },
    startedAt,
    durationMs: Date.now() - t0,
    results,
    metrics,
    tool: {
      name: 'diffwise-core',
      version: '0.3.0',
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
  };
  return { ...report, scope: scopeStatement({ dataset: report.dataset, metrics }) };
}
