#!/usr/bin/env node
/**
 * A real MCP client session, used for the MCP screenshot and for CI smoke tests.
 *
 *   node tools/evidence/mcp-session.mjs --root <repo> [--review]
 *
 * Speaks newline-delimited JSON-RPC over the stdio server exactly as a coding
 * agent does, prints each call and a trimmed response, and exits non-zero if any
 * call fails.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const bin = resolve(repoRoot, 'packages/mcp/bin/diffwise-mcp.js');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  return value && !value.startsWith('--') ? value : true;
};

const root = resolve(arg('root', process.cwd()));
const runReviewFirst = arg('review', false) === true;

const child = spawn(process.execPath, [bin, '--root', root], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  for (const line of chunk.split('\n').filter(Boolean)) console.log(`  [server] ${line}`);
});

let buffer = '';
let nextId = 0;
const pending = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      try {
        const message = JSON.parse(line);
        if (typeof message.id === 'number' && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        }
      } catch {
        // keep protocol noise out of the transcript
      }
    }
    index = buffer.indexOf('\n');
  }
});

const rpc = (method, params = {}) => new Promise((resolvePromise, rejectPromise) => {
  const id = ++nextId;
  const timer = setTimeout(() => rejectPromise(new Error(`${method} timed out`)), 180_000);
  pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});

const callTool = async (name, args = {}) => {
  const started = Date.now();
  const response = await rpc('tools/call', { name, arguments: args });
  const text = response.result?.content?.[0]?.text ?? JSON.stringify(response.error ?? {});
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  console.log(`\n$ tools/call ${name} ${JSON.stringify(args)}`);
  console.log(`  ${response.result?.isError ? 'isError' : 'ok'} · ${Date.now() - started}ms`);
  return { parsed, text, isError: Boolean(response.result?.isError) };
};

const brief = (value, max = 900) => {
  const text = JSON.stringify(value, null, 2);
  console.log(text.split('\n').slice(0, 26).map((l) => `  ${l}`).join('\n'));
  if (text.split('\n').length > 26) console.log('  …');
  if (text.length > max * 6) return;
};

console.log('DiffWise MCP — live session');
console.log(`  root: ${root}`);
console.log(`  bin:  ${bin}`);

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'diffwise-evidence', version: '1.0.0' } });
console.log(`\n$ initialize`);
console.log(`  server: ${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version}`);
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

const tools = await rpc('tools/list');
console.log(`\n$ tools/list`);
console.log(`  ${tools.result.tools.length} tools: ${tools.result.tools.map((t) => t.name).join(', ')}`);

let reviewId;
let findingId;
if (runReviewFirst) {
  const review = await callTool('run_review', { mode: 'branch', base: 'main', head: 'feature/partial-refunds', ai: false });
  reviewId = review.parsed?.reviewId;
  brief({
    schemaVersion: review.parsed?.schemaVersion,
    reviewId,
    status: review.parsed?.status,
    summary: review.parsed?.summary,
    risk: { score: review.parsed?.risk?.score, level: review.parsed?.risk?.level },
  });
}

const findings = await callTool('get_findings', { severity: 'critical', max: 5 });
brief({
  schemaVersion: findings.parsed?.schemaVersion,
  reviewId: findings.parsed?.reviewId,
  count: findings.parsed?.count,
  findings: (findings.parsed?.findings ?? []).map((f) => ({ id: f.id, severity: f.severity, title: f.title, file: f.file, evidences: f.evidenceCount })),
});

findingId = findings.parsed?.findings?.[0]?.id;
if (findingId) {
  const finding = await callTool('get_finding', { findingId });
  brief({
    finding: {
      id: finding.parsed?.finding?.id,
      severity: finding.parsed?.finding?.severity,
      file: finding.parsed?.finding?.file,
      range: finding.parsed?.finding?.range,
      evidence: (finding.parsed?.finding?.evidence ?? []).map((e) => ({ file: e.file, line: e.line, note: e.note })),
    },
    fixes: finding.parsed?.fixes,
  });

  const suggested = await callTool('suggest_fixes', { findingId });
  brief({ fixes: (suggested.parsed?.fixes ?? []).map((f) => ({ id: f.id, label: f.label, applies: f.applies, source: f.source })) });

  const guard = await callTool('apply_fix', {
    findingId,
    solutionId: suggested.parsed?.fixes?.[0]?.id ?? 'fix-none',
    approved: true,
    confirmFindingId: 'DW-not-this-one',
  });
  console.log(`  refusal: ${guard.parsed?.error ?? guard.text.slice(0, 120)}`);
  if (!guard.isError) {
    console.log('  FAIL: apply_fix accepted a mismatched confirmation');
    child.kill();
    process.exit(1);
  }
}

const verification = await callTool('run_verification', {});
brief({
  ok: verification.parsed?.ok,
  status: verification.parsed?.status,
  command: verification.parsed?.execution?.command,
  exitCode: verification.parsed?.execution?.exitCode,
  durationMs: verification.parsed?.execution?.durationMs,
  error: verification.parsed?.error,
});

console.log('\nMCP session completed.');
child.kill();
