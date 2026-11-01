#!/usr/bin/env node
/**
 * Validate a SARIF log written by `diffwise review --format sarif`.
 *
 *   node tools/evidence/validate-sarif.mjs <file.sarif>
 *
 * Uses the same structural validator the CLI and tests use, plus SARIF-specific
 * assertions (rule index consistency, artifact URIs, line regions).
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
  console.error('usage: validate-sarif.mjs <file.sarif>');
  process.exit(2);
}
const log = JSON.parse(await readFile(file, 'utf8'));
const structural = core.validateSarif(log);
const run = log.runs?.[0] ?? {};
const results = run.results ?? [];
const rules = run.tool?.driver?.rules ?? [];
const checks = [
  ['version is 2.1.0', log.version === '2.1.0', String(log.version)],
  ['$schema points at the SARIF 2.1.0 schema', String(log.$schema).includes('sarif-2.1.0'), String(log.$schema)],
  ['driver is DiffWise with a version', run.tool?.driver?.name === 'DiffWise' && Boolean(run.tool?.driver?.version), `${run.tool?.driver?.name} ${run.tool?.driver?.version}`],
  ['every result maps to a declared rule', results.every((r) => rules[r.ruleIndex]?.id === r.ruleId), `${results.length} results, ${rules.length} rules`],
  ['every result has a file region', results.every((r) => r.locations?.[0]?.physicalLocation?.artifactLocation?.uri && r.locations[0].physicalLocation.region.startLine >= 1)],
  ['every result carries a stable fingerprint', results.every((r) => r.partialFingerprints?.['diffwiseFindingId/v1'])],
  ['levels are SARIF levels', results.every((r) => ['error', 'warning', 'note', 'none'].includes(r.level)), [...new Set(results.map((r) => r.level))].join(',')],
  ['repository root is declared', Boolean(run.originalUriBaseIds?.['%SRCROOT%']?.uri), run.originalUriBaseIds?.['%SRCROOT%']?.uri ?? ''],
  ['no structural validator issues', structural.issues.length === 0, structural.issues.join('; ')],
];

console.log('DiffWise SARIF 2.1.0 — validation');
console.log(`file: ${file}`);
console.log('');
let failed = 0;
for (const [label, ok, detail] of checks) {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}
console.log('');
const byLevel = results.reduce((acc, r) => { acc[r.level] = (acc[r.level] ?? 0) + 1; return acc; }, {});
console.log(`  ${results.length} results across ${rules.length} rules · ${Object.entries(byLevel).map(([k, v]) => `${v} ${k}`).join(', ')}`);
process.exit(failed === 0 ? 0 : 1);
