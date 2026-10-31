import { describe, expect, it } from 'vitest';
import { makeUntracked, parseUnifiedDiff, changedLineNumbers } from '../src/git/diff';

const patch = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 export const a = 1;
-export const b = 2;
+export const b = 3;
+export const c = 4;
 export const d = 5;
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const n = 1;
+export const m = 2;
diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-export const gone = true;
diff --git a/src/from.ts b/src/to.ts
similarity index 90%
rename from src/from.ts
rename to src/to.ts
`;

describe('parseUnifiedDiff', () => {
  it('parses modified, added, deleted and renamed files', () => {
    const files = parseUnifiedDiff(patch);
    expect(files.map((f) => f.path)).toEqual(['src/a.ts', 'src/new.ts', 'src/old.ts', 'src/to.ts']);
    expect(files[0]!.status).toBe('modified');
    expect(files[1]!.status).toBe('added');
    expect(files[2]!.status).toBe('deleted');
    expect(files[3]!.status).toBe('renamed');
    expect(files[3]!.oldPath).toBe('src/from.ts');
  });

  it('tracks added and removed counts and line numbers', () => {
    const [file] = parseUnifiedDiff(patch);
    expect(file!.additions).toBe(2);
    expect(file!.deletions).toBe(1);
    const lines = changedLineNumbers({ ...file!, language: 'typescript' } as never);
    expect(lines.added).toEqual([2, 3]);
    expect(lines.removed).toEqual([2]);
  });

  it('keeps the removed line number for deletions so evidence points at the old revision', () => {
    const [file] = parseUnifiedDiff(patch);
    const del = file!.hunks[0]!.lines.find((l) => l.kind === 'del');
    expect(del).toMatchObject({ text: 'export const b = 2;', oldLine: 2 });
  });

  it('handles quoted paths with escapes', () => {
    const quoted = `diff --git "a/dir/with space/\\303\\251.ts" "b/dir/with space/\\303\\251.ts"
--- "a/dir/with space/\\303\\251.ts"
+++ "b/dir/with space/\\303\\251.ts"
@@ -1 +1 @@
-a
+b
`;
    const [file] = parseUnifiedDiff(quoted);
    expect(file!.path).toBe('dir/with space/é.ts');
  });

  it('marks binary diffs', () => {
    const binary = `diff --git a/img.png b/img.png
index 1..2 100644
Binary files a/img.png and b/img.png differ
`;
    expect(parseUnifiedDiff(binary)[0]!.binary).toBe(true);
  });
});

describe('makeUntracked', () => {
  it('produces an all-added diff for a new file', () => {
    const change = makeUntracked('src/new.ts', 'a\nb\n');
    expect(change.status).toBe('added');
    expect(change.untracked).toBe(true);
    expect(change.additions).toBe(3);
    expect(change.patch).toContain('+a');
  });
});
