import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runReview, type ReviewReport } from '@diffwise/core';
import { DiffWiseService } from '../src';
import { cleanup, makeDemoRepo, makeSmallRepo } from './helpers';

/**
 * Interface parity.
 *
 * The product claim is that a review started from VS Code, the CLI or MCP is the
 * same review. Before this cycle the extension called `runReview` directly with
 * a single AI reviewer, so an editor review had no policy, no reviewer plan, no
 * independent verification and no usage accounting — the same change could be
 * judged differently in the editor and in CI.
 *
 * These tests pin the contract the extension now depends on:
 *   1. the shared path attaches policy, reviewer plan, verification and approvals;
 *   2. the core-only path the extension used to take does not;
 *   3. interface-level settings are an override layer, recorded in the report;
 *   4. finding identity is stable across runs and interfaces.
 */
/** A provider that answers with a fixed finding, so no network is involved. */
class FakeProvider {
  readonly id = 'openai-compatible' as const;
  readonly label = 'fake';
  readonly model = 'fake-model';
  readonly capabilities = { chat: true, jsonMode: true, streaming: false, maxContextTokens: 128_000 };
  calls = 0;

  async complete(): Promise<{ text: string; model: string; latencyMs: number; usage: { promptTokens: number; completionTokens: number } }> {
    this.calls += 1;
    return {
      text: JSON.stringify({ findings: [], missingDimensions: [] }),
      model: this.model,
      latencyMs: 1,
      usage: { promptTokens: 100, completionTokens: 20 },
    };
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number; message: string; model: string }> {
    return { ok: true, latencyMs: 1, message: 'ok', model: this.model };
  }
}

let root: string;

const TARGET = { mode: 'branch' as const, base: 'main', head: 'feature/partial-refunds', label: 'main..feature/partial-refunds' };

beforeAll(async () => {
  root = await makeDemoRepo();
}, 120_000);

afterAll(async () => {
  if (root) await cleanup(root);
});

describe('shared execution path', () => {
  let report: ReviewReport;

  beforeAll(async () => {
    const service = await DiffWiseService.create({ root, persist: false });
    report = (await service.review({ target: TARGET, disableAi: true })).report;
  }, 120_000);

  it('records the platform state every interface relies on', () => {
    expect(report.policy, 'policy snapshot').toBeTruthy();
    expect(report.review, 'review pipeline info').toBeTruthy();
    expect(report.review?.verification.performed).toBe(true);
    // With AI disabled no reviewer is selected — that is a decision the plan
    // records, not a missing feature.
    expect(report.review?.plan.reviewers).toEqual([]);
    // The AI stage records why it did not run instead of silently reporting a
    // complete analysis.
    const aiStage = report.stages.find((s) => s.id === 'ai');
    expect(aiStage?.status).toBe('skipped');
    expect(aiStage?.detail ?? aiStage?.error ?? '').toMatch(/disabled|no ai/i);
    expect(report.settings.aiEnabled).toBe(false);
    expect(report.summary.aiUsed).toBe(false);
  });

  it('attaches a verification verdict to every published finding', () => {
    expect(report.findings.length).toBeGreaterThan(0);
    for (const finding of report.findings) {
      expect(finding.verification, `${finding.id} has no verdict`).toBeTruthy();
    }
  });

  it('produces the same finding identity on a second run', async () => {
    const service = await DiffWiseService.create({ root, persist: false });
    const again = (await service.review({ target: TARGET, disableAi: true })).report;
    const ids = (r: ReviewReport): string[] => r.findings.map((f) => f.id).sort();
    expect(ids(again)).toEqual(ids(report));
  }, 120_000);
});

describe('the core-only path the extension used to take', () => {
  it('lacks policy, reviewer selection and per-task usage that the service provides', async () => {
    // Same repository, same model, same canned answer: only the execution path
    // differs. This is the divergence the extension used to have.
    const core = await runReview({
      root,
      target: TARGET,
      settings: { aiEnabled: true },
      enrichers: [new (await import('@diffwise/ai')).AiReviewer(new FakeProvider())],
      persist: false,
    });
    const service = await DiffWiseService.create({ root, provider: new FakeProvider(), persist: false });
    const shared = (await service.review({ target: TARGET })).report;

    expect(core.policy, 'core path resolves no policy').toBeUndefined();
    expect(core.review?.plan.reviewers ?? []).toEqual([]);
    expect(core.ai?.byTask ?? []).toEqual([]);

    expect(shared.policy, 'service path resolves policy').toBeTruthy();
    expect(shared.review?.plan.reviewers.length).toBeGreaterThan(0);
    expect(new Set((shared.ai?.byTask ?? []).map((t) => t.task)).size).toBeGreaterThan(0);
  }, 180_000);
});

describe('interface settings as an override layer', () => {
  it('applies the interface values and records them in the report', async () => {
    const service = await DiffWiseService.create({ root, persist: false });
    const overridden = (await service.review({
      target: TARGET,
      disableAi: true,
      settings: { maxFiles: 3, sendRepositoryContent: true },
    })).report;
    expect(overridden.settings.maxFiles).toBe(3);
    // Consent is recorded, not inferred.
    expect(overridden.settings.sendRepositoryContent).toBe(true);
  }, 120_000);

  it('does not leak an override into the next review', async () => {
    const service = await DiffWiseService.create({ root, persist: false });
    await service.review({ target: TARGET, disableAi: true, settings: { maxFiles: 3 } });
    const next = (await service.review({ target: TARGET, disableAi: true })).report;
    expect(next.settings.maxFiles).not.toBe(3);
  }, 180_000);
});

describe('verification through the service', () => {
  it('runs the interface-supplied command and records who approved it', async () => {
    const repo = await makeSmallRepo();
    try {
      await writeFile(join(repo, 'src/math.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport const extra = 1;\n', 'utf8');
      const service = await DiffWiseService.create({ root: repo });
      await service.review({ target: { mode: 'working', label: 'working tree' }, disableAi: true });
      const result = await service.verify({
        command: `${process.execPath} -e "process.exit(0)"`,
        approvedBy: 'web',
      });
      expect(result.execution.status).toBe('passed');
      expect(result.record.approvedBy).toBe('web');
      expect(result.report.verification.some((v) => v.id === result.record.id)).toBe(true);
    } finally {
      await cleanup(repo);
    }
  }, 120_000);

  it('refuses to run when no command is configured', async () => {
    const repo = await makeSmallRepo();
    try {
      await writeFile(join(repo, 'src/math.ts'), 'export const extra = 2;\n', 'utf8');
      const service = await DiffWiseService.create({ root: repo });
      await service.review({ target: { mode: 'working', label: 'working tree' }, disableAi: true });
      await expect(service.verify()).rejects.toMatchObject({ code: 'NO_VERIFICATION_COMMAND' });
    } finally {
      await cleanup(repo);
    }
  }, 120_000);
});

describe('storage configuration', () => {
  it('honours a custom storage directory so interfaces do not write to different places', async () => {
    const repo = await makeSmallRepo();
    try {
      await writeFile(join(repo, 'src/math.ts'), 'export const extra = 3;\n', 'utf8');
      const service = await DiffWiseService.create({ root: repo, storageDir: '.diffwise-alt' });
      const { report, path } = await service.review({ target: { mode: 'working', label: 'working tree' }, disableAi: true });
      expect(path).toContain('.diffwise-alt');
      const stored = JSON.parse(await readFile(path!, 'utf8')) as ReviewReport;
      expect(stored.id).toBe(report.id);
      const listed = await service.listReviews(5);
      expect(listed.map((r) => r.id)).toContain(report.id);
    } finally {
      await cleanup(repo);
    }
  }, 120_000);
});
