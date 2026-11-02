import { describe, expect, it } from 'vitest';
import {
  buildDocumentationIndex, documentationIndexSummary, retrieveDocumentation, splitSections,
  updateDocumentationIndex,
} from '@diffwise/core';

const files = new Map([
  ['README.md', '# Payments\n\nThe service calls `refundService.refund` and exposes `POST /api/refunds`.\n\n## Refunds\n\nA refund must include an idempotency key.\n'],
  ['docs/adr/0007-refunds.md', '# ADR 7 — Refunds\n\nRefunds are async and must be idempotent.\n'],
  ['docs/adr/0007-copy.md', '# ADR 7 — Refunds\n\nRefunds are async and must be idempotent.\n'],
  ['docs/architecture.md', '# Architecture\n\n## Billing\n\nBilling publishes `billing.refunded` to Kafka.\n'],
  ['src/payments/refund.ts', 'export function refund() {}\n'],
]);

describe('documentation index', () => {
  it('splits sections with line ranges and extracts references', () => {
    const sections = splitSections('README.md', files.get('README.md') as string, 'readme');
    expect(sections.length).toBeGreaterThanOrEqual(2);
    expect(sections[0]?.heading).toBe('Payments');
    expect(sections[0]?.startLine).toBe(1);
    expect(sections.some((section) => section.references.includes('POST /api/refunds'))).toBe(true);
  });

  it('indexes documents, hashes content and detects duplicates', () => {
    const index = buildDocumentationIndex({ files });
    expect(index.entries.map((entry) => entry.path)).not.toContain('src/payments/refund.ts');
    expect(index.entries.find((entry) => entry.path === 'README.md')?.category).toBe('readme');
    expect(index.entries.find((entry) => entry.path === 'docs/adr/0007-copy.md')?.duplicateOf
      ?? index.entries.find((entry) => entry.path === 'docs/adr/0007-refunds.md')?.duplicateOf).toBeDefined();
    expect(documentationIndexSummary(index).duplicates).toBe(1);
    expect(index.stats.sections).toBeGreaterThan(2);
  });

  it('retrieves only relevant, bounded sections with attribution', () => {
    const index = buildDocumentationIndex({ files });
    const retrieved = retrieveDocumentation(index, {
      files: ['src/payments/refund.ts'],
      symbols: ['refund'],
      terms: ['payments', 'refund'],
      maxSections: 2,
      maxChars: 800,
    });
    expect(retrieved.sections.length).toBeGreaterThan(0);
    expect(retrieved.sections.length).toBeLessThanOrEqual(2);
    expect(retrieved.sections[0]?.document).toMatch(/README|adr/);
    expect(retrieved.sections.every((section) => section.why.length > 0)).toBe(true);
    expect(retrieved.sections.reduce((n, section) => n + section.text.length, 0)).toBeLessThanOrEqual(800);
  });

  it('reuses unchanged sections on an incremental update', () => {
    const first = buildDocumentationIndex({ files });
    const changed = new Map(files);
    changed.set('README.md', `${files.get('README.md')}\n\n## New section\n\nAdded later.\n`);
    const second = updateDocumentationIndex(first, { files: changed });
    expect(second.stats.changed).toBe(1);
    expect(second.stats.reused).toBeGreaterThanOrEqual(2);
    expect(second.entries.find((entry) => entry.path === 'README.md')?.sections.some((section) => section.heading === 'New section')).toBe(true);
  });

  it('honours configured sources as a scope', () => {
    const index = buildDocumentationIndex({
      files,
      sources: [{ path: 'docs/**', category: 'technical', priority: 5 }],
    });
    expect(index.entries.every((entry) => entry.path.startsWith('docs/'))).toBe(true);
    expect(index.entries.find((entry) => entry.path === 'docs/architecture.md')?.category).toBe('technical');
    expect(index.entries.find((entry) => entry.path === 'docs/architecture.md')?.priority).toBe(5);
  });
});
