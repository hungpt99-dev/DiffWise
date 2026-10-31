import type { DiffLine, FileChange, Hunk } from '../types';
import { detectLanguage } from '../analysis/languages';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Undo git's C-style quoting for paths with special characters. */
export function unquoteGitPath(raw: string): string {
  const p = raw.trim();
  if (!p.startsWith('"')) return p;
  const body = p.slice(1, p.endsWith('"') ? -1 : undefined);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const n = body[i + 1];
    if (n === undefined) break;
    if (n === 'n') { bytes.push(10); i++; }
    else if (n === 't') { bytes.push(9); i++; }
    else if (n === 'r') { bytes.push(13); i++; }
    else if (n === '"' || n === '\\') { bytes.push(n.charCodeAt(0)); i++; }
    else if (/[0-7]/.test(n)) {
      const oct = body.slice(i + 1, i + 4);
      bytes.push(parseInt(oct, 8));
      i += 3;
    } else { bytes.push(...Buffer.from(n, 'utf8')); i++; }
  }
  return Buffer.from(bytes).toString('utf8');
}

function stripPrefix(p: string): string {
  const path = unquoteGitPath(p);
  if (path === '/dev/null') return path;
  return path.replace(/^[ab]\//, '');
}

export interface RawFileDiff {
  path: string;
  oldPath?: string;
  status: FileChange['status'];
  binary: boolean;
  hunks: Hunk[];
  patch: string;
  additions: number;
  deletions: number;
}

/**
 * Parse `git diff` output into per-file structures.
 *
 * Handles additions, deletions, renames, mode changes, binary files and quoted
 * paths. It intentionally ignores mode-only changes (they carry no analysable
 * content) but keeps them in the patch text.
 */
export function parseUnifiedDiff(patch: string): RawFileDiff[] {
  const lines = patch.split(/\r?\n/);
  const out: RawFileDiff[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.startsWith('diff --git ')) { i++; continue; }

    const start = i;
    let status: FileChange['status'] = 'modified';
    let binary = false;
    let oldPathFromHeader: string | undefined;
    let newPathFromHeader: string | undefined;
    const headerMatch = /^diff --git (.+) (.+)$/.exec(line);
    if (headerMatch) {
      oldPathFromHeader = stripPrefix(headerMatch[1]!);
      newPathFromHeader = stripPrefix(headerMatch[2]!);
    }

    i++;
    let minusPath: string | undefined;
    let plusPath: string | undefined;
    const hunks: Hunk[] = [];
    let renameFrom: string | undefined;
    let renameTo: string | undefined;

    // Header section (mode/new file/deleted/rename/index/---/+++).
    while (i < lines.length && !lines[i]!.startsWith('@@')) {
      const l = lines[i]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('new file mode')) status = 'added';
      else if (l.startsWith('deleted file mode')) status = 'deleted';
      else if (l.startsWith('rename from ')) { renameFrom = unquoteGitPath(l.slice('rename from '.length)); status = 'renamed'; }
      else if (l.startsWith('rename to ')) { renameTo = unquoteGitPath(l.slice('rename to '.length)); status = 'renamed'; }
      else if (l.startsWith('Binary files ') || l === 'GIT binary patch') binary = true;
      else if (l.startsWith('--- ')) { const p = stripPrefix(l.slice(4)); minusPath = p === '/dev/null' ? undefined : p; }
      else if (l.startsWith('+++ ')) { const p = stripPrefix(l.slice(4)); plusPath = p === '/dev/null' ? undefined : p; }
      i++;
    }

    // Hunks.
    while (i < lines.length && !lines[i]!.startsWith('diff --git ')) {
      const h = HUNK_RE.exec(lines[i]!);
      if (!h) { i++; continue; }
      const oldStart = Number(h[1]);
      const oldLines = h[2] === undefined ? 1 : Number(h[2]);
      const newStart = Number(h[3]);
      const newLines = h[4] === undefined ? 1 : Number(h[4]);
      const header = lines[i]!;
      i++;
      const hunkLines: DiffLine[] = [];
      let oldLine = oldStart;
      let newLine = newStart;
      while (i < lines.length) {
        const l = lines[i]!;
        if (l.startsWith('@@') || l.startsWith('diff --git ')) break;
        if (l.startsWith('\\')) { i++; continue; } // "\ No newline at end of file"
        const marker = l[0];
        if (marker === '+') {
          hunkLines.push({ kind: 'add', text: l.slice(1), newLine });
          newLine++; i++;
        } else if (marker === '-') {
          hunkLines.push({ kind: 'del', text: l.slice(1), oldLine });
          oldLine++; i++;
        } else if (marker === ' ' || l === '') {
          hunkLines.push({ kind: 'context', text: l.slice(1), oldLine, newLine });
          oldLine++; newLine++; i++;
        } else {
          break;
        }
      }
      hunks.push({ oldStart, oldLines, newStart, newLines, header, lines: hunkLines });
    }

    const path = plusPath ?? newPathFromHeader ?? oldPathFromHeader ?? renameTo ?? '';
    if (!path) continue;
    const oldPath = status === 'renamed'
      ? (minusPath ?? renameFrom ?? oldPathFromHeader)
      : (oldPathFromHeader !== path ? oldPathFromHeader : undefined);

    let additions = 0;
    let deletions = 0;
    for (const h of hunks) {
      for (const dl of h.lines) {
        if (dl.kind === 'add') additions++;
        else if (dl.kind === 'del') deletions++;
      }
    }

    out.push({
      path,
      ...(oldPath && oldPath !== path ? { oldPath } : {}),
      status,
      binary,
      hunks,
      patch: lines.slice(start, i).join('\n'),
      additions,
      deletions,
    });
  }
  return out;
}

/** Map added/removed line numbers per file, in new-file coordinates. */
export function changedLineNumbers(change: FileChange): { added: number[]; removed: number[] } {
  const added: number[] = [];
  const removed: number[] = [];
  for (const h of change.hunks) {
    for (const l of h.lines) {
      if (l.kind === 'add' && l.newLine !== undefined) added.push(l.newLine);
      if (l.kind === 'del' && l.oldLine !== undefined) removed.push(l.oldLine);
    }
  }
  return { added, removed };
}

export function isLineChanged(change: FileChange, line: number): boolean {
  return change.hunks.some((h) =>
    h.lines.some((l) => l.kind === 'add' && l.newLine === line),
  );
}

export function makeUntracked(path: string, content: string): FileChange {
  const lines = content.split(/\r?\n/);
  const dl: DiffLine[] = lines.map((text, idx) => ({ kind: 'add', text, newLine: idx + 1 }));
  const hunk: Hunk = {
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: lines.length,
    header: `@@ -0,0 +1,${lines.length} @@`,
    lines: dl,
  };
  return {
    path,
    status: 'added',
    additions: lines.length,
    deletions: 0,
    binary: false,
    hunks: [hunk],
    patch: `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n${hunk.header}\n${lines.map((l) => `+${l}`).join('\n')}`,
    language: detectLanguage(path),
    untracked: true,
  };
}
