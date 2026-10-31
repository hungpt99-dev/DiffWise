import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_ANALYSIS_SETTINGS, EmptyReviewError, ReviewCancelledError, runReview,
} from '@diffwise/core';
import type { ReviewReport } from '@diffwise/core';

/**
 * Integration test: a real git repository, the real pipeline, no model.
 *
 * The demo fixture is materialised by the same script used for screenshots and
 * manual testing, so this test covers the exact artefact shipped to users.
 */
const repoRoot = resolve(__dirname, '../../..');
let demo: string;
let report: ReviewReport;

beforeAll(async () => {
  demo = await mkdtemp(join(tmpdir(), 'diffwise-integration-'));
  execFileSync(process.execPath, [join(repoRoot, 'demo/build-demo-repo.mjs'), '--target', demo], {
    cwd: repoRoot,
    stdio: 'pipe',
  });
  report = await runReview({
    root: demo,
    target: { mode: 'branch', base: 'main', head: 'feature/partial-refunds', label: 'main...feature/partial-refunds' },
    settings: { ...DEFAULT_ANALYSIS_SETTINGS, aiEnabled: false },
    persist: false,
  });
}, 120_000);

afterAll(async () => {
  if (demo) await rm(demo, { recursive: true, force: true });
});

describe('full review pipeline', () => {
  it('analyses every staged, unstaged and committed change in the fixture', () => {
    expect(report.changes.length).toBeGreaterThanOrEqual(6);
    expect(report.symbols.length).toBeGreaterThan(5);
    expect(report.changeGroups.length).toBeGreaterThan(0);
    expect(report.summary.completeness).toBe('complete');
  });

  it('produces evidence-backed findings for the seeded defects', () => {
    const ids = report.findings.map((f) => f.ruleId);
    expect(ids).toContain('security.sql-injection');
    expect(ids).toContain('security.hardcoded-secret');
    expect(ids).toContain('api.removed-route');
    expect(ids).toContain('database.destructive-migration');
    expect(ids).toContain('concurrency.read-modify-write');
    for (const finding of report.findings) {
      expect(finding.evidence.length).toBeGreaterThan(0);
      expect(finding.file).not.toMatch(/^\//);
      expect(finding.range.start).toBeGreaterThan(0);
    }
  });

  it('detects documentation that no longer matches the code', () => {
    expect(report.documentation.files.length).toBeGreaterThan(0);
    expect(report.documentation.findings.length).toBeGreaterThan(0);
    const docs = report.documentation.findings.map((d) => d.document).join(' ');
    expect(docs).toMatch(/README\.md|docs\/payments\.md|openapi\.yaml/);
  });

  it('computes risk from explicit factors', () => {
    expect(report.risk.factors.length).toBeGreaterThan(3);
    expect(report.risk.score).toBeGreaterThan(40);
    expect(['high', 'severe']).toContain(report.risk.level);
    expect(report.risk.method).toMatch(/factor/i);
    const sum = report.risk.factors.reduce((n, f) => n + f.points, 0);
    expect(sum).toBeGreaterThanOrEqual(report.risk.score);
  });

  it('reads recorded agent intent and compares it with the diff', () => {
    expect(report.agent.intents.length).toBe(1);
    expect(report.agent.decisions.length).toBeGreaterThan(0);
    expect(report.agent.intentAlignment.length).toBeGreaterThan(0);
    const verdict = report.agent.intentAlignment[0]!.verdict;
    expect(['aligned', 'partially-aligned', 'divergent', 'not-verifiable']).toContain(verdict);
  });

  it('resolves tests and reports the untested surface', () => {
    expect(report.tests.files.length).toBeGreaterThan(0);
    expect(report.tests.files[0]!.targets.length).toBeGreaterThan(0);
    expect(report.summary.testsExecuted).toBe(false);
  });

  it('marks the AI stage skipped rather than claiming it ran', () => {
    const ai = report.stages.find((s) => s.id === 'ai');
    expect(ai?.status).toBe('skipped');
    expect(report.summary.aiUsed).toBe(false);
  });

  it('throws a typed error when the target has no changes', async () => {
    await expect(runReview({
      root: demo,
      target: { mode: 'commits', base: 'HEAD', head: 'HEAD', label: 'empty' },
      settings: { ...DEFAULT_ANALYSIS_SETTINGS, aiEnabled: false },
      persist: false,
    })).rejects.toBeInstanceOf(EmptyReviewError);
  });

  it('stops when the caller cancels', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runReview({
      root: demo,
      target: { mode: 'branch', base: 'main', head: 'feature/partial-refunds', label: 'cancel' },
      settings: { ...DEFAULT_ANALYSIS_SETTINGS, aiEnabled: false },
      persist: false,
      signal: controller.signal,
    })).rejects.toBeInstanceOf(ReviewCancelledError);
  });
});
