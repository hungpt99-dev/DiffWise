import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyFix, listJournals, previewFix, rollbackFix } from '../src/fix';
import { cleanup, makeSmallRepo } from './helpers';

const PATCH = `diff --git a/src/math.ts b/src/math.ts
--- a/src/math.ts
+++ b/src/math.ts
@@ -1,3 +1,7 @@
 export function add(a: number, b: number): number {
   return a + b;
 }
+
+export function subtract(a: number, b: number): number {
+  return a - b;
+}
`;

describe('safe patch application', () => {
  let root: string;
  const backupDir = (): string => join(root, '.diffwise', 'backups');
  let original: string;

  beforeAll(async () => {
    root = await makeSmallRepo();
    original = await readFile(join(root, 'src/math.ts'), 'utf8');
  });

  afterAll(async () => {
    if (root) await cleanup(root);
  });

  it('previews without touching the working tree and pins file hashes', async () => {
    const preview = await previewFix(root, PATCH);
    expect(preview.applies).toBe(true);
    expect(preview.files).toEqual(['src/math.ts']);
    expect(preview.hashes['src/math.ts']).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(join(root, 'src/math.ts'), 'utf8')).toBe(original);
  });

  it('refuses to apply without explicit approval', async () => {
    const result = await applyFix({
      root, diff: PATCH, backupDir: backupDir(), approved: false,
      findingId: 'DW-test', solutionId: 'fix-test', reviewId: 'review-test',
    });
    expect(result.applied).toBe(false);
    expect(result.errors.join(' ')).toMatch(/explicit developer approval/);
    expect(await readFile(join(root, 'src/math.ts'), 'utf8')).toBe(original);
  });

  it('applies atomically, writes a journal and leaves a suffixed backup', async () => {
    const preview = await previewFix(root, PATCH);
    const result = await applyFix({
      root, diff: PATCH, backupDir: backupDir(), approved: true,
      expectedHashes: preview.hashes,
      findingId: 'DW-test', solutionId: 'fix-test', reviewId: 'review-test',
    });
    expect(result.applied).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.journalPath).toBeTruthy();
    const updated = await readFile(join(root, 'src/math.ts'), 'utf8');
    expect(updated).toContain('export function subtract');
    await expect(access(result.journalPath as string)).resolves.toBeUndefined();
    const journal = JSON.parse(await readFile(result.journalPath as string, 'utf8')) as {
      status: string; entries: Array<{ path: string; backupPath: string; beforeHash: string; afterHash: string }>;
    };
    expect(journal.status).toBe('applied');
    expect(journal.entries[0]?.path).toBe('src/math.ts');
    expect(journal.entries[0]?.backupPath?.endsWith('.bak')).toBe(true);
    expect(journal.entries[0]?.beforeHash).not.toBe(journal.entries[0]?.afterHash);
  });

  it('detects that the file changed after the preview (stale patch)', async () => {
    const preview = await previewFix(root, PATCH.replace('a - b', 'a - b /* v2 */'));
    await writeFile(join(root, 'src/math.ts'), `${await readFile(join(root, 'src/math.ts'), 'utf8')}\n// developer edit\n`, 'utf8');
    const result = await applyFix({
      root, diff: PATCH.replace('a - b', 'a - b /* v2 */'), backupDir: backupDir(), approved: true,
      expectedHashes: preview.hashes,
      findingId: 'DW-test', solutionId: 'fix-test', reviewId: 'review-test',
    });
    expect(result.applied).toBe(false);
    expect(result.errors.join(' ')).toMatch(/changed since this patch was previewed/);
  });

  it('refuses a patch that does not apply rather than guessing', async () => {
    const bogus = PATCH.replace('return a + b;', 'return a * b;');
    const preview = await previewFix(root, bogus);
    expect(preview.applies).toBe(false);
    expect(preview.reason).toBeTruthy();
  });

  it('refuses paths outside the repository', async () => {
    const escape = PATCH.replace(/src\/math\.ts/g, '../escape.ts');
    const result = await applyFix({
      root, diff: escape, backupDir: backupDir(), approved: true,
      findingId: 'DW-test', solutionId: 'fix-test', reviewId: 'review-test',
    });
    expect(result.applied).toBe(false);
    expect(result.errors.join(' ')).toMatch(/outside the repository/);
  });

  it('rolls back from the journal', async () => {
    const journals = await listJournals(root);
    expect(journals.length).toBeGreaterThan(0);
    const applied = journals.find((j) => j.status === 'applied');
    expect(applied).toBeTruthy();
    const result = await rollbackFix(root, join(root, '.diffwise', 'transactions', `${applied!.id}.json`));
    expect(result.errors).toEqual([]);
    expect(result.reverted).toContain('src/math.ts');
    const journal = JSON.parse(await readFile(join(root, '.diffwise', 'transactions', `${applied!.id}.json`), 'utf8')) as { status: string };
    expect(journal.status).toBe('rolled-back');
  });
});
