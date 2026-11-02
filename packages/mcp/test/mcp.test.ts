import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * MCP integration test over stdio.
 *
 * The server is started exactly as a coding agent would start it (bin script,
 * --root, newline-delimited JSON-RPC) and exercised through real tool calls.
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
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 20_000);
    pending.set(id, (value) => { clearTimeout(timer); resolvePromise(value as Record<string, unknown>); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function notify(method: string, params: Record<string, unknown> = {}): void {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

async function callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const response = await request('tools/call', { name, arguments: args }) as {
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
    error?: { message: string };
  };
  if (response.error) throw new Error(response.error.message);
  return { text: response.result?.content?.[0]?.text ?? '', isError: Boolean(response.result?.isError) };
}

beforeAll(async () => {
  demo = await mkdtemp(join(tmpdir(), 'diffwise-mcp-'));
  const { execFileSync } = await import('node:child_process');
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
          // stderr-style noise is not part of the protocol
        }
      }
      index = buffer.indexOf('\n');
    }
  });
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'diffwise-test', version: '1.0.0' },
  }) as { result?: { serverInfo?: { name?: string } } };
  expect(init.result?.serverInfo?.name).toBe('diffwise-mcp');
  notify('notifications/initialized');
}, 120_000);

afterAll(async () => {
  if (child) {
    const exited = new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise()));
    child.kill();
    // Wait for the server process to release its store before deleting the
    // fixture: SQLite holds the database file open, and Windows refuses rmdir.
    await Promise.race([exited, new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 3_000))]);
  }
  if (demo) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { await rm(demo, { recursive: true, force: true }); break; }
      catch (err) {
        if (attempt === 9) throw err;
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 150));
      }
    }
  }
});

describe('DiffWise MCP server', () => {
  it('exposes the versioned tool surface', async () => {
    const response = await request('tools/list') as { result?: { tools?: Array<{ name: string }> } };
    const names = (response.result?.tools ?? []).map((t) => t.name);
    for (const expected of [
      'record_task_intent', 'record_plan', 'record_decision', 'record_alternative', 'record_constraint',
      'record_activity', 'record_verification', 'record_unresolved_issue',
      'get_change_context', 'get_review_context', 'get_related_decisions', 'search_project_knowledge',
      'run_review', 'get_findings', 'get_finding', 'suggest_fixes', 'apply_fix', 'run_verification', 'compare_reviews',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('records structured intent and reads it back through the change context', async () => {
    await appendFile(join(demo, 'src/payments/PaymentService.ts'), '\n// working-tree change for the MCP test\n', 'utf8');
    const recorded = await callTool('record_task_intent', {
      title: 'Add partial refunds',
      detail: 'Support partial refunds without breaking settlement totals.',
      files: ['src/payments/PaymentService.ts'],
      actor: 'vitest',
    });
    expect(recorded.isError).toBe(false);
    expect(JSON.parse(recorded.text).ok).toBe(true);

    const context = await callTool('get_change_context', { includeContent: false });
    expect(context.isError).toBe(false);
    const parsed = JSON.parse(context.text) as { change: { files: Array<{ path: string }> }; agent: { intents: Array<{ title: string }> } };
    expect(parsed.change.files.length).toBeGreaterThan(0);
    expect(parsed.agent.intents.some((i) => i.title === 'Add partial refunds')).toBe(true);
  });

  it('returns a clear error when no review has been persisted', async () => {
    const result = await callTool('get_review_context', {});
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/No review/);
  });

  it('searches repository documentation for evidence', async () => {
    const result = await callTool('search_project_knowledge', { query: 'refund', limit: 5 });
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.text) as { count: number; matches: Array<{ path?: string; text: string }> };
    expect(parsed.count).toBeGreaterThan(0);
    expect(parsed.matches.some((m) => /refund/i.test(m.text))).toBe(true);
  });

  it('finds recorded decisions related to a file', async () => {
    await callTool('record_decision', {
      title: 'Settlement writes stay inside one transaction',
      detail: 'Wrapped the ledger writes in withTransaction to prevent partial settlement.',
      files: ['src/payments/SettlementService.ts'],
    });
    const result = await callTool('get_related_decisions', { files: ['src/payments/SettlementService.ts'] });
    const parsed = JSON.parse(result.text) as { events: Array<{ title: string; type: string }> };
    expect(parsed.events.some((e) => e.type === 'decision' && /transaction/i.test(e.title))).toBe(true);
  });
});

/**
 * Agent workflow: review → findings → evidence → fix options → guarded apply.
 * These calls go through the same application services as the CLI.
 */
describe('DiffWise MCP agent workflow', () => {
  let findingId: string;

  it('runs a review over the committed branch and returns the versioned envelope', async () => {
    const result = await callTool('run_review', { mode: 'branch', base: 'main', head: 'feature/partial-refunds', ai: false });
    expect(result.isError).toBe(false);
    const envelope = JSON.parse(result.text) as {
      schemaVersion: string; status: string; reviewId: string;
      summary: { findings: number }; findings: Array<{ id: string; severity: string }>;
    };
    expect(envelope.schemaVersion).toBe('1.0');
    expect(envelope.status).toBe('completed');
    expect(['completed', 'partial']).toContain(envelope.status);
    expect(envelope.summary.findings).toBeGreaterThan(5);
    findingId = envelope.findings[0]!.id;
  }, 120_000);

  it('returns findings with stable ids and filters by severity', async () => {
    const all = JSON.parse((await callTool('get_findings', {})).text) as { findings: Array<{ id: string }> };
    expect(all.findings.length).toBeGreaterThan(5);
    const critical = JSON.parse((await callTool('get_findings', { severity: 'critical' })).text) as { findings: Array<{ severity: string }> };
    expect(critical.findings.every((f) => f.severity === 'critical')).toBe(true);
  });

  it('returns one finding with its evidence and fix options', async () => {
    const finding = JSON.parse((await callTool('get_finding', { findingId })).text) as {
      finding: { id: string; evidence: Array<{ note: string; file?: string }> };
      fixes: Array<{ id: string; applies: boolean | null }>;
    };
    expect(finding.finding.id).toBe(findingId);
    expect(finding.finding.evidence.length).toBeGreaterThan(0);
    const suggested = JSON.parse((await callTool('suggest_fixes', { findingId })).text) as { fixes: Array<{ id: string }> };
    expect(Array.isArray(suggested.fixes)).toBe(true);
  });

  it('refuses apply_fix unless the confirmation matches the finding', async () => {
    const suggested = JSON.parse((await callTool('suggest_fixes', { findingId })).text) as { fixes: Array<{ id: string }> };
    const result = await callTool('apply_fix', {
      findingId,
      solutionId: suggested.fixes[0]?.id ?? 'fix-none',
      approved: true,
      confirmFindingId: 'DW-something-else',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/confirmFindingId must equal findingId/);
  });

  it('reports verification as not-run instead of faking a pass', async () => {
    const result = await callTool('run_verification', {});
    const body = JSON.parse(result.text) as { ok: boolean; status: string } | { ok: false; error: string };
    expect('ok' in body ? body.ok : false).toBe(false);
    expect(result.text).toMatch(/NO_VERIFICATION_COMMAND|not-run/);
  });

  it('compares two reviews', async () => {
    const result = await callTool('compare_reviews', { left: 'latest', right: 'latest' });
    const body = JSON.parse(result.text) as { delta: { findings: { delta: number } } };
    expect(body.delta.findings.delta).toBe(0);
  });
});
