import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Cross-interface integration test.
 *
 * The same repository and the same target are reviewed twice: once through the
 * CLI binary and once through the MCP server an agent would connect to. The
 * product claim is that these are the same review, so the findings, their
 * severities, the risk score and the verification verdicts must match exactly.
 *
 * A deliberate difference in configuration would be allowed to change results —
 * there is none here: both read the same `.diffwise/config.json` and both run
 * with `ai: false`.
 */
const exec = promisify(execFile);
const repoRoot = resolve(__dirname, '../../..');
const cliBin = resolve(repoRoot, 'packages/cli/bin/diffwise.js');
const mcpBin = resolve(repoRoot, 'packages/mcp/bin/diffwise-mcp.js');

let demo: string;
let child: ChildProcessWithoutNullStreams;
let buffer = '';
let nextId = 0;
const pending = new Map<number, (value: unknown) => void>();

function request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = ++nextId;
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 120_000);
    pending.set(id, (value) => { clearTimeout(timer); resolvePromise(value as Record<string, unknown>); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const response = await request('tools/call', { name, arguments: args }) as {
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
    error?: { message: string };
  };
  if (response.error) throw new Error(response.error.message);
  return JSON.parse(response.result?.content?.[0]?.text ?? '{}') as Record<string, unknown>;
}

/** Run the CLI and tolerate its exit code: the quality gate exiting 1 is a result. */
async function runCli(args: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await exec(process.execPath, [cliBin, ...args], {
      cwd: demo,
      env: { ...process.env, DIFFWISE_AI: 'off', NO_COLOR: '1' },
      maxBuffer: 30 * 1024 * 1024,
    });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    if (e.stdout) return { stdout: e.stdout, code: e.code ?? 1 };
    throw new Error(e.stderr ?? 'cli produced no output');
  }
}

interface FindingShape { id: string; severity: string; category: string; file: string; start: number; status: string }

function shapeOf(envelope: { findings?: Array<Record<string, unknown>> }): FindingShape[] {
  return (envelope.findings ?? []).map((f) => {
    const range = (f.range ?? {}) as { start?: number };
    const verification = (f.verification ?? {}) as { status?: string };
    return {
      id: String(f.id),
      severity: String(f.severity),
      category: String(f.category),
      file: String(f.file),
      start: range.start ?? 0,
      status: verification.status ?? 'UNVERIFIED',
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

beforeAll(async () => {
  demo = await mkdtemp(join(tmpdir(), 'diffwise-parity-'));
  await exec(process.execPath, [join(repoRoot, 'demo/build-demo-repo.mjs'), '--target', demo], { cwd: repoRoot });
  await exec(process.execPath, [cliBin, 'init'], { cwd: demo });

  child = spawn(process.execPath, [mcpBin], {
    cwd: demo,
    env: { ...process.env, DIFFWISE_MCP_ROOT: demo, DIFFWISE_AI: 'off', NO_COLOR: '1' },
  });
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
          const resolvePending = message.id !== undefined ? pending.get(message.id) : undefined;
          if (resolvePending && message.id !== undefined) {
            pending.delete(message.id);
            resolvePending(message);
          }
        } catch {
          // Notifications and partial lines are ignored.
        }
      }
      index = buffer.indexOf('\n');
    }
  });
  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'parity-test', version: '1.0.0' },
  });
}, 240_000);

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

describe('CLI and MCP produce the same review', () => {
  it('agrees on finding ids, severities, locations and verification verdicts', async () => {
    const cliRun = await runCli(['review', 'main..HEAD', '--format', 'json', '--no-ai']);
    expect([0, 1]).toContain(cliRun.code);
    const cliEnvelope = JSON.parse(cliRun.stdout) as Record<string, unknown> & { findings?: Array<Record<string, unknown>>; risk?: { score: number } };
    const mcpEnvelope = await callTool('run_review', { mode: 'branch', base: 'main', head: 'feature/partial-refunds', ai: false });

    const cli = shapeOf(cliEnvelope);
    const mcp = shapeOf(mcpEnvelope as { findings?: Array<Record<string, unknown>> });

    expect(cli.length).toBeGreaterThan(10);
    expect(mcp).toEqual(cli);
    expect((mcpEnvelope.risk as { score: number }).score).toBe(cliEnvelope.risk?.score);

    // Both record the same review identity contract and no AI usage.
    expect(mcpEnvelope.schemaVersion).toBe('1.0');
    expect(mcpEnvelope.summary).toMatchObject({ aiUsed: false });
    expect(mcpEnvelope.aiUsage).toBeUndefined();
  }, 240_000);

  it('returns a cost-limit signal instead of throwing when a ceiling is passed', async () => {
    const result = await callTool('run_review', { mode: 'branch', base: 'main', head: 'feature/partial-refunds', ai: false, maxCostUsd: 0.01 });
    expect(result.costLimit).toMatchObject({ maxCostUsd: 0.01, evaluated: false });
    expect(result.findings).toBeTruthy();
  }, 240_000);
});
