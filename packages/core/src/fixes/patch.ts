import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Hunk } from '../types';

export interface PatchFile {
  path: string;
  oldPath?: string;
  isNew: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

export class PatchError extends Error {
  constructor(message: string, readonly path?: string) {
    super(message);
    this.name = 'PatchError';
  }
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse a unified diff (git-style headers optional). */
export function parsePatch(diff: string): PatchFile[] {
  const lines = diff.replace(/\r\n/g, '\n').split('\n');
  const files: PatchFile[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!/^---\s+/.test(line)) { i++; continue; }
    const minus = line.slice(4).trim().replace(/^a\//, '');
    const plusLine = lines[i + 1] ?? '';
    if (!/^\+\+\+\s+/.test(plusLine)) throw new PatchError('Malformed patch: --- without +++', minus);
    const plus = plusLine.slice(4).trim().replace(/^b\//, '');
    const isNew = minus === '/dev/null';
    const isDelete = plus === '/dev/null';
    const path = isDelete ? minus : plus;
    i += 2;
    const hunks: Hunk[] = [];
    while (i < lines.length && lines[i]!.startsWith('@@')) {
      const h = HUNK_RE.exec(lines[i]!);
      if (!h) throw new PatchError(`Malformed hunk header: ${lines[i]}`, path);
      const oldStart = Number(h[1]);
      const oldLines = h[2] === undefined ? 1 : Number(h[2]);
      const newStart = Number(h[3]);
      const newLines = h[4] === undefined ? 1 : Number(h[4]);
      const header = lines[i]!;
      i++;
      const hunkLines: Hunk['lines'] = [];
      let oldLine = oldStart;
      let newLine = newStart;
      while (i < lines.length && !lines[i]!.startsWith('@@') && !lines[i]!.startsWith('--- ')) {
        const l = lines[i]!;
        if (l === '' && i === lines.length - 1) { i++; continue; }
        const marker = l[0];
        if (marker === ' ') { hunkLines.push({ kind: 'context', text: l.slice(1), oldLine, newLine }); oldLine++; newLine++; }
        else if (marker === '-') { hunkLines.push({ kind: 'del', text: l.slice(1), oldLine }); oldLine++; }
        else if (marker === '+') { hunkLines.push({ kind: 'add', text: l.slice(1), newLine }); newLine++; }
        else if (marker === '\\') { /* no-newline marker */ }
        else break;
        i++;
      }
      hunks.push({ oldStart, oldLines, newStart, newLines, header, lines: hunkLines });
    }
    files.push({ path, oldPath: isNew ? undefined : minus, isNew, isDelete, hunks });
  }
  if (files.length === 0) throw new PatchError('Patch contains no file sections.');
  return files;
}

export interface FileState {
  exists: boolean;
  content: string;
}

/**
 * Apply a patch to in-memory contents, strictly.
 *
 * Context must match exactly; when the declared line number is stale (the file
 * moved), the applier searches nearby for the same context. It never guesses at
 * fuzzy content: a missing context is a validation error, which is what the UI
 * reports before anything is written.
 */
export function applyPatchToContents(
  patch: PatchFile[],
  read: (path: string) => FileState,
): { result: Map<string, string>; fuzz: number } {
  const result = new Map<string, string>();
  let fuzz = 0;

  for (const file of patch) {
    const state = result.has(file.path) ? { exists: true, content: result.get(file.path)! } : read(file.path);
    if (file.isDelete) {
      if (!state.exists) throw new PatchError(`Cannot delete ${file.path}: file does not exist.`, file.path);
      result.set(file.path, '');
      continue;
    }
    if (!state.exists && !file.isNew) {
      throw new PatchError(`Cannot patch ${file.path}: file does not exist.`, file.path);
    }
    const original = state.exists ? state.content.replace(/\r\n/g, '\n') : '';
    const originalLines = original.split('\n');
    const hadTrailingNewline = original.endsWith('\n');
    const outLines = [...originalLines];

    // Apply hunks from the bottom so earlier line numbers stay valid.
    const ordered = [...file.hunks].sort((a, b) => b.newStart - a.newStart);
    for (const hunk of ordered) {
      const contextAndDel = hunk.lines.filter((l) => l.kind !== 'add').map((l) => l.text);
      const insert = hunk.lines.filter((l) => l.kind === 'add').map((l) => l.text);
      const deletionCount = hunk.lines.filter((l) => l.kind === 'del').length;
      if (contextAndDel.length === 0) {
        // Pure insertion at a line.
        const at = Math.min(outLines.length, Math.max(0, hunk.newStart - 1));
        outLines.splice(at, 0, ...insert);
        continue;
      }
      const expectedIndex = hunk.oldStart - 1;
      let found = -1;
      if (matchesAt(outLines, contextAndDel, expectedIndex)) found = expectedIndex;
      if (found < 0) {
        const window = 40;
        for (let delta = 1; delta <= window && found < 0; delta++) {
          for (const candidate of [expectedIndex - delta, expectedIndex + delta]) {
            if (candidate >= 0 && matchesAt(outLines, contextAndDel, candidate)) { found = candidate; fuzz = Math.max(fuzz, delta); break; }
          }
        }
      }
      if (found < 0) {
        const preview = contextAndDel.slice(0, 3).join('\n');
        throw new PatchError(`Context not found in ${file.path} near line ${hunk.oldStart}. First context line(s):\n${preview}`, file.path);
      }
      // Replace the matched old region with the new region for this hunk.
      const replacement: string[] = [];
      let cursor = found;
      for (const l of hunk.lines) {
        if (l.kind === 'context') { replacement.push(outLines[cursor] ?? l.text); cursor++; }
        else if (l.kind === 'del') { cursor++; }
        else if (l.kind === 'add') { replacement.push(l.text); }
      }
      if (cursor - found !== contextAndDel.length) {
        throw new PatchError(`Hunk length mismatch in ${file.path} near line ${hunk.oldStart}.`, file.path);
      }
      outLines.splice(found, contextAndDel.length, ...replacement);
      void deletionCount;
    }

    let next = outLines.join('\n');
    if (hadTrailingNewline && !next.endsWith('\n')) next += '\n';
    if (file.isNew && next.startsWith('\n')) next = next.slice(1);
    result.set(file.path, next);
  }
  return { result, fuzz };
}

function matchesAt(lines: string[], context: string[], index: number): boolean {
  if (index < 0 || index + context.length > lines.length) return false;
  for (let k = 0; k < context.length; k++) {
    if ((lines[index + k] ?? '') !== context[k]) return false;
  }
  return true;
}

export interface ApplyResult {
  applied: boolean;
  files: string[];
  backupDir: string;
  fuzz: number;
  errors: string[];
}

/** Validate a patch against the working tree without writing anything. */
export async function validatePatch(root: string, diff: string): Promise<{ applies: boolean; reason?: string; files: string[]; fuzz?: number }> {
  try {
    const patch = parsePatch(diff);
    for (const f of patch) {
      if (!isSafeRelativePath(f.path)) return { applies: false, reason: `Refusing path outside the repository: ${f.path}`, files: [] };
    }
    const { fuzz } = applyPatchToContents(patch, (path) => readState(root, path));
    return { applies: true, files: patch.map((p) => p.path), fuzz };
  } catch (err) {
    return { applies: false, reason: (err as Error).message, files: [] };
  }
}

function readState(root: string, path: string): FileState {
  try {
    const content = require('node:fs').readFileSync(join(root, path), 'utf8') as string;
    return { exists: true, content };
  } catch {
    return { exists: false, content: '' };
  }
}

export function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('..') || /^[a-zA-Z]:/.test(path)) return false;
  return !path.split('/').includes('node_modules');
}

/**
 * Apply a patch to disk after validating every file. Backups are written before
 * the first mutation, so a failed write can be reverted with `revertPatch`.
 */
export async function applyPatch(root: string, diff: string, opts: { backupDir: string; allowDelete?: boolean }): Promise<ApplyResult> {
  const backupDir = opts.backupDir;
  const errors: string[] = [];
  let patch: PatchFile[];
  try {
    patch = parsePatch(diff);
  } catch (err) {
    return { applied: false, files: [], backupDir, fuzz: 0, errors: [(err as Error).message] };
  }
  for (const f of patch) {
    if (!isSafeRelativePath(f.path)) errors.push(`Refusing path outside the repository: ${f.path}`);
    if (f.isDelete && !opts.allowDelete) errors.push(`Deletion of ${f.path} requires explicit allowDelete.`);
  }
  if (errors.length) return { applied: false, files: [], backupDir, fuzz: 0, errors };

  let computed: Map<string, string>;
  let fuzz = 0;
  try {
    const applied = applyPatchToContents(patch, (p) => readState(root, p));
    computed = applied.result;
    fuzz = applied.fuzz;
  } catch (err) {
    return { applied: false, files: [], backupDir, fuzz: 0, errors: [(err as Error).message] };
  }

  await mkdir(backupDir, { recursive: true });
  const written: string[] = [];
  for (const f of patch) {
    const abs = join(root, f.path);
    const backupPath = join(backupDir, f.path);
    const state = readState(root, f.path);
    if (state.exists) {
      await mkdir(dirname(backupPath), { recursive: true });
      await copyFile(abs, backupPath);
    }
    if (f.isDelete) {
      const { unlink } = await import('node:fs/promises');
      await unlink(abs).catch(() => undefined);
      written.push(f.path);
      continue;
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, computed.get(f.path) ?? '', 'utf8');
    written.push(f.path);
  }
  return { applied: true, files: written, backupDir, fuzz, errors: [] };
}

/** Restore files from a backup directory created by `applyPatch`. */
export async function revertPatch(root: string, backupDir: string, files: string[]): Promise<{ reverted: string[]; errors: string[] }> {
  const reverted: string[] = [];
  const errors: string[] = [];
  for (const file of files) {
    if (!isSafeRelativePath(file)) { errors.push(`Unsafe path: ${file}`); continue; }
    try {
      const content = await readFile(join(backupDir, file), 'utf8');
      await writeFile(resolve(root, file), content, 'utf8');
      reverted.push(file);
    } catch (err) {
      errors.push(`${file}: ${(err as Error).message}`);
    }
  }
  return { reverted, errors };
}
