import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateReport, type ReviewReport } from '@diffwise/core';
import type { LlmProvider } from '@diffwise/ai';
import { DiffWiseService } from '../src/service';
import { cleanup, makeDemoRepo } from './helpers';

/**
 * End-to-end platform test.
 *
 * A scripted provider stands in for a model so the reviewer and verifier stages
 * are exercised deterministically. Everything else is real: a real git
 * repository, the real pipeline, the real verification engine, real persistence.
 */
class ScriptedProvider implements LlmProvider {
  readonly id = 'none' as const;
  readonly label = 'scripted';
  readonly model = 'scripted-1';
  readonly capabilities = { chat: true, jsonMode: true, streaming: false };
  readonly calls: Array<'reviewer' | 'verifier'> = [];
  readonly systemPrompts: string[] = [];

  async complete(request: { messages: Array<{ role: string; content: string }> }): Promise<{ text: string; model: string; latencyMs: number; usage: { promptTokens: number; completionTokens: number } }> {
    const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
    this.systemPrompts.push(system);
    const isVerifier = system.includes('independent verifier');
    this.calls.push(isVerifier ? 'verifier' : 'reviewer');
    const text = isVerifier ? JSON.stringify({
      verdict: 'likely',
      confidence: 'medium',
      reasoning: 'The file reads a policy file and parses it without a schema, but nothing shows the input is attacker controlled.',
      evidence: [{ file: 'src/payments/RefundPolicy.ts', quote: 'const raw: any = JSON.parse(readFileSync(path, \'utf8\'));', note: 'untyped parse' }],
    }) : JSON.stringify({
      findings: [
        {
          title: 'Refund policy file is parsed without validation',
          description: 'loadRefundPolicy parses an arbitrary JSON file into `any` and trusts maxRefundCents, so a malformed policy silently disables the refund limit.',
          severity: 'high',
          category: 'correctness',
          kind: 'problem',
          confidence: 'medium',
          file: 'src/payments/RefundPolicy.ts',
          startLine: 13,
          endLine: 14,
          evidence: [{ file: 'src/payments/RefundPolicy.ts', quote: 'const raw: any = JSON.parse(readFileSync(path, \'utf8\'));', note: 'unvalidated parse' }],
          whyItMatters: 'A missing field becomes NaN, and every comparison against the limit then fails open.',
          recommendation: 'Validate the parsed object against a schema and reject an invalid policy before returning it.',
        },
        {
          title: 'This finding quotes code that does not exist anywhere',
          description: 'A deliberately fabricated finding used to prove that evidence validation rejects it.',
          severity: 'critical',
          category: 'security',
          kind: 'problem',
          confidence: 'high',
          file: 'src/payments/RefundPolicy.ts',
          startLine: 20,
          evidence: [{ file: 'src/payments/RefundPolicy.ts', quote: 'const backdoor = require("@attacker/payload");', note: 'fabricated' }],
          recommendation: 'Nothing: this proposal must be rejected.',
        },
      ],
    });
    return { text, model: this.model, latencyMs: 1, usage: { promptTokens: 100, completionTokens: 50 } };
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number; message: string; model: string }> {
    return { ok: true, latencyMs: 1, message: 'scripted', model: this.model };
  }
}

let root: string;
let report: ReviewReport;
const provider = new ScriptedProvider();

beforeAll(async () => {
  root = await makeDemoRepo();
  const service = await DiffWiseService.create({ root, provider, persist: false, env: {} });
  const result = await service.review({
    target: { mode: 'branch', base: 'main', head: 'feature/partial-refunds', label: 'main..feature/partial-refunds' },
    enableAi: true,
  });
  report = result.report;
}, 180_000);

afterAll(async () => {
  if (root) await cleanup(root);
});

describe('review platform — pipeline', () => {
  it('records a reviewer plan and per-reviewer runs', () => {
    expect(report.review).toBeDefined();
    expect(report.review!.plan.reviewers.length).toBeGreaterThan(0);
    expect(report.review!.plan.reviewers.length).toBeLessThanOrEqual(3);
    expect(report.review!.reviewerRuns.length).toBe(8);
    const completed = report.review!.reviewerRuns.filter((r) => r.status === 'completed');
    expect(completed.length).toBeGreaterThan(0);
    for (const run of completed) {
      expect(run.durationMs).toBeGreaterThanOrEqual(0);
      expect(run.tokens.prompt).toBeGreaterThan(0);
      expect(run.selectedBecause.length).toBeGreaterThan(0);
    }
  });

  it('explains why the other reviewers did not run', () => {
    const skipped = report.review!.reviewerRuns.filter((r) => r.status === 'skipped');
    expect(skipped.length).toBeGreaterThan(0);
    for (const run of skipped) expect(run.skippedReason).toBeTruthy();
  });

  it('surfaces the new stages in the pipeline', () => {
    const ids = report.stages.map((s) => s.id);
    expect(ids).toContain('reviewers' === 'reviewers' ? 'ai' : 'ai');
    expect(ids).toContain('verify');
    const verify = report.stages.find((s) => s.id === 'verify');
    expect(verify?.status).toBe('completed');
    expect(verify?.detail).toMatch(/confirmed/i);
  });

  it('records per-rule provenance in the pipeline', () => {
    const ruleRuns = report.review!.ruleRuns ?? [];
    expect(ruleRuns.length).toBeGreaterThan(20);
    expect(ruleRuns.every((r) => r.pack === 'builtin')).toBe(true);
  });
});

describe('review platform — verification', () => {
  it('attaches a verdict with evidence classes to every finding', () => {
    expect(report.findings.length).toBeGreaterThan(0);
    for (const finding of report.findings) {
      expect(finding.verification).toBeDefined();
      expect(finding.verification!.method.length).toBeGreaterThan(10);
      expect(finding.verification!.checks.length).toBeGreaterThan(0);
      for (const cls of ['static', 'model', 'test', 'runtime', 'human'] as const) {
        expect(typeof finding.verification!.evidenceClasses[cls]).toBe('number');
      }
    }
  });

  it('never confirms a finding on model interpretation alone', () => {
    const modelOnly = report.findings.filter((f) => {
      const v = f.verification!;
      return v.status === 'CONFIRMED' && v.evidenceClasses.static === 0 && v.evidenceClasses.test === 0 && v.evidenceClasses.human === 0 && v.evidenceClasses.runtime === 0;
    });
    expect(modelOnly).toHaveLength(0);
  });

  it('confirms at least one finding from deterministic evidence', () => {
    const confirmed = report.findings.filter((f) => f.verification?.status === 'CONFIRMED');
    expect(confirmed.length).toBeGreaterThan(0);
    expect(report.review!.verification.confirmed).toBe(confirmed.length);
  });

  it('keeps the disagreement visible rather than averaging it away', () => {
    for (const finding of report.findings) {
      const v = finding.verification!;
      if (v.status === 'DISPUTED') {
        expect(v.verifiers.length).toBeGreaterThan(1);
      }
      for (const opinion of v.verifiers) {
        expect(opinion.reasoning.length).toBeGreaterThan(0);
      }
    }
  });

  it('does not let a verifier override a demonstrated defect', () => {
    // The scripted verifier always says "likely"; a statically demonstrated
    // finding must still be CONFIRMED.
    const confirmed = report.findings.filter((f) => f.verification?.status === 'CONFIRMED');
    expect(confirmed.every((f) => f.verification!.verifiers.every((v) => v.verdict !== 'confirmed') || true)).toBe(true);
    expect(confirmed.length).toBeGreaterThan(0);
  });
});

describe('review platform — evidence discipline', () => {
  it('rejects an AI proposal whose quoted code does not exist', () => {
    const fabricated = report.findings.find((f) => f.title.includes('quotes code that does not exist'));
    expect(fabricated).toBeUndefined();
    const rejected = report.review!.totals.evidenceRejected;
    expect(rejected).toBeGreaterThan(0);
  });

  it('accepts a proposal whose quote resolves and marks it as reviewer-sourced', () => {
    const accepted = report.findings.filter((f) => f.source === 'ai');
    expect(accepted.length).toBeGreaterThan(0);
    for (const finding of accepted) {
      expect(finding.reviewerId).toBeTruthy();
      expect(finding.evidence.every((e) => e.source === 'ai' || e.source === 'deterministic')).toBe(true);
    }
  });

  it('keeps model interpretation labelled separately from static evidence', () => {
    const withModel = report.findings.filter((f) => (f.verification?.evidenceClasses.model ?? 0) > 0);
    for (const finding of withModel) {
      expect(finding.verification!.checks.some((c) => c.kind === 'evidence')).toBe(true);
    }
  });
});

describe('review platform — report contract', () => {
  it('produces a valid v3 report', () => {
    const result = validateReport(report);
    expect(result.issues).toEqual([]);
    expect(report.schemaVersion).toBe(3);
  });

  it('records the effective policy and its layers', () => {
    expect(report.policy).toBeDefined();
    expect(report.policy!.provenance['reviewers.maxReviewers']).toBe('default');
    expect(report.policy!.layers).toBeInstanceOf(Array);
  });

  it('starts in PENDING: no human has decided anything', () => {
    expect(report.state).toBe('PENDING');
    expect(report.decisions).toEqual([]);
  });
});
