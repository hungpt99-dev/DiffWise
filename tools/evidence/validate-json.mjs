#!/usr/bin/env node
/**
 * Validate a DiffWise JSON envelope produced by the real CLI.
 *
 *   node tools/evidence/validate-json.mjs <file>
 *
 * Prints the assertions it checked so a screenshot shows validation, not a
 * pretty-printed blob. Exits non-zero when an assertion fails.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const core = require(resolve(here, '../../packages/core/dist/index.js'));

const file = process.argv[2];
if (!file) {
  console.error('usage: validate-json.mjs <envelope.json>');
  process.exit(2);
}
const raw = await readFile(file, 'utf8');
let payload;
try {
  payload = JSON.parse(raw);
} catch (err) {
  console.error(`invalid JSON: ${err.message}`);
  process.exit(1);
}

const checks = [];
const check = (label, ok, detail = '') => checks.push({ label, ok: Boolean(ok), detail });

check('parses as JSON', true, `${raw.length} bytes`);
check('schemaVersion is "1.0"', payload.schemaVersion === '1.0', String(payload.schemaVersion));
check('reviewId present', typeof payload.reviewId === 'string' && payload.reviewId.length > 0, payload.reviewId ?? '');
check('status is completed|partial|failed', ['completed', 'partial', 'failed'].includes(payload.status), payload.status);
check('findings array', Array.isArray(payload.findings), `${payload.findings?.length ?? 0} findings`);
const sum = payload.summary ?? {};
check(
  'severity counts add up to the finding count',
  sum.critical + sum.high + sum.medium + sum.low + sum.info === sum.findings,
  `${sum.critical}/${sum.high}/${sum.medium}/${sum.low}/${sum.info} = ${sum.findings}`,
);
check('every finding has evidence and a location', (payload.findings ?? []).every((f) => f.evidence?.length > 0 && f.file && f.range?.start >= 1));
check('risk is explained by factors', payload.risk?.factors?.length > 0, `${payload.risk?.factors?.length ?? 0} factors, score ${payload.risk?.score}`);
check('architecture impact present', typeof payload.architectureImpact?.edgeCount === 'number', `${payload.architectureImpact?.edgeCount ?? 0} edges`);
check('test impact present', Array.isArray(payload.testImpact?.uncoveredChanges), `${payload.testImpact?.uncoveredChanges?.length ?? 0} uncovered changes`);
check('execution metadata present', Boolean(payload.execution?.tool && payload.execution?.toolVersion), `${payload.execution?.tool} ${payload.execution?.toolVersion}`);
check('no absolute paths in findings', (payload.findings ?? []).every((f) => !f.file.startsWith('/')));

console.log('DiffWise JSON contract — validation');
console.log(`file: ${file}`);
console.log('');
for (const c of checks) {
  console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.label}${c.detail ? `  (${c.detail})` : ''}`);
}
const failed = checks.filter((c) => !c.ok);
console.log('');
console.log(`  ${checks.length - failed.length}/${checks.length} assertions passed`);
if (failed.length) process.exit(1);
