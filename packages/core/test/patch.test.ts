import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyPatch, applyPatchToContents, isSafeRelativePath, parsePatch, revertPatch, validatePatch,
} from '../src/fixes/patch';

const modify = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 line one
-line two
+line two changed
 line three
`;

describe('patch parsing', () => {
  it('rejects a diff without file sections', () => {
    expect(() => parsePatch('not a patch')).toThrow(/no file sections/i);
  });

  it('rejects paths outside the repository', () => {
    expect(isSafeRelativePath('../etc/passwd')).toBe(false);
    expect(isSafeRelativePath('/etc/passwd')).toBe(false);
    expect(isSafeRelativePath('src/a.ts')).toBe(true);
  });
});

describe('applyPatchToContents', () => {
  it('applies a modification', () => {
    const { result } = applyPatchToContents(parsePatch(modify), () => ({ exists: true, content: 'line one\nline two\nline three\n' }));
    expect(result.get('src/a.ts')).toBe('line one\nline two changed\nline three\n');
  });

  it('applies a pure insertion', () => {
    const diff = `--- a/f.txt
+++ b/f.txt
@@ -1,1 +1,2 @@
 first
+second
`;
    const { result } = applyPatchToContents(parsePatch(diff), () => ({ exists: true, content: 'first\n' }));
    expect(result.get('f.txt')).toBe('first\nsecond\n');
  });

  it('applies multiple hunks without corrupting earlier offsets', () => {
    const diff = `--- a/f.ts
+++ b/f.ts
@@ -1,2 +1,2 @@
-a
+A
 b
@@ -5,2 +5,2 @@
-e
+E
 f
`;
    const content = 'a\nb\nc\nd\ne\nf\n';
    const { result } = applyPatchToContents(parsePatch(diff), () => ({ exists: true, content }));
    expect(result.get('f.ts')).toBe('A\nb\nc\nd\nE\nf\n');
  });

  it('refuses when the context does not match', () => {
    expect(() => applyPatchToContents(parsePatch(modify), () => ({ exists: true, content: 'completely\ndifferent\ncontent\n' })))
      .toThrow(/context not found/i);
  });

  it('finds the hunk when the declared line number is stale', () => {
    const content = `header\nheader2\nline one\nline two\nline three\n`;
    const { result, fuzz } = applyPatchToContents(parsePatch(modify), () => ({ exists: true, content }));
    expect(result.get('src/a.ts')).toContain('line two changed');
    expect(fuzz).toBeGreaterThan(0);
  });
});

describe('applyPatch on disk', () => {
  it('validates before writing and can be reverted from its backup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'diffwise-patch-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/a.ts'), 'line one\nline two\nline three\n', 'utf8');
    const diff = modify.replace(/^diff --git.*$/m, '');

    const validation = await validatePatch(root, diff);
    expect(validation.applies).toBe(true);

    const result = await applyPatch(root, diff, { backupDir: join(root, '.diffwise/backups/fix-1') });
    expect(result.applied).toBe(true);
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toContain('line two changed');

    const reverted = await revertPatch(root, result.backupDir, result.files);
    expect(reverted.errors).toEqual([]);
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('line one\nline two\nline three\n');
  });

  it('does not write anything when the patch does not apply', async () => {
    const root = await mkdtemp(join(tmpdir(), 'diffwise-patch-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/a.ts'), 'unrelated\n', 'utf8');
    const result = await applyPatch(root, modify, { backupDir: join(root, 'backup') });
    expect(result.applied).toBe(false);
    expect(result.errors[0]).toMatch(/context not found/i);
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('unrelated\n');
  });
});
