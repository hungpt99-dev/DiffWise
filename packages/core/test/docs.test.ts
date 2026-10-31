import { describe, expect, it } from 'vitest';
import { analyseDocumentation, extractReferences, loadDocuments, makeDocPatch } from '../src/analysis/docAnalysis';
import { analyseTests } from '../src/analysis/testAnalysis';
import { extractSymbols, diffSymbols } from '../src/analysis/symbols';
import { redactSecrets } from '../src/context/contextPack';
import { assessRisk } from '../src/analysis/risk';
import { makeUntracked } from '../src/git/diff';
import type { ChangedSymbol, FileChange, Finding } from '../src/types';

describe('documentation analysis', () => {
  it('extracts env vars, routes, files and symbol references from backticks', () => {
    const refs = extractReferences('Use `PAYMENT_KEY` and call `Service.settleBatch(id)` via `GET /api/health`.');
    expect(refs.some((r) => r.value === 'PAYMENT_KEY' && r.kind === 'env')).toBe(true);
    expect(refs.some((r) => r.value === 'settleBatch' && r.kind === 'symbol')).toBe(true);
    expect(refs.some((r) => r.kind === 'route')).toBe(true);
  });

  it('detects an OpenAPI path with no implementation', () => {
    const repoFiles = new Map([
      ['docs/openapi.yaml', 'openapi: 3.0.3\npaths:\n  /api/ghost:\n    get:\n      summary: Ghost\n'],
      ['src/routes.ts', "router.get('/api/real', handler);\n"],
    ]);
    const loaded = loadDocuments(repoFiles);
    const findings = analyseDocumentation({ docs: loaded.docs, docTexts: loaded.texts, repoFiles, changes: [], symbols: [] });
    expect(findings.map((f) => f.title)).toContain('OpenAPI path /api/ghost is not implemented');
  });

  it('detects a documented command that no package.json declares', () => {
    const repoFiles = new Map([
      ['README.md', 'Run `npm run test:integration` before merging.\n'],
      ['package.json', JSON.stringify({ scripts: { test: 'vitest run' } })],
    ]);
    const loaded = loadDocuments(repoFiles);
    const findings = analyseDocumentation({ docs: loaded.docs, docTexts: loaded.texts, repoFiles, changes: [], symbols: [] });
    expect(findings.some((f) => f.title.includes('test:integration'))).toBe(true);
  });

  it('produces a documentation patch for a renamed symbol', () => {
    const text = 'Call `SettlementService.settleBatch(batchId)` nightly.\n';
    const patch = makeDocPatch('docs/payments.md', text, 1, 'settleBatch', 'settleBatchAtomic');
    expect(patch.applies).toBe(true);
    expect(patch.diff).toContain('+Call `SettlementService.settleBatchAtomic(batchId)` nightly.');
  });
});

describe('symbol diffing', () => {
  it('marks added, modified and removed declarations', () => {
    const oldContent = 'export function keep(a: number) { return a; }\nexport function change(a: number) { return a; }\nexport function gone() { return 1; }\n';
    const newContent = 'export function keep(a: number) { return a; }\nexport function change(a: number, b: number) { return a + b; }\nexport function added() { return 2; }\n';
    const change: FileChange = makeUntracked('src/s.ts', newContent);
    // Only the second line is considered changed for this unit test.
    change.hunks[0]!.lines = change.hunks[0]!.lines.map((l) => l.newLine === 2 ? l : { ...l, kind: 'context' });
    const symbols = diffSymbols({ change, oldContent, newContent });
    const byName = new Map(symbols.map((s) => [s.name, s]));
    expect(byName.get('added')?.change).toBe('added');
    expect(byName.get('gone')?.change).toBe('removed');
    expect(byName.get('change')?.signatureChanged).toBe(true);
    expect(byName.get('keep')).toBeUndefined();
  });

  it('extracts class members with container names and private visibility', () => {
    const symbols = extractSymbols('a.ts', 'export class A {\n  run() {}\n  private secret() {}\n}\n');
    expect(symbols.find((s) => s.name === 'run')).toMatchObject({ container: 'A', exported: true });
    expect(symbols.find((s) => s.name === 'secret')?.exported).toBe(false);
  });
});

describe('test analysis', () => {
  it('maps a test file to its source file case-insensitively', () => {
    const repoFiles = new Map([
      ['src/payments/PaymentService.ts', 'export class PaymentService {}'],
      ['tests/paymentService.test.ts', "import { PaymentService } from '../src/payments/PaymentService';\nit('works', () => {});"],
    ]);
    const changes = [makeUntracked('src/payments/PaymentService.ts', 'export class PaymentService {}')];
    const result = analyseTests(repoFiles, changes, []);
    expect(result.files[0]!.targets).toContain('src/payments/PaymentService.ts');
    expect(result.uncoveredChanges).not.toContain('src/payments/PaymentService.ts');
  });
});

describe('secret redaction', () => {
  it('removes literal credentials but keeps structure', () => {
    const { text, redactions } = redactSecrets('apiKey = "sk_live_abcdef123456"\ntoken: "ghp_abcdefghijklmnop"');
    expect(redactions).toBeGreaterThan(0);
    expect(text).not.toContain('sk_live_abcdef123456');
    expect(text).toContain('apiKey =');
  });
});

describe('risk model', () => {
  const finding = (over: Partial<Finding>): Finding => ({
    id: 'F1', title: 't', description: 'd', severity: 'high', category: 'security', kind: 'problem',
    confidence: 'high', file: 'a.ts', range: { start: 1, end: 1 }, evidence: [], whyItMatters: '',
    consequences: [], recommendation: '', ruleId: 'r', source: 'deterministic', tags: [], ...over,
  });

  it('explains every point it awards', () => {
    const risk = assessRisk({
      findings: [finding({})],
      changes: [makeUntracked('a.ts', 'x\n')],
      tests: { files: [], uncoveredChanges: ['a.ts'], uncoveredSymbols: [], deletedTests: [], suggestions: [] },
      affectedComponents: 3,
      documentationFindings: 1,
      changedLines: 1,
    });
    expect(risk.factors.length).toBeGreaterThan(0);
    expect(risk.factors.reduce((n, f) => n + f.points, 0)).toBe(risk.score);
    expect(risk.method).toMatch(/not a probability/i);
  });

  it('scores an empty, small change as low', () => {
    const risk = assessRisk({
      findings: [], changes: [makeUntracked('a.md', 'doc\n')], tests: { files: [], uncoveredChanges: [], uncoveredSymbols: [], deletedTests: [], suggestions: [] },
      affectedComponents: 0, documentationFindings: 0, changedLines: 1,
    });
    expect(risk.level).toBe('low');
    expect(risk.score).toBe(0);
  });
});

describe('documentation rename detection', () => {
  it('suggests the new name when a documented symbol was renamed', () => {
    const removed: ChangedSymbol = {
      id: 's1', name: 'settleBatch', kind: 'method', file: 'src/s.ts', range: { start: 5, end: 9 },
      container: 'SettlementService', exported: true, change: 'removed', changeRanges: [{ start: 5, end: 9 }],
      signature: 'async settleBatch(batchId: string): Promise<Result>', signatureChanged: false, referenceCount: 0,
    };
    const added: ChangedSymbol = { ...removed, id: 's2', name: 'settleBatchAtomic', change: 'added', range: { start: 5, end: 12 }, signature: 'async settleBatchAtomic(batchId: string): Promise<Result>' };
    const docs = loadDocuments(new Map([['docs/s.md', 'Use `SettlementService.settleBatch(id)`.\n']]));
    const findings = analyseDocumentation({
      docs: docs.docs, docTexts: docs.texts,
      repoFiles: new Map([['docs/s.md', 'Use `SettlementService.settleBatch(id)`.\n'], ['src/s.ts', 'export class SettlementService {}']]),
      changes: [], symbols: [removed, added],
    });
    const rename = findings.find((f) => f.status === 'outdated');
    expect(rename).toBeDefined();
    expect(rename!.patch?.diff).toContain('settleBatchAtomic');
  });
});
