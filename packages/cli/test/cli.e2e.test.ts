import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateSarif } from '@diffwise/core';

/**
 * End-to-end CLI tests.
 *
 * Every case spawns the real bin against a real git repository and asserts the
 * exit code and the stdout/stderr split that scripts and agents depend on.
 */
const exec = promisify(execFile);
const bin = resolve(__dirname, '../bin/diffwise.js');
const repoRoot = resolve(__dirname, '../../..');

interface RunResult { stdout: string; stderr: string; code: number }

async function run(args: string[], cwd: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [bin, ...args], {
      cwd,
      env: { ...process.env, DIFFWISE_AI: 'off', NO_COLOR: '1' },
      maxBuffer: 20 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

let demo: string;

beforeAll(async () => {
  demo = await mkdtemp(join(tmpdir(), 'diffwise-cli-'));
  await exec(process.execPath, [join(repoRoot, 'demo/build-demo-repo.mjs'), '--target', demo], { cwd: repoRoot });
  await run(['init'], demo);
  await run(['config', 'set', 'qualityGate.failOn', 'high'], demo);
}, 180_000);

afterAll(async () => {
  if (demo) await rm(demo, { recursive: true, force: true });
});

describe('cli: startup and metadata', () => {
  it('prints help on --help with exit 0', async () => {
    const { stdout, code } = await run(['--help'], demo);
    expect(code).toBe(0);
    expect(stdout).toContain('Usage: diffwise');
    expect(stdout).toContain('review');
  });

  it('prints version metadata as JSON', async () => {
    const { stdout, code } = await run(['version', '--json'], demo);
    expect(code).toBe(0);
    const info = JSON.parse(stdout) as { version: string; reportSchemaVersion: number; jsonSchemaVersion: string };
    expect(info.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(info.reportSchemaVersion).toBe(3);
    expect(info.jsonSchemaVersion).toBe('1.0');
  });

  it('exits 2 for an unknown command, and says why on stderr only', async () => {
    const { stdout, stderr, code } = await run(['frobnicate'], demo);
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/Unknown command/);
  });

  it('exits 3 outside a git repository', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'diffwise-nogit-'));
    try {
      const { stderr, code } = await run(['review'], outside);
      expect(code).toBe(3);
      expect(stderr).toMatch(/Not inside a git repository/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('doctor reports checks as JSON and passes on a usable repo', async () => {
    const { stdout, code } = await run(['doctor', '--json'], demo);
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as { ok: boolean; checks: Array<{ id: string; status: string }> };
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.id)).toContain('git');
    expect(result.checks.find((c) => c.id === 'provider')?.status).toBe('skip');
  });
});

describe('cli: review and machine output', () => {
  it('reviews a branch, keeps stdout machine-readable and exits 1 on the gate', async () => {
    const { stdout, stderr, code } = await run(['review', 'main..feature/partial-refunds', '--json'], demo);
    expect(code).toBe(1);
    expect(() => JSON.parse(stdout)).not.toThrow();
    const env = JSON.parse(stdout) as { schemaVersion: string; summary: { findings: number; filesChanged: number }; findings: unknown[] };
    expect(env.schemaVersion).toBe('1.0');
    expect(env.summary.filesChanged).toBeGreaterThanOrEqual(6);
    expect(env.findings.length).toBeGreaterThan(10);
    expect(stdout).not.toContain('Quality gate');
    expect(stderr).toContain('Quality gate failed');
  }, 120_000);

  it('honours --fail-on none in CI', async () => {
    const { code, stdout } = await run(['review', 'main..feature/partial-refunds', '--json', '--fail-on', 'none'], demo);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).summary.findings).toBeGreaterThan(0);
  }, 120_000);

  it('writes SARIF that passes structural validation', async () => {
    const out = join(demo, 'artifacts', 'diffwise.sarif');
    const { stdout, code } = await run(['review', 'main..feature/partial-refunds', '--format', 'sarif', '--out', out, '--fail-on', 'none'], demo);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(out);
    const log = JSON.parse(await readFile(out, 'utf8')) as unknown;
    expect(validateSarif(log).issues).toEqual([]);
  }, 120_000);

  it('writes a standalone HTML report and prints its path', async () => {
    const out = join(demo, 'artifacts', 'report.html');
    const { stdout, code } = await run(['review', 'main..feature/partial-refunds', '--format', 'html', '--out', out, '--fail-on', 'none'], demo);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(out);
    const html = await readFile(out, 'utf8');
    expect(html).toContain('__DIFFWISE_STATIC__');
    expect(html.length).toBeGreaterThan(100_000);
  }, 120_000);

  it('reports an empty target without failing', async () => {
    const { code, stdout } = await run(['review', '--staged', '--json'], demo);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).status).toBe('empty');
  }, 60_000);
});

describe('cli: findings, show, history', () => {
  it('lists findings filtered by severity', async () => {
    const { stdout, code } = await run(['findings', '--severity', 'critical', '--json'], demo);
    expect(code).toBe(0);
    const payload = JSON.parse(stdout) as { findings: Array<{ severity: string }>; count: number };
    expect(payload.count).toBeGreaterThan(0);
    expect(payload.findings.every((f) => f.severity === 'critical')).toBe(true);
  });

  it('shows a finding with evidence and exits 4 for an unknown id', async () => {
    const list = JSON.parse((await run(['findings', '--json'], demo)).stdout) as { findings: Array<{ id: string }> };
    const id = list.findings[0]!.id;
    const { stdout, code } = await run(['show', id, '--json'], demo);
    expect(code).toBe(0);
    const payload = JSON.parse(stdout) as { finding: { id: string; evidence: unknown[] } };
    expect(payload.finding.id).toBe(id);
    expect(payload.finding.evidence.length).toBeGreaterThan(0);

    const missing = await run(['show', 'DW-0000000000'], demo);
    expect(missing.code).toBe(4);
    expect(missing.stderr).toMatch(/was not found/);
  });

  it('lists review history as JSON', async () => {
    const { stdout, code } = await run(['history', '--json'], demo);
    expect(code).toBe(0);
    const payload = JSON.parse(stdout) as { reviews: Array<{ id: string; findings: number }> };
    expect(payload.reviews.length).toBeGreaterThan(0);
  });
});

describe('cli: verification and fixes', () => {
  it('exits 6 when no verification command is configured', async () => {
    const { stdout, code } = await run(['verify', '--json'], demo);
    expect(code).toBe(6);
    const payload = JSON.parse(stdout) as { ok: boolean; status: string };
    expect(payload.ok).toBe(false);
    expect(payload.status).toBe('not-run');
  });

  it('runs the configured verification command and records the real result', async () => {
    await run(['config', 'set', 'verification.command', 'node -e "process.exit(0)"'], demo);
    const { stdout, code } = await run(['verify', '--json'], demo);
    expect(code).toBe(0);
    const payload = JSON.parse(stdout) as { ok: boolean; execution: { status: string; exitCode: number; command: string } };
    expect(payload.ok).toBe(true);
    expect(payload.execution.status).toBe('passed');
    expect(payload.execution.exitCode).toBe(0);
  }, 60_000);

  it('does not apply a patch without explicit approval and writes nothing', async () => {
    const list = JSON.parse((await run(['findings', '--search', 'signature changed: calculateFee', '--json'], demo)).stdout) as {
      findings: Array<{ id: string }>;
    };
    const id = list.findings[0]!.id;
    const patch = join(demo, 'fix.patch');
    await mkdir(join(demo, 'artifacts'), { recursive: true });
    await writeFile(patch, await readFile(join(repoRoot, 'demo/fixes/calculate-fee-callers.patch'), 'utf8'), 'utf8');
    const before = await readFile(join(demo, 'tests/paymentService.test.ts'), 'utf8');

    const preview = await run(['fix', id, '--patch-file', patch, '--preview', '--json'], demo);
    expect(preview.code).toBe(0);
    const previewPayload = JSON.parse(preview.stdout) as { ok: boolean; preview: { applies: boolean; files: string[] } };
    expect(previewPayload.ok).toBe(true);
    expect(previewPayload.preview.applies).toBe(true);

    const unapproved = await run(['fix', id, '--apply'], demo);
    expect(unapproved.code).toBe(8);
    expect(unapproved.stderr).toMatch(/Not applied/);
    expect(unapproved.stdout).toContain('Patch preview');
    expect(await readFile(join(demo, 'tests/paymentService.test.ts'), 'utf8')).toBe(before);
  }, 120_000);
});

describe('cli: platform introspection', () => {
  it('lists rules including the builtin catalogue', async () => {
    const { stdout, code } = await run(['rules', 'list', '--json'], demo);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { count: number; rules: Array<{ id: string; pack: string }> };
    expect(parsed.count).toBeGreaterThan(20);
    expect(parsed.rules.some((r) => r.id === 'security.sql-injection' && r.pack === 'builtin')).toBe(true);
  });

  it('explains one rule with its evidence policy and provenance', async () => {
    const { stdout, code } = await run(['rules', 'explain', 'security.sql-injection', '--json'], demo);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { rule: { id: string; requiresEvidence: boolean; source: string } };
    expect(parsed.rule.requiresEvidence).toBe(true);
    expect(parsed.rule.source).toBe('builtin');
  });

  it('exits 4 for an unknown rule', async () => {
    const { code, stderr } = await run(['rules', 'explain', 'nope.nope'], demo);
    expect(code).toBe(4);
    expect(stderr).toContain('nope.nope');
  });

  it('validates a rule pack directory and reports each issue with its file', async () => {
    const dir = join(demo, 'rules-fixture');
    await mkdir(join(dir, 'rules'), { recursive: true });
    await writeFile(join(dir, 'pack.yaml'), 'id: fixture\nversion: 1.0.0\n', 'utf8');
    await writeFile(join(dir, 'rules', 'ok.yaml'), [
      'id: fixture.ok', 'name: OK rule', 'version: 1.0.0', 'category: security', 'severity: high',
      'description: d', 'recommendation: r', 'detection: {type: pattern, pattern: TODO}',
    ].join('\n'), 'utf8');
    await writeFile(join(dir, 'rules', 'bad.yaml'), [
      'id: fixture.bad', 'name: Bad rule', 'version: 1.0.0', 'category: security',
      'description: d', 'recommendation: r', 'detection: {type: pattern, pattern: "(a+)+"}',
    ].join('\n'), 'utf8');
    const { code, stdout, stderr } = await run(['rules', 'validate', 'rules-fixture', '--json'], demo);
    expect(code).toBe(2);
    const parsed = JSON.parse(stdout) as { errors: number; packs: Array<{ rules: string[] }> };
    expect(parsed.errors).toBeGreaterThan(0);
    expect(parsed.packs[0]?.rules).toContain('fixture.ok');
    expect(parsed.packs[0]?.rules).not.toContain('fixture.bad');
    expect(stderr).toBe('');
  });

  it('explains the reviewer plan for a reviewed change', async () => {
    await run(['review', 'main..feature/partial-refunds', '--no-ai', '--json'], demo);
    const { stdout, code } = await run(['reviewers', 'plan', '--json'], demo);
    expect(code).toBe(0);
    const plan = JSON.parse(stdout) as { reviewers: string[]; decisions: Array<{ reviewerId: string; selected: boolean; reasons: string[] }> };
    expect(plan.reviewers).toContain('correctness');
    expect(plan.reviewers.length).toBeLessThanOrEqual(3);
    expect(plan.decisions.every((d) => d.reasons.length > 0)).toBe(true);
  });

  it('prints the effective policy with provenance and honest defaults', async () => {
    const { stdout, code } = await run(['policy', 'effective', '--json'], demo);
    expect(code).toBe(0);
    const snapshot = JSON.parse(stdout) as { policy: { verification: { requireApproval: boolean } }; provenance: Record<string, string> };
    expect(snapshot.policy.verification.requireApproval).toBe(true);
    expect(snapshot.provenance['reviewers.maxReviewers']).toBe('default');
  });
});

describe('cli: evaluation', () => {
  it('runs the labelled corpus and reports measured metrics with a scope statement', async () => {
    const { stdout, code } = await run(['evaluate', '--dataset', join(repoRoot, 'evals'), '--json'], demo);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as {
      metrics: { cases: number; expected: number; found: number; precision?: number; recall?: number; forbiddenViolations: number };
      scope: string;
      results: Array<{ caseId: string; matched: number }>;
    };
    expect(report.metrics.cases).toBeGreaterThanOrEqual(8);
    expect(report.metrics.expected).toBeGreaterThanOrEqual(13);
    expect(report.metrics.found).toBeGreaterThan(0);
    expect(report.metrics.forbiddenViolations).toBe(0);
    expect(report.scope).toContain('Recall is bounded by what the dataset labels');
    expect(report.results.every((r) => r.caseId.length > 0)).toBe(true);
  }, 180_000);
});
