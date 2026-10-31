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
  child?.kill();
  if (demo) await rm(demo, { recursive: true, force: true });
});

describe('DiffWise MCP server', () => {
  it('exposes the versioned tool surface', async () => {
    const response = await request('tools/list') as { result?: { tools?: Array<{ name: string }> } };
    const names = (response.result?.tools ?? []).map((t) => t.name);
    for (const expected of [
      'record_task_intent', 'record_plan', 'record_decision', 'record_alternative', 'record_constraint',
      'record_activity', 'record_verification', 'record_unresolved_issue',
      'get_change_context', 'get_review_context', 'get_related_decisions', 'search_project_knowledge',
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
