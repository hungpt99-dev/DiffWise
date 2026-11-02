import { describe, expect, it } from 'vitest';
import { analyseImpact } from '@diffwise/core';
import type { FileChange, GraphAnalysis, ImpactInput } from '@diffwise/core';

function change(path: string, oldText: string, newText: string, language: FileChange['language'] = 'typescript'): FileChange {
  const oldLines = oldText ? oldText.split('\n') : [];
  const newLines = newText ? newText.split('\n') : [];
  return {
    path,
    status: oldText ? 'modified' : 'added',
    additions: newLines.length,
    deletions: oldLines.length,
    binary: false,
    patch: '',
    language,
    hunks: [{
      oldStart: 1, oldLines: oldLines.length, newStart: 1, newLines: newLines.length, header: '@@ -1 +1 @@',
      lines: [
        ...oldLines.map((text, index) => ({ kind: 'del' as const, text, oldLine: index + 1 })),
        ...newLines.map((text, index) => ({ kind: 'add' as const, text, newLine: index + 1 })),
      ],
    }],
  };
}

const emptyGraph: GraphAnalysis = {
  edges: [],
  importers: {},
  changedFiles: ['src/api/routes.ts'],
  directlyImpacted: ['src/api/client.ts'],
  indirectlyImpacted: ['src/app/worker.ts'],
  impactDepth: { 'src/api/client.ts': 1, 'src/app/worker.ts': 2 },
  cycles: [],
  newCoupling: [],
  removedCoupling: [],
  boundaryChanges: [],
  modules: [],
  fileCount: 10,
  edgeCount: 2,
};

function input(overrides: Partial<ImpactInput> = {}): ImpactInput {
  const oldRoutes = "router.post('/api/refunds', refundHandler);\nrouter.get('/api/health', health);\n";
  const newRoutes = "router.get('/api/health', health);\n";
  const migrationOld = 'CREATE TABLE payments (id text);\n';
  const migrationNew = `${migrationOld}ALTER TABLE payments DROP COLUMN legacy_id;\n`;
  const changes = [
    change('src/api/routes.ts', oldRoutes, newRoutes),
    change('db/migrations/0012_drop_legacy.sql', migrationOld, migrationNew, 'sql'),
    change('src/payments/charge.ts', 'const url = "x";\n', 'const url = process.env.PAYMENT_URL;\nproducer.send("billing.charged", payload);\n'),
    change('services/billing/config.yaml', 'a: 1\n', 'a: 2\n', 'yaml'),
  ];
  return {
    changes,
    contents: new Map(changes.map((entry) => [entry.path, entry.hunks[0]!.lines.filter((line) => line.kind === 'add').map((line) => line.text).join('\n')])),
    oldContents: new Map(changes.map((entry) => [entry.path, entry.hunks[0]!.lines.filter((line) => line.kind === 'del').map((line) => line.text).join('\n')])),
    repoFiles: new Map([
      ...changes.map((entry) => [entry.path, ''] as const),
      ['src/api/client.ts', 'import "../payments/charge";\n'],
      ['src/db/payments.ts', 'SELECT * FROM payments;\n'],
    ]),
    symbols: [{
      id: 'sym1', name: 'refund', kind: 'function', file: 'src/payments/charge.ts', range: { start: 1, end: 4 },
      exported: true, change: 'modified', changeRanges: [{ start: 2, end: 3 }], signature: 'export function refund(id: string)',
      signatureChanged: true, referenceCount: 2, referenceExamples: ['src/api/client.ts'],
    }],
    graph: emptyGraph,
    tests: {
      files: [{ path: 'src/payments/charge.test.ts', framework: 'vitest', targets: ['src/payments/charge.ts'], symbols: ['refund'], testCount: 2 }],
      uncoveredChanges: ['src/api/routes.ts'],
      uncoveredSymbols: [],
      deletedTests: [],
      suggestions: [],
    },
    docs: [{ path: 'README.md', kind: 'readme', references: [{ value: 'refund', kind: 'symbol', line: 4 }] }],
    docTexts: new Map([['README.md', '# Refunds\n\n`refund` is async.\n']]),
    retrieval: {
      generatedAt: new Date().toISOString(),
      query: { files: ['src/payments/charge.ts'], symbols: ['refund'], terms: ['payments'] },
      sections: [{ document: 'README.md', heading: 'Refunds', startLine: 1, endLine: 3, category: 'readme', text: '`refund` is async.', score: 10, why: 'heading names refund', truncated: false }],
      consideredSections: 1,
      skipped: [],
      truncated: false,
      durationMs: 1,
    },
    ...overrides,
  };
}

describe('impact analysis', () => {
  it('reports code, API, database, event, configuration, testing and documentation dimensions', () => {
    const impact = analyseImpact(input());
    expect(impact.dimensions.code.items).toBeGreaterThan(0);
    expect(impact.dimensions.api.items).toBeGreaterThan(0);
    expect(impact.dimensions.database.items).toBeGreaterThan(0);
    expect(impact.dimensions.event.items).toBeGreaterThan(0);
    expect(impact.dimensions.configuration.items).toBeGreaterThan(0);
    expect(impact.dimensions.testing.items).toBeGreaterThan(0);
    expect(impact.dimensions.documentation.items).toBeGreaterThan(0);
    expect(impact.coverage.note.length).toBeGreaterThan(20);
  });

  it('distinguishes a removed endpoint from an added one and marks it breaking', () => {
    const impact = analyseImpact(input());
    const removed = impact.items.find((item) => item.label.includes('Endpoint removed: POST /api/refunds'));
    expect(removed?.relation).toBe('BREAKS');
    expect(removed?.provenance).toBe('static');
    expect(impact.breaking.api).toBeGreaterThanOrEqual(1);
  });

  it('flags a destructive migration without a rollback path', () => {
    const impact = analyseImpact(input());
    expect(impact.breaking.database).toBe(1);
    expect(impact.items.some((item) => item.dimension === 'database' && item.detail.includes('No rollback'))).toBe(true);
  });

  it('records event and environment relationships with static provenance', () => {
    const impact = analyseImpact(input());
    expect(impact.items.some((item) => item.dimension === 'event' && item.relation === 'PRODUCES')).toBe(true);
    const env = impact.items.find((item) => item.dimension === 'configuration' && item.label.includes('PAYMENT_URL'));
    expect(env?.provenance).toBe('static');
  });

  it('never claims complete coverage for a non-TypeScript change', () => {
    const impact = analyseImpact(input({ changes: [change('src/main/java/A.java', 'class A {}', 'class A { void x() {} }', 'java')] }));
    expect(impact.coverage.note).toContain('does not claim complete impact coverage');
  });
});
