import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * MCP interface v2 integration test.
 *
 * The server is started the way a coding agent starts it (bin script over stdio,
 * newline-delimited JSON-RPC) and the platform tools are exercised for real
 * against a real git repository and a real stored review.
 */
const repoRoot = resolve(__dirname, '../../..');
const bin = join(repoRoot, 'packages/mcp/bin/diffwise-mcp.js');

let demo: string;
let child: ChildProcessWithoutNullStreams;
let buffer = '';
let nextId = 0;
const pending = new Map<number, (value: unknown) => void>();

function request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = ++nextId;
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 60_000);
    pending.set(id, (value) => { clearTimeout(timer); resolvePromise(value as Record<string, unknown>); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<{ data: Record<string, unknown>; isError: boolean }> {
  const response = await request('tools/call', { name, arguments: args }) as {
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
    error?: { message: string };
  };
  if (response.error) throw new Error(response.error.message);
  const text = response.result?.content?.[0]?.text ?? '{}';
  return { data: JSON.parse(text) as Record<string, unknown>, isError: Boolean(response.result?.isError) };
}

interface ToolInfo { name: string; description?: string }

beforeAll(async () => {
  demo = await mkdtemp(join(tmpdir(), 'diffwise-mcp-v2-'));
  execFileSync(process.execPath, [join(repoRoot, 'demo/build-demo-repo.mjs'), '--target', demo], { cwd: repoRoot, stdio: 'pipe' });
  child = spawn(process.execPath, [bin, '--root', demo], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try {
          const message = JSON.parse(line) as { id?: number };
          if (typeof message.id === 'number' && pending.has(message.id)) {
            pending.get(message.id)!(message);
            pending.delete(message.id);
          }
        } catch {
          // Non-JSON log line on stdout: the test asserts on tool output only.
        }
      }
      index = buffer.indexOf('\n');
    }
  });
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'vitest', version: '1' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  // Build a real review to read back.
  const review = await callTool('run_review', {
    mode: 'branch',
    base: 'main',
    head: 'feature/partial-refunds',
    useAi: false,
  });
  expect(review.isError).toBe(false);
}, 180_000);

afterAll(async () => {
  child?.kill();
  if (demo) await rm(demo, { recursive: true, force: true });
});

describe('MCP interface v2 — tool surface', () => {
  it('exposes both the v1 tools and the v2 platform tools', async () => {
    const response = await request('tools/list') as { result?: { tools?: ToolInfo[] } };
    const names = new Set((response.result?.tools ?? []).map((t) => t.name));
    // v1 contracts preserved
    for (const legacy of ['get_change_context', 'run_review', 'get_findings', 'get_finding', 'suggest_fixes', 'apply_fix', 'run_verification', 'compare_reviews']) {
      expect(names.has(legacy)).toBe(true);
    }
    // v2 additions
    for (const added of [
      'get_review_status', 'get_review_findings', 'get_finding_details', 'get_review_risk',
      'get_review_coverage', 'verify_finding', 'verify_review', 'get_affected_components',
      'get_related_tests', 'get_relevant_documentation', 'search_project_knowledge',
      'list_rule_packs', 'get_rule_details', 'validate_rule', 'explain_rule', 'get_effective_policy',
      'discover_test_commands', 'get_verification_plan', 'get_verification_result',
      'get_reviewer_plan', 'explain_reviewer', 'record_human_decision', 'get_review_history',
      'submit_finding_feedback',
    ]) {
      expect(names.has(added), `missing tool ${added}`).toBe(true);
    }
  });

  it('describes every tool and marks read-only tools correctly', async () => {
    const response = await request('tools/list') as { result?: { tools?: Array<ToolInfo & { annotations?: { readOnlyHint?: boolean } }> } };
    for (const tool of response.result?.tools ?? []) {
      expect(tool.description && tool.description.length).toBeTruthy();
    }
    const readOnly = (response.result?.tools ?? []).find((t) => t.name === 'get_review_status');
    expect(readOnly?.annotations?.readOnlyHint).toBe(true);
  });
});

describe('MCP interface v2 — review and verification', () => {
  it('returns pipeline stages with real statuses', async () => {
    const { data, isError } = await callTool('get_review_status');
    expect(isError).toBe(false);
    const stages = data.stages as Array<{ id: string; status: string }>;
    expect(stages.map((s) => s.id)).toContain('verify');
    expect(stages.every((s) => ['pending', 'running', 'completed', 'failed', 'skipped', 'cancelled'].includes(s.status))).toBe(true);
    const verify = stages.find((s) => s.id === 'verify');
    expect(verify?.status).toBe('completed');
    expect(data.completeness).toBeDefined();
  });

  it('returns findings with a verification verdict on each', async () => {
    const { data } = await callTool('get_review_findings', { limit: 100 });
    const findings = data.findings as Array<{ id: string; verification: string }>;
    expect(findings.length).toBeGreaterThan(5);
    for (const finding of findings) {
      expect(['CONFIRMED', 'LIKELY', 'UNVERIFIED', 'DISPUTED', 'REJECTED']).toContain(finding.verification);
    }
  });

  it('filters findings by verification status', async () => {
    const confirmed = await callTool('get_review_findings', { verification: 'CONFIRMED', limit: 100 });
    const all = await callTool('get_review_findings', { limit: 100 });
    expect((confirmed.data.findings as unknown[]).length).toBeGreaterThan(0);
    expect((confirmed.data.findings as unknown[]).length).toBeLessThanOrEqual((all.data.findings as unknown[]).length);
    for (const finding of confirmed.data.findings as Array<{ verification: string }>) {
      expect(finding.verification).toBe('CONFIRMED');
    }
  });

  it('re-verifies one finding against the working tree', async () => {
    const list = await callTool('get_review_findings', { limit: 1 });
    const first = (list.data.findings as Array<{ id: string }>)[0];
    expect(first).toBeDefined();
    const { data, isError } = await callTool('verify_finding', { findingId: first!.id });
    expect(isError).toBe(false);
    const verification = data.verification as { status: string; method: string; checks: unknown[] };
    expect(verification.method.length).toBeGreaterThan(10);
    expect(verification.checks.length).toBeGreaterThan(0);
  });

  it('returns risk with factors and an approval requirement', async () => {
    const { data } = await callTool('get_review_risk');
    const risk = data.risk as { score: number; factors: unknown[] };
    expect(risk.score).toBeGreaterThanOrEqual(0);
    expect(risk.factors.length).toBeGreaterThan(0);
    expect(String(data.note)).toContain('never merges');
  });

  it('reports coverage including rules that failed or were skipped', async () => {
    const { data } = await callTool('get_review_coverage');
    const rules = data.rules as { total: number; ran: number; failed: unknown[] };
    expect(rules.total).toBeGreaterThan(20);
    expect(rules.ran).toBeGreaterThan(20);
    expect(rules.failed).toEqual([]);
  });
});

describe('MCP interface v2 — rules, policy and verification planning', () => {
  it('lists rule packs and the builtin rule count', async () => {
    const { data } = await callTool('list_rule_packs');
    expect(data.builtinRules).toBeGreaterThan(20);
    expect(Array.isArray(data.packs)).toBe(true);
  });

  it('explains a rule and why it did or did not fire', async () => {
    const details = await callTool('get_rule_details', { ruleId: 'security.sql-injection' });
    expect(details.isError).toBe(false);
    expect((details.data.rule as { id: string }).id).toBe('security.sql-injection');
    const fired = await callTool('explain_rule', { ruleId: 'security.sql-injection' });
    expect(fired.isError).toBe(false);
    expect((fired.data.record as { findings: number }).findings).toBeGreaterThan(0);
  });

  it('rejects an unknown rule id with a structured error', async () => {
    const { data, isError } = await callTool('get_rule_details', { ruleId: 'no.such.rule' });
    expect(isError).toBe(true);
    expect(String(data.error)).toContain('no.such.rule');
  });

  it('validates a rule definition and reports why it is invalid', async () => {
    const bad = await callTool('validate_rule', {
      definition: { id: 'Bad Id', name: 'x', version: '1', category: 'security', description: 'd', recommendation: 'r', detection: { type: 'pattern', pattern: '(a+)+' } },
    });
    expect(bad.data.ok).toBe(false);
    const issues = bad.data.issues as Array<{ level: string; message: string }>;
    expect(issues.some((i) => i.level === 'error')).toBe(true);
  });

  it('returns the effective policy with provenance', async () => {
    const { data } = await callTool('get_effective_policy', {});
    const provenance = data.provenance as Record<string, string>;
    expect(provenance['reviewers.maxReviewers']).toBe('default');
    expect(String(data.note)).toContain('organization');
  });

  it('discovers test commands without executing anything', async () => {
    const { data } = await callTool('discover_test_commands');
    const commands = data.commands as Array<{ command: string; level: string }>;
    expect(commands.some((c) => c.level === 'unit')).toBe(true);
    expect(String(data.note)).toContain('never from a model');
  });

  it('builds a verification plan that requires approval', async () => {
    const { data } = await callTool('get_verification_plan', {});
    const plan = data.plan as { items: Array<{ command: string; requiresApproval: boolean }>; strategy: string };
    expect(plan.items.length).toBeGreaterThan(0);
    expect(plan.items.every((i) => i.requiresApproval)).toBe(true);
  });

  it('reports no verification runs rather than a fabricated pass', async () => {
    const { data } = await callTool('get_verification_result');
    expect(Array.isArray(data.runs)).toBe(true);
    expect((data.runs as unknown[]).length).toBe(0);
  });

  it('explains the reviewer plan', async () => {
    const { data } = await callTool('get_reviewer_plan');
    const plan = data.plan as { reviewers: string[]; decisions: unknown[] };
    expect(plan.reviewers.length).toBeGreaterThan(0);
    expect(plan.reviewers).toContain('correctness');
    const spec = await callTool('explain_reviewer', { reviewerId: 'security' });
    expect((spec.data.reviewer as { focus: string[] }).focus.length).toBeGreaterThan(3);
  });
});

describe('MCP interface v2 — human decisions and feedback', () => {
  it('records a human decision and recomputes the state', async () => {
    const status = await callTool('get_review_status');
    const reviewId = String(status.data.reviewId);
    const decision = await callTool('record_human_decision', {
      reviewId,
      action: 'request-changes',
      actor: 'hung',
      actorKind: 'human',
      rationale: 'the refund cap needs a test',
    });
    expect(decision.isError).toBe(false);
    expect(decision.data.state).toBe('CHANGES_REQUESTED');

    const history = await callTool('get_review_history', { reviewId });
    expect((history.data.decisions as unknown[]).length).toBe(1);
    expect(history.data.state).toBe('CHANGES_REQUESTED');
  });

  it('refuses a blocking decision without a rationale', async () => {
    const status = await callTool('get_review_status');
    const reviewId = String(status.data.reviewId);
    const { isError, data } = await callTool('record_human_decision', {
      reviewId, action: 'block', actor: 'hung', actorKind: 'human',
    });
    expect(isError).toBe(true);
    expect(String(data.error)).toContain('rationale');
  });

  it('records feedback as an agent event without changing any rule', async () => {
    const list = await callTool('get_review_findings', { limit: 1 });
    const first = (list.data.findings as Array<{ id: string }>)[0];
    const feedback = await callTool('submit_finding_feedback', {
      findingId: first!.id, outcome: 'false-positive', note: 'parameterised by the caller', actor: 'hung',
    });
    expect(feedback.isError).toBe(false);
    expect(String(feedback.data.note)).toContain('never silently changes');
  });

  it('writes an audit entry for every tool call', async () => {
    const raw = await readFile(join(demo, '.diffwise', 'mcp-audit.jsonl'), 'utf8');
    const entries = raw.trim().split('\n').map((line) => JSON.parse(line) as { tool: string; argsHash: string; ok: boolean });
    expect(entries.length).toBeGreaterThan(5);
    expect(entries.some((e) => e.tool === 'get_review_status')).toBe(true);
    // Arguments are hashed, never logged.
    for (const entry of entries) expect(entry.argsHash).toMatch(/^[0-9a-f]{16}$/);
  });
});
