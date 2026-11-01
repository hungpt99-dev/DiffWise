#!/usr/bin/env node
/**
 * Estimator calibration.
 *
 * Sends a fixed set of texts to a configured provider and compares
 * `estimateTokens()` with the provider-reported `prompt_tokens`. The result is
 * stored in `docs/evidence/token-calibration.json` and quoted in
 * `docs/TOKEN_EFFICIENCY_AUDIT.md`.
 *
 * This is the only honest way to claim the estimator is accurate: measure it.
 * Requires a provider (OPENCODE_GO_API_KEY or DIFFWISE_API_KEY) — it sends
 * synthetic text only, never repository content.
 *
 * Usage: node tools/bench/token-calibration.mjs
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTokens } from '../../packages/core/dist/index.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '../..');

const baseUrl = process.env.DIFFWISE_BASE_URL ?? 'https://opencode.ai/zen/go/v1';
const model = process.env.DIFFWISE_MODEL ?? 'deepseek-v4.1-flash';
const apiKey = process.env.OPENCODE_GO_API_KEY ?? process.env.DIFFWISE_API_KEY;

const SAMPLES = {
  prose: 'The reviewer reads each changed hunk and reports only defects it can support with a quotation from the repository. It never invents a line number, a test result or a benchmark.',
  code: `export async function reconcile(accountId: string, until: Date): Promise<LedgerRow[]> {
  const rows = await db.query("SELECT * FROM ledger WHERE account_id = $1 AND created_at <= $2", [accountId, until]);
  return rows.map((row) => ({ ...row, amountCents: row.amount_cents ?? 0 }));
}`,
  json: JSON.stringify({ findings: [{ id: 'DW-1', severity: 'high', file: 'src/pay.ts', startLine: 42, evidence: [{ quote: 'const sql = "SELECT * FROM t WHERE id = " + id;' }] }] }, null, 2),
  mixed: `Italic **markdown** with \`inline code\`, a table row | a | b |, and a URL https://example.com/a?b=c — plus emoji-free punctuation: ();:{}[]<>.`,
  vietnamese: 'Đánh giá thay đổi mã nguồn: hàm này ghi đè số dư mà không khoá bản ghi, nên hai yêu cầu đồng thời có thể làm mất một lần cập nhật.',
  minified: 'function a(b,c){return b.map(d=>d*c).filter(e=>e>0).reduce((f,g)=>f+g,0)}const h=a([1,2,3],4);console.log(h);',
};

async function measure(text) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      // Required by OpenAI-compatible gateways that route per session.
      ...(process.env.DIFFWISE_EXTRA_HEADERS ? JSON.parse(process.env.DIFFWISE_EXTRA_HEADERS) : { 'x-opencode-session': 'diffwise-token-calibration' }),
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: 'Reply with the single character: x' }, { role: 'user', content: text }],
      max_tokens: 1,
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return body.usage?.prompt_tokens ?? 0;
}

async function main() {
  if (!apiKey) {
    console.error('No API key: set OPENCODE_GO_API_KEY or DIFFWISE_API_KEY.');
    process.exit(2);
  }
  const rows = [];
  for (const [name, text] of Object.entries(SAMPLES)) {
    const actual = await measure(text);
    const estimate = estimateTokens(text, model) + estimateTokens('Reply with the single character: x', model) + 4 + 3;
    const charsOver4 = Math.ceil((text.length + 38) / 4);
    rows.push({
      sample: name,
      chars: text.length,
      actual,
      estimate,
      charsOver4,
      estimateError: (estimate - actual) / actual,
      charsOver4Error: (charsOver4 - actual) / actual,
    });
    await new Promise((r) => setTimeout(r, 250));
  }
  const mean = (key) => rows.reduce((s, r) => s + Math.abs(r[key]), 0) / rows.length;
  const summary = {
    generatedAt: new Date().toISOString(),
    provider: baseUrl,
    model,
    samples: rows.length,
    estimateMape: mean('estimateError'),
    charsOver4Mape: mean('charsOver4Error'),
    estimateBias: rows.reduce((s, r) => s + r.estimateError, 0) / rows.length,
    rows,
  };
  const out = join(root, 'docs/evidence/token-calibration.json');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log('| sample | chars | actual | estimate | chars/4 | est. error | chars/4 error |');
  console.log('|---|---:|---:|---:|---:|---:|---:|');
  for (const r of rows) {
    console.log(`| ${r.sample} | ${r.chars} | ${r.actual} | ${r.estimate} | ${r.charsOver4} | ${(r.estimateError * 100).toFixed(0)}% | ${(r.charsOver4Error * 100).toFixed(0)}% |`);
  }
  console.log(`\nMAPE: estimator ${(summary.estimateMape * 100).toFixed(1)}% vs chars/4 ${(summary.charsOver4Mape * 100).toFixed(1)}%; bias ${(summary.estimateBias * 100).toFixed(1)}%`);
  console.log(`Written to ${out}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
